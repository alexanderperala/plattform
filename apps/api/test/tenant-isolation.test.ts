import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { custCall, registerCustomer, resetDb, makeApp, adminCall, createAdmin, loginAdmin, REASON, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

describe('tenant-isolering (ARK-7, SEC-14)', () => {
  let a: TestCustomer, b: TestCustomer;
  beforeEach(async () => {
    a = await registerCustomer(app, { workspaceName: 'Förening A' });
    b = await registerCustomer(app, { workspaceName: 'Förening B', products: ['association_portal', 'tournament_system'] });
  });

  it('kund A kan inte läsa något om arbetsyta B och får 404 (avslöjar inte att den finns)', async () => {
    const urls = [
      `/workspaces/${b.workspaceId}`, `/workspaces/${b.workspaceId}/members`, `/workspaces/${b.workspaceId}/notifications`,
      `/workspaces/${b.workspaceId}/support-grants`, `/workspaces/${b.workspaceId}/support-access`,
      `/workspaces/${b.workspaceId}/products/association_portal/access`,
    ];
    for (const url of urls) {
      const r = await custCall(app, { method: 'GET', url, cookie: a.cookie });
      expect(r.statusCode, url).toBe(404);
      expect(r.body).not.toContain('Förening B');
    }
    const nonexistent = await custCall(app, { method: 'GET', url: `/workspaces/00000000-0000-4000-8000-000000000000`, cookie: a.cookie });
    expect(nonexistent.statusCode).toBe(404);
    expect(nonexistent.json().error.code).toBe(r404code(nonexistent));
  });
  const r404code = (r: { json: () => any }) => r.json().error.code;

  it('kund A kan inte ändra arbetsyta B', async () => {
    const writes: Array<['POST' | 'DELETE', string, unknown?]> = [
      ['POST', `/workspaces/${b.workspaceId}/members`, { email: 'inkraktare@example.test', name: 'I' }],
      ['POST', `/workspaces/${b.workspaceId}/products/tournament_system/activate`],
      ['POST', `/workspaces/${b.workspaceId}/support-grants`, { hours: 24 }],
    ];
    for (const [method, url, payload] of writes) {
      const r = await custCall(app, { method, url, cookie: a.cookie, payload });
      expect(r.statusCode, url).toBe(404);
    }
    expect((await pool.query(`select 1 from users where email = 'inkraktare@example.test'`)).rowCount).toBe(0);
    expect((await pool.query('select count(*)::int as n from support_access_grants')).rows[0].n).toBe(0);
  });

  it('en vanlig medlem (ej admin) kan inte bjuda in, godkänna support eller aktivera produkter i sin egen arbetsyta', async () => {
    await custCall(app, { method: 'POST', url: `/workspaces/${a.workspaceId}/members`, cookie: a.cookie, payload: { email: 'medlem@example.test', name: 'Medlem', role: 'member' } });
    const memberId = (await pool.query(`select id from users where email = 'medlem@example.test'`)).rows[0].id;
    const t = /token=([\w-]+)/.exec((await pool.query(`select body from notification_outbox where user_id = $1`, [memberId])).rows[0].body)![1]!;
    const acc = await custCall(app, { method: 'POST', url: '/auth/accept-invite', payload: { token: t, password: 'Medlemmens-lösenord-1' } });
    const cookie = acc.cookies.find((c) => c.name === 'cust_session')!;
    const mc = `cust_session=${cookie.value}`;
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${a.workspaceId}`, cookie: mc })).statusCode).toBe(200);
    for (const [method, url, payload] of [
      ['POST', `/workspaces/${a.workspaceId}/members`, { email: 'x@example.test', name: 'X' }],
      ['POST', `/workspaces/${a.workspaceId}/support-grants`, { hours: 1 }],
      ['GET', `/workspaces/${a.workspaceId}/support-grants`, undefined],
      ['POST', `/workspaces/${a.workspaceId}/products/tournament_system/activate`, undefined],
    ] as const) {
      expect((await custCall(app, { method, url, cookie: mc, payload })).statusCode, url).toBe(403);
    }
  });

  it('/me visar bara den egna arbetsytan', async () => {
    const me = (await custCall(app, { method: 'GET', url: '/me', cookie: a.cookie })).json();
    expect(me.workspaces.map((w: any) => w.name)).toEqual(['Förening A']);
  });

  it('inbjuden medlem i två arbetsytor ser båda men ingen tredje', async () => {
    const c = await registerCustomer(app, { workspaceName: 'Förening C' });
    await custCall(app, { method: 'POST', url: `/workspaces/${a.workspaceId}/members`, cookie: a.cookie, payload: { email: c.email, name: 'Kund', role: 'member' } });
    const me = (await custCall(app, { method: 'GET', url: '/me', cookie: c.cookie })).json();
    expect(me.workspaces.map((w: any) => w.name).sort()).toEqual(['Förening A', 'Förening C']);
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${b.workspaceId}`, cookie: c.cookie })).statusCode).toBe(404);
  });

  it('adminsessionen fungerar inte som kundsession och tvärtom', async () => {
    const admin = await createAdmin('platform_owner');
    const adminCookie = await loginAdmin(app, admin);
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${a.workspaceId}`, cookie: adminCookie })).statusCode).toBe(401);
    expect((await adminCall(app, { method: 'GET', url: '/dashboard', cookie: a.cookie })).statusCode).toBe(401);
  });

  it('kundrutter kräver CSRF-rubrik för skrivande anrop', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${a.workspaceId}/members`, headers: { cookie: a.cookie }, payload: { email: 'x@example.test', name: 'X' } });
    expect(r.statusCode).toBe(403);
  });
});

