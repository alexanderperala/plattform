import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { disableAdmin } from '../src/services/admins.js';
import { adminCall, auditRows, createAdmin, loginAdmin, makeApp, PASSWORD, REASON, resetDb } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

const approve = (cookie: string, id: string) => adminCall(app, { method: 'POST', url: `/approvals/${id}/approve`, cookie, payload: {} });
async function request(cookie: string, url: string, payload: object) {
  const r = await adminCall(app, { method: 'POST', url, cookie, payload: { reason: REASON, ...payload } });
  return { status: r.statusCode, body: r.json() };
}
const adminRow = async (id: string) => (await pool.query('select * from platform_admins where id = $1', [id])).rows[0];
const setupToken = async (email: string) => {
  const body = (await pool.query(`select body from notification_outbox where to_email = $1 and template = 'invite' order by created_at desc limit 1`, [email])).rows[0]?.body as string;
  return /token=([\w-]+)/.exec(body)?.[1];
};

describe('adminhantering (endast Platform Owner, four-eyes)', () => {
  it('andra roller än Platform Owner nekas på alla rutter', async () => {
    const sa = await createAdmin('superadmin'); const cookie = await loginAdmin(app, sa);
    const target = await createAdmin('support_admin');
    for (const [m, u] of [['GET', '/admins'], ['POST', '/admins'], ['POST', `/admins/${target.id}/role`], ['POST', `/admins/${target.id}/disable`], ['POST', `/admins/${target.id}/enable`], ['POST', `/admins/${target.id}/reset-mfa`]] as const) {
      const r = await adminCall(app, { method: m, url: u, cookie, payload: { reason: REASON, role: 'readonly_admin', email: 'x@example.test', name: 'X Y' } });
      expect(r.statusCode, `${m} ${u}`).toBe(403);
    }
  });

  it('skapa admin: kräver godkännande, skickar engångslänk, lösenord väljs av kontoinnehavaren', async () => {
    const a = await createAdmin('platform_owner'); const b = await createAdmin('platform_owner');
    const ca = await loginAdmin(app, a); const cb = await loginAdmin(app, b);
    const r = await request(ca, '/admins', { email: 'ny.admin@example.test', name: 'Ny Admin', role: 'support_admin' });
    expect(r.status).toBe(202);
    expect((await pool.query(`select 1 from platform_admins where email = 'ny.admin@example.test'`)).rowCount).toBe(0); // inget skapat före godkännande
    expect((await approve(ca, r.body.approvalId)).statusCode).toBe(403); // egen begäran (två ägare finns)
    expect((await approve(cb, r.body.approvalId)).json().status).toBe('executed');
    const created = (await pool.query(`select * from platform_admins where email = 'ny.admin@example.test'`)).rows[0];
    expect(created.role).toBe('support_admin'); expect(created.created_by).toBe(a.id);
    const token = await setupToken('ny.admin@example.test'); expect(token).toBeTruthy();
    // utan länk går det inte att logga in
    expect((await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: 'ny.admin@example.test', password: PASSWORD } })).statusCode).toBe(401);
    // svagt lösenord, felaktig token, korrekt
    expect((await adminCall(app, { method: 'POST', url: '/auth/setup', payload: { token, password: 'kort' } })).statusCode).toBe(400);
    expect((await adminCall(app, { method: 'POST', url: '/auth/setup', payload: { token: 'x'.repeat(30), password: 'Ett-långt-lösenord-2026' } })).statusCode).toBe(400);
    expect((await adminCall(app, { method: 'POST', url: '/auth/setup', payload: { token, password: 'Ett-långt-lösenord-2026' } })).statusCode).toBe(200);
    expect((await adminCall(app, { method: 'POST', url: '/auth/setup', payload: { token, password: 'Ett-annat-lösenord-2026' } })).statusCode).toBe(400); // engångs
    const login = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: 'ny.admin@example.test', password: 'Ett-långt-lösenord-2026' } });
    expect(login.statusCode).toBe(200); expect(login.json().stage).toBe('mfa_enroll'); // MFA registreras vid första inloggningen
    expect((await auditRows(`action = 'admin.created'`))).toHaveLength(1);
    expect((await auditRows(`action = 'admin.setup_completed'`))).toHaveLength(1);
  });

  it('dubblettbegäran och befintlig e-post stoppas', async () => {
    const a = await createAdmin('platform_owner'); const ca = await loginAdmin(app, a);
    const p = { email: 'dubbel@example.test', name: 'Dubbel', role: 'readonly_admin' };
    expect((await request(ca, '/admins', p)).status).toBe(202);
    expect((await request(ca, '/admins', p)).body.error.code).toBe('ALREADY_PENDING');
    expect((await request(ca, '/admins', { ...p, email: a.email })).status).toBe(400);
  });

  it('rollbyte kräver godkännande, återkallar sessioner och loggas före/efter', async () => {
    const a = await createAdmin('platform_owner'); const b = await createAdmin('platform_owner'); const t = await createAdmin('support_admin');
    const ca = await loginAdmin(app, a); const cb = await loginAdmin(app, b); const ct = await loginAdmin(app, t);
    const r = await request(ca, `/admins/${t.id}/role`, { role: 'billing_admin' });
    expect(r.status).toBe(202); expect((await adminRow(t.id)).role).toBe('support_admin');
    expect((await approve(cb, r.body.approvalId)).json().status).toBe('executed');
    expect((await adminRow(t.id)).role).toBe('billing_admin');
    expect((await adminCall(app, { method: 'GET', url: '/auth/me', cookie: ct })).statusCode).toBe(401);
    const ev = (await auditRows(`action = 'admin.role_changed'`))[0]!;
    expect(ev.before).toEqual({ role: 'support_admin' }); expect(ev.after).toEqual({ role: 'billing_admin' });
  });

  it('ingen kan ändra sin egen roll (begäran misslyckas vid utförande) och sista ägaren skyddas', async () => {
    const a = await createAdmin('platform_owner'); const b = await createAdmin('platform_owner');
    const ca = await loginAdmin(app, a); const cb = await loginAdmin(app, b);
    const self = await request(ca, `/admins/${a.id}/role`, { role: 'superadmin' });
    expect(self.status).toBe(403); expect(self.body.error.code).toBe('SELF_CHANGE_FORBIDDEN'); // stoppas redan vid begäran
    // även om en begäran skulle slinka igenom stoppas den vid utförande (kontrollen gäller den som begärde, inte godkännaren)
    await pool.query(`insert into approval_requests (action, target_type, target_id, params, reason, requested_by, expires_at) values ('admin.change_role','platform_admin',$1,'{"role":"superadmin"}',$2,$1, now() + interval '1 day')`, [a.id, REASON]);
    const forced = (await pool.query(`select id from approval_requests where requested_by = $1`, [a.id])).rows[0].id;
    const fr = await approve(cb, forced);
    expect(fr.statusCode).toBe(409); expect(fr.json().error.code).toBe('EXECUTION_FAILED');
    expect((await pool.query('select status from approval_requests where id = $1', [forced])).rows[0].status).toBe('failed');
    expect((await adminRow(a.id)).role).toBe('platform_owner');
    expect((await request(ca, `/admins/${a.id}/reset-mfa`, {})).status).toBe(403);
    // b degraderar a (a är då inte längre owner) → b är sista ägaren; då får b inte inaktiveras av någon annan owner (finns ingen) via service
    const demote = await request(cb, `/admins/${a.id}/role`, { role: 'superadmin' });
    expect((await approve(ca, demote.body.approvalId)).json().status).toBe('executed');
    await expect(disableAdmin(pool, { admin: { id: a.id, email: a.email, role: 'superadmin' } }, b.id, REASON)).rejects.toMatchObject({ code: 'LAST_OWNER' });
    expect((await adminRow(b.id)).status).toBe('active');
  });

  it('inaktivering sker direkt, avslutar sessioner, kan inte riktas mot sig själv eller break-glass; aktivering kräver godkännande', async () => {
    const a = await createAdmin('platform_owner'); const b = await createAdmin('platform_owner'); const t = await createAdmin('technical_admin');
    const bg = await createAdmin('platform_owner', { breakGlass: true });
    const ca = await loginAdmin(app, a); const cb = await loginAdmin(app, b); const ct = await loginAdmin(app, t);
    expect((await request(ca, `/admins/${a.id}/disable`, {})).body.error.code).toBe('SELF_CHANGE_FORBIDDEN');
    expect((await request(ca, `/admins/${bg.id}/disable`, {})).body.error.code).toBe('BREAKGLASS_NOT_MANAGEABLE');
    expect((await request(ca, `/admins/${t.id}/disable`, {})).status).toBe(200);
    expect((await adminCall(app, { method: 'GET', url: '/auth/me', cookie: ct })).statusCode).toBe(401);
    expect((await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: t.email, password: PASSWORD } })).statusCode).toBe(401);
    const en = await request(ca, `/admins/${t.id}/enable`, {});
    expect(en.status).toBe(202); expect((await adminRow(t.id)).status).toBe('disabled');
    expect((await approve(cb, en.body.approvalId)).json().status).toBe('executed');
    expect((await adminRow(t.id)).status).toBe('active');
  });

  it('MFA-återställning rensar MFA och återhämtningskoder, gör lösenordet ogiltigt och kräver ny inställning via länk', async () => {
    const a = await createAdmin('platform_owner'); const b = await createAdmin('platform_owner'); const t = await createAdmin('support_admin');
    const ca = await loginAdmin(app, a); const cb = await loginAdmin(app, b); const ct = await loginAdmin(app, t);
    await pool.query(`insert into platform_admin_recovery_codes (admin_id, code_hash) values ($1, 'x')`, [t.id]);
    const r = await request(ca, `/admins/${t.id}/reset-mfa`, {});
    expect((await adminRow(t.id)).mfa_enrolled_at).not.toBeNull(); // inget sker före godkännande
    expect((await approve(cb, r.body.approvalId)).json().status).toBe('executed');
    const row = await adminRow(t.id);
    expect(row.mfa_secret_enc).toBeNull(); expect(row.mfa_enrolled_at).toBeNull();
    expect((await pool.query('select 1 from platform_admin_recovery_codes where admin_id = $1', [t.id])).rowCount).toBe(0);
    expect((await adminCall(app, { method: 'GET', url: '/auth/me', cookie: ct })).statusCode).toBe(401);
    expect((await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: t.email, password: PASSWORD } })).statusCode).toBe(401); // gamla lösenordet duger inte
    const token = await setupToken(t.email); expect(token).toBeTruthy();
    expect((await adminCall(app, { method: 'POST', url: '/auth/setup', payload: { token, password: 'Nytt-långt-lösenord-2026' } })).statusCode).toBe(200);
    expect((await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: t.email, password: 'Nytt-långt-lösenord-2026' } })).json().stage).toBe('mfa_enroll');
  });

  it('godkännandelistan visar mål för adminåtgärder och listan över admins döljer hemligheter', async () => {
    const a = await createAdmin('platform_owner'); const ca = await loginAdmin(app, a);
    await request(ca, '/admins', { email: 'lista@example.test', name: 'Lista', role: 'readonly_admin' });
    const ap = (await adminCall(app, { method: 'GET', url: '/approvals', cookie: ca })).json().items[0];
    expect(ap.targetName).toBe('lista@example.test'); expect(ap.action).toBe('admin.create');
    const list = (await adminCall(app, { method: 'GET', url: '/admins', cookie: ca })).json();
    expect(JSON.stringify(list)).not.toMatch(/password|mfa_secret|mfaSecret|passwordHash/);
    expect(list.items.length).toBeGreaterThan(0);
  });
});
