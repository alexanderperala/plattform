import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { runMaintenance } from '../src/jobs/maintenance.js';
import { REASON, setReauth, adminCall, auditRows, createAdmin, custCall, loginAdmin, makeApp, registerCustomer, resetDb, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

async function setup() {
  const customer = await registerCustomer(app, { workspaceName: 'Kundens förening' });
  await custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/members`, cookie: customer.cookie, payload: { email: 'medlem@example.test', name: 'Mia Medlem' } });
  await pool.query(`update users set phone = '0709998877' where email = 'medlem@example.test'`);
  const admin = await createAdmin('support_admin', { name: 'Sara Support' });
  const cookie = await loginAdmin(app, admin);
  const c = await adminCall(app, { method: 'POST', url: '/support/cases', cookie, payload: { subject: 'Hjälp med behörigheter', category: 'account_login' } });
  return { customer, admin, cookie, caseId: c.json().id as string };
}
const start = (cookie: string, workspaceId: string, supportCaseId: string, extra: Record<string, unknown> = {}) =>
  adminCall(app, { method: 'POST', url: '/support/access-sessions', cookie, payload: { workspaceId, supportCaseId, reason: 'Felsöka behörighetsproblem enligt ärendet', ...extra } });

describe('read-only supportåtkomst (avsnitt 5.3)', () => {
  it('kräver ett supportärende och en orsak', async () => {
    const { customer, cookie } = await setup();
    const noCase = await adminCall(app, { method: 'POST', url: '/support/access-sessions', cookie, payload: { workspaceId: customer.workspaceId, reason: REASON } });
    expect(noCase.statusCode).toBe(400);
    const badCase = await start(cookie, customer.workspaceId, '00000000-0000-4000-8000-000000000000');
    expect(badCase.statusCode).toBe(404);
    const noReason = await adminCall(app, { method: 'POST', url: '/support/access-sessions', cookie, payload: { workspaceId: customer.workspaceId, supportCaseId: '00000000-0000-4000-8000-000000000000' } });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.code).toBe('REASON_REQUIRED');
  });

  it('startar tidsbegränsad session, loggar och notifierar kunden (SUP-3, SUP-N)', async () => {
    const { customer, admin, cookie, caseId } = await setup();
    const r = await start(cookie, customer.workspaceId, caseId, { minutes: 45 });
    expect(r.statusCode).toBe(201);
    const mins = (new Date(r.json().expiresAt).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(44);
    expect(mins).toBeLessThanOrEqual(45);
    const log = (await auditRows(`action = 'support.access.started'`))[0]!;
    expect(log).toMatchObject({ admin_id: admin.id, workspace_id: customer.workspaceId, support_case_id: caseId, reason: 'Felsöka behörighetsproblem enligt ärendet' });
    expect(log.meta).toMatchObject({ mode: 'readonly', minutes: 45, personalData: false });
    // kundens ägare får både notis i produkten och e-post, med administratör, ärende, orsak och läge
    const notes = (await custCall(app, { method: 'GET', url: `/workspaces/${customer.workspaceId}/notifications`, cookie: customer.cookie })).json().items;
    const n = notes.find((x: any) => x.kind === 'support_access_started');
    expect(n.body).toContain('Sara Support');
    expect(n.body).toContain('Ärende #1');
    expect(n.body).toContain('Felsöka behörighetsproblem');
    expect(n.body).toContain('endast läsning');
    const mail = (await pool.query(`select to_email from notification_outbox where template = 'support_access_started'`)).rows;
    expect(mail.map((m) => m.to_email)).toEqual([customer.email]);
    // kunden ser åtkomsthistoriken
    const hist = (await custCall(app, { method: 'GET', url: `/workspaces/${customer.workspaceId}/support-access`, cookie: customer.cookie })).json().items;
    expect(hist[0]).toMatchObject({ adminName: 'Sara Support', mode: 'readonly', caseNumber: 1 });
  });

  it('maxlängd 120 minuter och assisterat läge kräver kundens godkännande', async () => {
    const { customer, cookie, caseId } = await setup();
    expect((await start(cookie, customer.workspaceId, caseId, { minutes: 121 })).statusCode).toBe(400);
    await setReauth(cookie, 0);
    const assisted = await start(cookie, customer.workspaceId, caseId, { mode: 'assisted' });
    expect(assisted.statusCode).toBe(409);
    expect(assisted.json().error.code).toBe('GRANT_REQUIRED');
    expect((await pool.query('select count(*)::int as n from support_access_sessions')).rows[0].n).toBe(0);
  });

  it('läsvyn visar konfiguration men inga personuppgifter eller hemligheter utan kundens godkännande', async () => {
    const { customer, cookie, caseId } = await setup();
    const s = await start(cookie, customer.workspaceId, caseId);
    const v = await adminCall(app, { method: 'GET', url: `/support/access-sessions/${s.json().id}/view`, cookie });
    expect(v.statusCode).toBe(200);
    const body = v.json();
    expect(body.workspace.name).toBe('Kundens förening');
    expect(body.products[0].product).toBe('association_portal');
    expect(body.roleCounts.find((r: any) => r.role === 'owner').n).toBe(1);
    expect(body.members).toBeUndefined();
    expect(v.body).not.toContain('Mia');
    expect(v.body).not.toContain('medlem@example.test');
    expect(v.body).not.toContain(customer.email);
    expect(v.body).not.toMatch(/scrypt\$|password_hash|token_hash|mfa_secret/i);
    expect(body.session.remainingSeconds).toBeGreaterThan(1700);
    // varje visning loggas
    expect((await auditRows(`action = 'support.access.view'`)).length).toBe(1);
    await adminCall(app, { method: 'GET', url: `/support/access-sessions/${s.json().id}/view`, cookie });
    expect((await pool.query('select views from support_access_sessions')).rows[0].views).toBe(2);
  });

  it('personuppgifter kräver kundens godkännande och maskerar telefon', async () => {
    const { customer, cookie, caseId } = await setup();
    const denied = await start(cookie, customer.workspaceId, caseId, { includePersonalData: true });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe('GRANT_REQUIRED');
    expect((await pool.query('select count(*)::int as n from support_access_sessions')).rows[0].n).toBe(0);
    const g = await custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/support-grants`, cookie: customer.cookie, payload: { hours: 2 } });
    expect(g.statusCode).toBe(201);
    const s = await start(cookie, customer.workspaceId, caseId, { includePersonalData: true });
    expect(s.statusCode).toBe(201);
    const v = (await adminCall(app, { method: 'GET', url: `/support/access-sessions/${s.json().id}/view`, cookie })).json();
    const mia = v.members.find((m: any) => m.name === 'Mia Medlem');
    expect(mia.email).toBe('medlem@example.test');
    expect(mia.phone).toBe('******8877');
    expect(JSON.stringify(v)).not.toMatch(/scrypt\$|password_hash/);
    expect((await auditRows(`action = 'support.access.started'`))[0]!.severity).toBe('warning');
    expect((await auditRows(`action = 'support.access.view'`))[0]!.meta.personalData).toBe(true);
  });

  it('kunden kan återkalla godkännandet mitt under sessionen och personuppgifter försvinner direkt', async () => {
    const { customer, cookie, caseId } = await setup();
    const g = (await custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/support-grants`, cookie: customer.cookie, payload: { hours: 2 } })).json();
    const s = await start(cookie, customer.workspaceId, caseId, { includePersonalData: true });
    expect((await adminCall(app, { method: 'GET', url: `/support/access-sessions/${s.json().id}/view`, cookie })).statusCode).toBe(200);
    const del = await custCall(app, { method: 'DELETE', url: `/workspaces/${customer.workspaceId}/support-grants/${g.id}`, cookie: customer.cookie });
    expect(del.statusCode).toBe(200);
    const after = await adminCall(app, { method: 'GET', url: `/support/access-sessions/${s.json().id}/view`, cookie });
    expect(after.statusCode).toBe(403);
    expect(after.json().error.code).toBe('SUPPORT_SESSION_ENDED'); // sessionen avslutas direkt när godkännandet återkallas
    expect((await pool.query('select ended_reason from support_access_sessions where id = $1', [s.json().id])).rows[0].ended_reason).toBe('grant_revoked');
  });

  it('godkännande och återkallelse loggas, kunden notifieras och nytt godkännande ersätter det gamla', async () => {
    const { customer } = await setup();
    const g1 = (await custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/support-grants`, cookie: customer.cookie, payload: { hours: 2 } })).json();
    const g2 = (await custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/support-grants`, cookie: customer.cookie, payload: { hours: 4 } })).json();
    const list = (await custCall(app, { method: 'GET', url: `/workspaces/${customer.workspaceId}/support-grants`, cookie: customer.cookie })).json().items;
    expect(list.find((x: any) => x.id === g1.id).revokedAt).toBeTruthy();
    expect(list.find((x: any) => x.id === g2.id).revokedAt).toBeNull();
    expect(list[0].grantedByName).toBeTruthy();
    await custCall(app, { method: 'DELETE', url: `/workspaces/${customer.workspaceId}/support-grants/${g2.id}`, cookie: customer.cookie });
    expect((await auditRows(`action = 'support.grant.created'`))).toHaveLength(2);
    expect((await auditRows(`action = 'support.grant.revoked'`))).toHaveLength(1);
    const kinds = (await pool.query(`select kind from workspace_notifications order by created_at`)).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['support_grant_created', 'support_grant_revoked']));
  });

  it('en annan kund kan varken se, ge eller återkalla godkännanden för arbetsytan', async () => {
    const { customer } = await setup();
    const other = await registerCustomer(app, { workspaceName: 'Annan förening', email: 'annan@example.test' });
    const g = (await custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/support-grants`, cookie: customer.cookie, payload: { hours: 2 } })).json();
    const base = `/workspaces/${customer.workspaceId}/support-grants`;
    for (const r of [
      await custCall(app, { method: 'GET', url: base, cookie: other.cookie }),
      await custCall(app, { method: 'POST', url: base, cookie: other.cookie, payload: { hours: 2 } }),
      await custCall(app, { method: 'DELETE', url: `${base}/${g.id}`, cookie: other.cookie }),
    ]) expect(r.statusCode).toBe(404);
    expect((await pool.query('select revoked_at from support_access_grants where id = $1', [g.id])).rows[0].revoked_at).toBeNull();
  });

  it('utgånget godkännande ger inte åtkomst', async () => {
    const { customer, cookie, caseId } = await setup();
    await custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/support-grants`, cookie: customer.cookie, payload: { hours: 1 } });
    await pool.query(`update support_access_grants set expires_at = now() - interval '1 second'`);
    expect((await start(cookie, customer.workspaceId, caseId, { includePersonalData: true })).json().error.code).toBe('GRANT_REQUIRED');
  });

  it('sessionen löper ut och åtkomst nekas direkt därefter (SUP-6)', async () => {
    const { customer, cookie, caseId } = await setup();
    const s = await start(cookie, customer.workspaceId, caseId, { minutes: 5 });
    const id = s.json().id;
    await pool.query(`update support_access_sessions set expires_at = now() - interval '1 second' where id = $1`, [id]);
    const v = await adminCall(app, { method: 'GET', url: `/support/access-sessions/${id}/view`, cookie });
    expect(v.statusCode).toBe(403);
    expect(v.json().error.code).toBe('SUPPORT_SESSION_EXPIRED');
    expect((await pool.query('select ended_reason from support_access_sessions where id = $1', [id])).rows[0].ended_reason).toBe('expired');
    expect((await adminCall(app, { method: 'GET', url: `/support/access-sessions/${id}/view`, cookie })).json().error.code).toBe('SUPPORT_SESSION_ENDED');
  });

  it('manuellt avslut, utloggning och underhållsjobb avslutar sessioner', async () => {
    const { customer, cookie, caseId } = await setup();
    const s1 = (await start(cookie, customer.workspaceId, caseId)).json().id;
    const end = await adminCall(app, { method: 'POST', url: `/support/access-sessions/${s1}/end`, cookie, payload: { reason: 'Problemet är löst, avslutar åtkomsten' } });
    expect(end.statusCode).toBe(200);
    expect((await adminCall(app, { method: 'GET', url: `/support/access-sessions/${s1}/view`, cookie })).statusCode).toBe(403);
    const s2 = (await start(cookie, customer.workspaceId, caseId)).json().id;
    await adminCall(app, { method: 'POST', url: '/auth/logout', cookie });
    expect((await pool.query('select ended_reason from support_access_sessions where id = $1', [s2])).rows[0].ended_reason).toBe('admin_session_revoked');
    const admin2 = await createAdmin('support_admin');
    const c2 = await loginAdmin(app, admin2);
    const s3 = (await start(c2, customer.workspaceId, caseId)).json().id;
    await pool.query('update support_access_sessions set expires_at = now() - interval \'1 minute\' where id = $1', [s3]);
    expect((await runMaintenance()).supportSessionsEnded).toBe(1);
  });

  it('en administratör kan inte använda en annan administratörs session', async () => {
    const { customer, cookie, caseId } = await setup();
    const id = (await start(cookie, customer.workspaceId, caseId)).json().id;
    const other = await createAdmin('superadmin');
    const oc = await loginAdmin(app, other);
    expect((await adminCall(app, { method: 'GET', url: `/support/access-sessions/${id}/view`, cookie: oc })).statusCode).toBe(404);
  });

  it('Billing och Technical Admin kan inte starta supportåtkomst', async () => {
    const { customer, caseId } = await setup();
    for (const role of ['billing_admin', 'technical_admin', 'readonly_admin'] as const) {
      const c = await loginAdmin(app, await createAdmin(role));
      expect((await start(c, customer.workspaceId, caseId)).statusCode, role).toBe(403);
    }
  });

  it('ärende kopplat till annan arbetsyta nekas', async () => {
    const { cookie, caseId, customer } = await setup();
    await adminCall(app, { method: 'PATCH', url: `/support/cases/${caseId}`, cookie, payload: { workspaceId: customer.workspaceId } });
    const other = await registerCustomer(app);
    expect((await start(cookie, other.workspaceId, caseId)).json().error.code).toBe('CASE_WORKSPACE_MISMATCH');
  });

  it('kunden kan inte skapa godkännanden som ger mer än personuppgiftsläsning (inget assisterat scope via API)', async () => {
    const { customer } = await setup();
    const g = await custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/support-grants`, cookie: customer.cookie, payload: { hours: 24, scope: 'assisted' } });
    expect(g.statusCode).toBe(201);
    expect((await pool.query('select scope from support_access_grants')).rows[0].scope).toBe('personal_data');
    expect((await custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/support-grants`, cookie: customer.cookie, payload: { hours: 500 } })).statusCode).toBe(400);
  });
});

export type { TestCustomer };

describe('assisterad support (S1)', () => {
  const grant = (customer: TestCustomer, payload: Record<string, unknown>) =>
    custCall(app, { method: 'POST', url: `/workspaces/${customer.workspaceId}/support-grants/assisted`, cookie: customer.cookie, payload });
  const act = (cookie: string, sid: string, payload: Record<string, unknown>) =>
    adminCall(app, { method: 'POST', url: `/support/access-sessions/${sid}/actions`, cookie, payload: { reason: 'Åtgärd enligt kundens begäran i ärendet', ...payload } });
  async function begin(actions = ['change_setting', 'enable_permission', 'configure_feature']) {
    const s = await setup();
    expect((await grant(s.customer, { hours: 2, actions })).statusCode).toBe(201);
    await setReauth(s.cookie, 0);
    const r = await start(s.cookie, s.customer.workspaceId, s.caseId, { mode: 'assisted', minutes: 30 });
    expect(r.statusCode).toBe(201);
    return { ...s, sid: r.json().id as string };
  }

  it('kräver åter-autentisering, rätt roll och max 60 minuter', async () => {
    const s = await setup();
    await grant(s.customer, { actions: ['change_setting'] });
    await setReauth(s.cookie, 30);
    const noReauth = await start(s.cookie, s.customer.workspaceId, s.caseId, { mode: 'assisted' });
    expect(noReauth.json().error.code).toBe('REAUTH_REQUIRED');
    await setReauth(s.cookie, 0);
    expect((await start(s.cookie, s.customer.workspaceId, s.caseId, { mode: 'assisted', minutes: 61 })).statusCode).toBe(400);
    const tech = await createAdmin('technical_admin');
    const tc = await loginAdmin(app, tech);
    await setReauth(tc, 0);
    expect((await start(tc, s.customer.workspaceId, s.caseId, { mode: 'assisted' })).statusCode).toBe(403);
  });

  it('startar med kundens godkännande, begränsar tiden till godkännandet och notifierar kunden', async () => {
    const s = await setup();
    await grant(s.customer, { hours: 1, actions: ['configure_feature'] });
    await setReauth(s.cookie, 0);
    const r = await start(s.cookie, s.customer.workspaceId, s.caseId, { mode: 'assisted', minutes: 60 });
    expect(r.statusCode).toBe(201);
    expect((new Date(r.json().expiresAt).getTime() - Date.now()) / 60_000).toBeLessThanOrEqual(60);
    const notes = (await custCall(app, { method: 'GET', url: `/workspaces/${s.customer.workspaceId}/notifications`, cookie: s.customer.cookie })).json().items;
    expect(notes.find((x: any) => x.kind === 'support_access_started').body).toContain('assisterad');
    const hist = (await custCall(app, { method: 'GET', url: `/workspaces/${s.customer.workspaceId}/support-access`, cookie: s.customer.cookie })).json().items;
    expect(hist[0]).toMatchObject({ mode: 'assisted', actions: 0 });
  });

  it('godkännandet kan inte ge förbjudna åtgärder och kräver en åtgärd', async () => {
    const s = await setup();
    expect((await grant(s.customer, { actions: ['change_billing'] })).statusCode).toBe(400);
    expect((await grant(s.customer, { actions: [] })).statusCode).toBe(400);
    const member = await registerCustomer(app, { workspaceName: 'Annan', email: 'annan@example.test' });
    // vanlig medlem får inte godkänna
    const other = await custCall(app, { method: 'POST', url: `/workspaces/${s.customer.workspaceId}/support-grants/assisted`, cookie: member.cookie, payload: { actions: ['change_setting'] } });
    expect([403, 404]).toContain(other.statusCode);
  });

  it('utför tillåtna åtgärder med före/efter i audit, ärende och kundnotis', async () => {
    const s = await begin();
    const f = await act(s.cookie, s.sid, { action: 'configure_feature', params: { flagKey: 'association.forum_v2', enabled: true } });
    expect(f.statusCode).toBe(200);
    expect((await pool.query(`select enabled from feature_flag_overrides where workspace_id = $1`, [s.customer.workspaceId])).rows[0].enabled).toBe(true);
    const c = await act(s.cookie, s.sid, { action: 'change_setting', params: { contactName: 'Rätt Namn' } });
    expect(c.statusCode).toBe(200);
    expect((await pool.query('select contact_name from workspaces where id = $1', [s.customer.workspaceId])).rows[0].contact_name).toBe('Rätt Namn');
    const mia = (await pool.query(`select id from users where email = 'medlem@example.test'`)).rows[0].id;
    expect((await act(s.cookie, s.sid, { action: 'enable_permission', params: { userId: mia, role: 'admin' } })).statusCode).toBe(200);
    expect((await pool.query('select role from workspace_members where user_id = $1', [mia])).rows[0].role).toBe('admin');
    const log = await auditRows(`action = 'support.assisted.action'`);
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({ support_case_id: s.caseId, workspace_id: s.customer.workspaceId, reason: 'Åtgärd enligt kundens begäran i ärendet' });
    expect(log[2]!.before).toEqual({ role: 'member' });
    expect(log[2]!.after).toEqual({ role: 'admin' });
    expect((await pool.query('select actions from support_access_sessions where id = $1', [s.sid])).rows[0].actions).toBe(3);
    const notes = (await custCall(app, { method: 'GET', url: `/workspaces/${s.customer.workspaceId}/notifications`, cookie: s.customer.cookie })).json().items;
    expect(notes.filter((n: any) => n.kind === 'support_assisted_action')).toHaveLength(3);
  });

  it('nekar åtgärdstyper som kunden inte tillåtit, ägarändring och okända åtgärder', async () => {
    const s = await begin(['configure_feature']);
    const denied = await act(s.cookie, s.sid, { action: 'change_setting', params: { name: 'Ny' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('ACTION_NOT_ALLOWED');
    for (const a of ['change_subscription', 'reset_password', 'delete_data', 'change_owner']) {
      expect((await act(s.cookie, s.sid, { action: a, params: {} })).statusCode).toBe(400);
    }
    expect((await pool.query('select name from workspaces where id = $1', [s.customer.workspaceId])).rows[0].name).toBe('Kundens förening');
    const s2 = await begin();
    const r = await act(s2.cookie, s2.sid, { action: 'enable_permission', params: { userId: s2.customer.userId, role: 'member' } });
    expect(r.statusCode).toBe(403);
    expect((await auditRows(`action = 'support.assisted.action'`)).length).toBe(0);
  });

  it('kräver orsak och färsk MFA för varje åtgärd', async () => {
    const s = await begin();
    const noReason = await adminCall(app, { method: 'POST', url: `/support/access-sessions/${s.sid}/actions`, cookie: s.cookie, payload: { action: 'configure_feature', params: { flagKey: 'association.forum_v2', enabled: true } } });
    expect(noReason.json().error.code).toBe('REASON_REQUIRED');
    await setReauth(s.cookie, 30);
    const stale = await act(s.cookie, s.sid, { action: 'configure_feature', params: { flagKey: 'association.forum_v2', enabled: true } });
    expect(stale.json().error.code).toBe('REAUTH_REQUIRED');
  });

  it('read-only session kan inte utföra åtgärder, och andra administratörers sessioner är otillgängliga', async () => {
    const s = await setup();
    const ro = await start(s.cookie, s.customer.workspaceId, s.caseId);
    await setReauth(s.cookie, 0);
    const r = await act(s.cookie, ro.json().id, { action: 'configure_feature', params: { flagKey: 'association.forum_v2', enabled: true } });
    expect(r.json().error.code).toBe('SESSION_READONLY');
    const b = await begin();
    const other = await createAdmin('superadmin');
    const oc = await loginAdmin(app, other);
    await setReauth(oc, 0);
    expect((await act(oc, b.sid, { action: 'configure_feature', params: { flagKey: 'association.forum_v2', enabled: true } })).statusCode).toBe(404);
  });

  it('återkallat eller utgånget godkännande stoppar åtgärder direkt och avslutar sessionen', async () => {
    const s = await begin();
    const gid = (await pool.query(`select id from support_access_grants where scope = 'assisted'`)).rows[0].id;
    const rev = await custCall(app, { method: 'DELETE', url: `/workspaces/${s.customer.workspaceId}/support-grants/${gid}`, cookie: s.customer.cookie });
    expect(rev.json().sessionsEnded).toBe(1);
    const r = await act(s.cookie, s.sid, { action: 'configure_feature', params: { flagKey: 'association.forum_v2', enabled: true } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('SUPPORT_SESSION_ENDED');
    const s2 = await begin();
    await pool.query(`update support_access_grants set expires_at = now() - interval '1 minute' where revoked_at is null and scope = 'assisted'`);
    await pool.query(`update support_access_sessions set expires_at = now() + interval '10 minutes' where id = $1`, [s2.sid]);
    const r2 = await act(s2.cookie, s2.sid, { action: 'configure_feature', params: { flagKey: 'association.forum_v2', enabled: true } });
    expect(r2.json().error.code).toBe('GRANT_REVOKED');
  });

  it('godkännande bundet till ett annat ärende räcker inte', async () => {
    const s = await setup();
    const c2 = await adminCall(app, { method: 'POST', url: '/support/cases', cookie: s.cookie, payload: { subject: 'Annat ärende', category: 'account_login' } });
    const num = (await pool.query('select number from support_cases where id = $1', [s.caseId])).rows[0].number;
    expect((await grant(s.customer, { actions: ['change_setting'], supportCaseNumber: num })).statusCode).toBe(201);
    await setReauth(s.cookie, 0);
    const wrong = await start(s.cookie, s.customer.workspaceId, c2.json().id, { mode: 'assisted' });
    expect(wrong.json().error.code).toBe('GRANT_REQUIRED');
    expect((await start(s.cookie, s.customer.workspaceId, s.caseId, { mode: 'assisted' })).statusCode).toBe(201);
  });
});