describe('arbetsytans tillstånd styr kundens åtkomst', () => {
  it('Suspended arbetsyta: skrivskyddad, men inloggning och läsning fungerar', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update workspaces set status = 'Suspended' where id = $1`, [c.workspaceId]);
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie })).statusCode).toBe(200);
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/products/association_portal/access`, cookie: c.cookie })).json().mode).toBe('read_only');
    expect((await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: 'x@example.test', name: 'X' } })).statusCode).toBe(403);
  });

  it('Closed arbetsyta: endast export (export_only)', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update workspaces set status = 'Closed', closed_at = now() where id = $1`, [c.workspaceId]);
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/products/association_portal/access`, cookie: c.cookie })).json().mode).toBe('export_only');
  });

  it('utgånget abonnemang ger ingen produktåtkomst men data finns kvar', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update subscriptions set status = 'Expired' where workspace_id = $1`, [c.workspaceId]);
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/products/association_portal/access`, cookie: c.cookie })).json().mode).toBe('none');
    expect((await pool.query('select count(*)::int as n from workspace_members where workspace_id = $1', [c.workspaceId])).rows[0].n).toBe(1);
  });
});

describe('kund aktiverar andra produkten (ARK-2)', () => {
  it('aktivering påverkar inte den första produkten och befintlig data bevaras vid återaktivering', async () => {
    const c = await registerCustomer(app, { products: ['association_portal'] });
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/products/tournament_system/access`, cookie: c.cookie })).json().mode).toBe('none');
    const on = await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/products/tournament_system/activate`, cookie: c.cookie });
    expect(on.statusCode).toBe(200);
    expect(on.json().alreadyActive).toBe(false);
    const mode = async (p: string) => (await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/products/${p}/access`, cookie: c.cookie })).json().mode;
    expect(await mode('tournament_system')).toBe('full');
    expect(await mode('association_portal')).toBe('full');
    expect((await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/products/tournament_system/activate`, cookie: c.cookie })).json().alreadyActive).toBe(true);
    // inaktiverad av admin, kunden återaktiverar: samma rad, ingen data raderad
    await pool.query(`update product_entitlements set status = 'Disabled' where workspace_id = $1 and product = 'tournament_system'`, [c.workspaceId]);
    const id = (await pool.query(`select id from product_entitlements where workspace_id = $1 and product = 'tournament_system'`, [c.workspaceId])).rows[0].id;
    const re = await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/products/tournament_system/activate`, cookie: c.cookie });
    expect(re.json().dataPreserved).toBe(true);
    expect((await pool.query(`select id from product_entitlements where workspace_id = $1 and product = 'tournament_system'`, [c.workspaceId])).rows[0].id).toBe(id);
  });

  it('kunden kan inte själv häva en avstängning från plattformen eller aktivera med utgånget abonnemang', async () => {
    const c = await registerCustomer(app, { products: ['association_portal', 'tournament_system'] });
    await pool.query(`update product_entitlements set status = 'Suspended' where workspace_id = $1 and product = 'tournament_system'`, [c.workspaceId]);
    const r = await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/products/tournament_system/activate`, cookie: c.cookie });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('SUSPENDED_BY_PLATFORM');
    await pool.query(`update subscriptions set status = 'Expired' where workspace_id = $1`, [c.workspaceId]);
    expect((await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/products/association_portal/activate`, cookie: c.cookie })).json().error.code).toBe('SUBSCRIPTION_REQUIRED');
  });
});

describe('användargräns (ENT-1)', () => {
  it('provplanens gräns på 10 användare upprätthålls i backend, och uppgradering höjer gränsen', async () => {
    const c = await registerCustomer(app);
    for (let i = 0; i < 9; i++) {
      const r = await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: `u${i}@example.test`, name: `U${i}` } });
      expect(r.statusCode, `användare ${i}`).toBe(201);
    }
    const over = await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: 'u10@example.test', name: 'U10' } });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatchObject({ code: 'LIMIT_EXCEEDED', details: { max: 10, used: 10 } });
    const admin = await createAdmin('billing_admin');
    const cookie = await loginAdmin(app, admin);
    await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/subscription`, cookie, payload: { reason: REASON, action: 'activate', planId: 'standard' } });
    expect((await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: 'u10@example.test', name: 'U10' } })).statusCode).toBe(201);
  });

  it('samtidiga inbjudningar går inte över gränsen (serialiserad kontroll)', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update product_entitlements set limits_override = '{"max_users": 4}' where workspace_id = $1`, [c.workspaceId]);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: `p${i}@example.test`, name: `P${i}` } })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3); // ägaren + 3 = 4
    expect((await pool.query('select count(*)::int as n from workspace_members where workspace_id = $1', [c.workspaceId])).rows[0].n).toBe(4);
  });
});

describe('kundkonton', () => {
  it('registrering skapar användare, arbetsyta, provabonnemang och licenser och kräver godkända villkor', async () => {
    const noTerms = await custCall(app, { method: 'POST', url: '/auth/register', payload: { email: 'a@example.test', password: 'Kundlösenord-2026', name: 'A', workspaceName: 'W', products: ['association_portal'], acceptTerms: false } });
    expect(noTerms.statusCode).toBe(400);
    const c = await registerCustomer(app, { products: ['association_portal', 'tournament_system'] });
    const ws = (await pool.query('select terms_version, dpa_version, terms_accepted_at from workspaces where id = $1', [c.workspaceId])).rows[0];
    expect(ws.terms_version).toBe('v1');
    expect(ws.dpa_version).toBe('v1');
    expect(ws.terms_accepted_at).toBeTruthy();
    const sub = (await pool.query('select status, plan_id from subscriptions where workspace_id = $1', [c.workspaceId])).rows[0];
    expect(sub).toEqual({ status: 'Trialing', plan_id: 'trial' });
    expect((await pool.query('select count(*)::int as n from product_entitlements where workspace_id = $1', [c.workspaceId])).rows[0].n).toBe(2);
  });

  it('lösenord lagras som hash, svagt lösenord nekas och dubblett-e-post nekas', async () => {
    const weak = await custCall(app, { method: 'POST', url: '/auth/register', payload: { email: 'a@example.test', password: 'kort', name: 'A', workspaceName: 'W', products: ['association_portal'], acceptTerms: true } });
    expect(weak.statusCode).toBe(400);
    const c = await registerCustomer(app);
    const h = (await pool.query('select password_hash from users where id = $1', [c.userId])).rows[0].password_hash;
    expect(h).toMatch(/^scrypt\$/);
    expect(h).not.toContain('Kundlösenord');
    const dup = await custCall(app, { method: 'POST', url: '/auth/register', payload: { email: c.email.toUpperCase(), password: 'Kundlösenord-2026', name: 'A', workspaceName: 'W', products: ['association_portal'], acceptTerms: true } });
    expect(dup.statusCode).toBe(409);
  });

  it('inloggning ger samma fel för okänt konto och fel lösenord, och glömt lösenord läcker inte om kontot finns', async () => {
    const c = await registerCustomer(app);
    const wrong = await custCall(app, { method: 'POST', url: '/auth/login', payload: { email: c.email, password: 'fel-lösenord-123' } });
    const unknown = await custCall(app, { method: 'POST', url: '/auth/login', payload: { email: 'finns-inte@example.test', password: 'fel-lösenord-123' } });
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    const f1 = await custCall(app, { method: 'POST', url: '/auth/forgot-password', payload: { email: c.email } });
    const f2 = await custCall(app, { method: 'POST', url: '/auth/forgot-password', payload: { email: 'finns-inte@example.test' } });
    expect(f1.json()).toEqual(f2.json());
    expect((await pool.query(`select 1 from notification_outbox where template = 'password_reset'`)).rowCount).toBe(1);
  });

  it('borttagna användare kan inte logga in', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update users set status = 'deleted' where id = $1`, [c.userId]);
    expect((await custCall(app, { method: 'POST', url: '/auth/login', payload: { email: c.email, password: 'Kundlösenord-2026' } })).statusCode).toBe(401);
    expect((await custCall(app, { method: 'GET', url: '/me', cookie: c.cookie })).statusCode).toBe(401);
  });
});
