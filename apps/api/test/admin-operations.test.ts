import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { REQUIREMENTS, ROLES, type Role, hasPermission } from '../src/domain/permissions.js';
import { REASON, adminCall, auditRows, createAdmin, custCall, loginAdmin, makeApp, registerCustomer, resetDb, type TestAdmin, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

async function session(role: Role): Promise<{ admin: TestAdmin; cookie: string }> {
  const admin = await createAdmin(role);
  return { admin, cookie: await loginAdmin(app, admin) };
}

describe('backend-behörighet per roll (inte bara frontend)', () => {
  // Varje rad: [metod, url-mall, behörighet som krävs, payload]
  const cases: Array<['GET' | 'POST' | 'PATCH' | 'PUT', (ids: Ids) => string, string, unknown?]> = [
    ['GET', () => '/dashboard', 'dashboard.view'],
    ['GET', () => '/workspaces', 'workspaces.view'],
    ['GET', (i) => `/workspaces/${i.ws}`, 'workspaces.view'],
    ['PATCH', (i) => `/workspaces/${i.ws}`, 'workspaces.update', { reason: REASON, name: 'Nytt namn' }],
    ['POST', (i) => `/workspaces/${i.ws}/suspend`, 'workspaces.suspend', { reason: REASON }],
    ['POST', (i) => `/workspaces/${i.ws}/close`, 'workspaces.close', { reason: REASON }],
    ['POST', (i) => `/workspaces/${i.ws}/notes`, 'workspaces.notes', { body: 'anteckning' }],
    ['POST', (i) => `/workspaces/${i.ws}/revoke-sessions`, 'users.lock', { reason: REASON }],
    ['GET', () => '/users', 'users.view'],
    ['GET', (i) => `/users/${i.user}`, 'users.view'],
    ['POST', (i) => `/users/${i.user}/lock`, 'users.lock', { reason: REASON }],
    ['POST', (i) => `/users/${i.user}/reset-password`, 'users.account_actions', { reason: REASON }],
    ['POST', (i) => `/users/${i.user}/delete`, 'users.delete', { reason: REASON }],
    ['GET', () => '/plans', 'entitlements.view'],
    ['GET', () => '/entitlements', 'entitlements.view'],
    ['POST', (i) => `/workspaces/${i.ws}/entitlements/association_portal`, 'entitlements.manage', { reason: REASON, action: 'suspend' }],
    ['POST', (i) => `/workspaces/${i.ws}/subscription`, 'subscriptions.manage', { reason: REASON, action: 'pause' }],
    ['GET', () => '/support/cases', 'support.view'],
    ['POST', () => '/support/cases', 'support.manage', { subject: 'Ett ärende', category: 'other' }],
    ['GET', () => '/audit', 'audit.view'],
    ['GET', () => '/logs/errors', 'logs.view'],
    ['GET', () => '/approvals', 'dashboard.view'],
    ['GET', () => '/flags', 'entitlements.view'],
    ['PATCH', () => '/flags/association.forum_v2', 'flags.manage', { reason: REASON, defaultEnabled: true }],
    ['PUT', (i) => `/workspaces/${i.ws}/flags/association.forum_v2`, 'flags.manage', { reason: REASON, enabled: true }],
    ['GET', () => '/settings', 'settings.manage'],
    ['PATCH', () => '/settings/trial.default_days', 'settings.manage', { reason: REASON, value: 21 }],
  ];
  interface Ids { ws: string; user: string }

  it.each(ROLES)('roll %s: varje rutt ger 403 om behörigheten saknas och aldrig 403 om den finns', async (role) => {
    const c = await registerCustomer(app);
    const ids: Ids = { ws: c.workspaceId, user: c.userId };
    for (const [method, urlOf, perm, payload] of cases) {
      // Ny session per anrop eftersom vissa åtgärder ändrar tillstånd
      const { cookie } = await session(role);
      const res = await adminCall(app, { method, url: urlOf(ids), cookie, payload });
      if (hasPermission(role, perm)) {
        expect(res.statusCode, `${role} ${method} ${urlOf(ids)}`).not.toBe(403);
      } else {
        expect(res.statusCode, `${role} ${method} ${urlOf(ids)}`).toBe(403);
        expect(res.json().error.code).toBe('FORBIDDEN');
      }
    }
  });

  it('dashboarden skickar inte kort som rollen inte får se', async () => {
    const support = (await adminCall(app, { method: 'GET', url: '/dashboard', cookie: (await session('support_admin')).cookie })).json();
    expect(support.subscriptions).toBeDefined(); // support får se abonnemangsstatus
    const billing = (await adminCall(app, { method: 'GET', url: '/dashboard', cookie: (await session('billing_admin')).cookie })).json();
    expect(billing.system).toBeUndefined();
    expect(billing.activeUsers).toBeUndefined();
    const tech = (await adminCall(app, { method: 'GET', url: '/dashboard', cookie: (await session('technical_admin')).cookie })).json();
    expect(tech.subscriptions).toBeUndefined();
    expect(tech.system).toBeDefined();
  });

  it('Support Admin ser inga priser i planer och inga abonnemangsdetaljer utöver status', async () => {
    const support = (await adminCall(app, { method: 'GET', url: '/plans', cookie: (await session('support_admin')).cookie })).json();
    expect(support.items[0].monthlyPriceMinor).toBeUndefined();
    const billing = (await adminCall(app, { method: 'GET', url: '/plans', cookie: (await session('billing_admin')).cookie })).json();
    expect(billing.items.find((p: any) => p.id === 'start').monthlyPriceMinor).toBeGreaterThan(0);
  });

  it('telefonnummer maskeras för roller utan kontoåtgärder', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update users set phone = '0701234567' where id = $1`, [c.userId]);
    const ro = (await adminCall(app, { method: 'GET', url: `/users/${c.userId}`, cookie: (await session('readonly_admin')).cookie })).json();
    expect(ro.user.phone).toBe('******4567');
    const su = (await adminCall(app, { method: 'GET', url: `/users/${c.userId}`, cookie: (await session('support_admin')).cookie })).json();
    expect(su.user.phone).toBe('0701234567');
  });

  it('API-svar innehåller aldrig lösenordshash, token eller MFA-hemlighet', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('platform_owner');
    for (const url of ['/users', `/users/${c.userId}`, `/workspaces/${c.workspaceId}`, '/dashboard']) {
      const body = (await adminCall(app, { method: 'GET', url, cookie })).body;
      expect(body, url).not.toMatch(/scrypt\$/);
      expect(body, url).not.toMatch(/password_hash|passwordHash|mfa_secret|token_hash/i);
    }
  });
});

describe('kundlista: sökning och filtrering', () => {
  async function seed() {
    const a = await registerCustomer(app, { workspaceName: 'Malmö Bordtennis', orgNumber: '802001-1111', kind: 'association', products: ['association_portal'] });
    const b = await registerCustomer(app, { workspaceName: 'Lund Flipper', orgNumber: '802002-2222', kind: 'organizer', products: ['tournament_system'] });
    const c = await registerCustomer(app, { workspaceName: 'Båstad 100%_Tennis', products: ['association_portal', 'tournament_system'] });
    await pool.query(`update subscriptions set plan_id = 'standard', status = 'Active', trial_ends_at = null where workspace_id = $1`, [b.workspaceId]);
    await pool.query(`update workspaces set status = 'Suspended' where id = $1`, [c.workspaceId]);
    await pool.query(`update subscriptions set status = 'PastDue', past_due_since = now(), plan_id = 'start', trial_ends_at = null where workspace_id = $1`, [c.workspaceId]);
    return { a, b, c };
  }
  const list = async (cookie: string, qs: string) => (await adminCall(app, { method: 'GET', url: `/workspaces?${qs}`, cookie })).json();

  it('söker på namn, organisationsnummer, id, kontaktperson och e-post', async () => {
    const { a, b } = await seed();
    const { cookie } = await session('support_admin');
    expect((await list(cookie, 'q=bordtennis')).items.map((i: any) => i.name)).toEqual(['Malmö Bordtennis']);
    expect((await list(cookie, 'q=802002')).items.map((i: any) => i.name)).toEqual(['Lund Flipper']);
    expect((await list(cookie, `q=${a.workspaceId}`)).items.map((i: any) => i.id)).toEqual([a.workspaceId]);
    expect((await list(cookie, `q=${encodeURIComponent(b.email)}`)).total).toBe(1);
    expect((await list(cookie, 'q=Kund%20Kundsson')).total).toBe(3);
  });

  it('LIKE-tecken i sökningen tolkas som vanlig text', async () => {
    await seed();
    const { cookie } = await session('support_admin');
    expect((await list(cookie, 'q=' + encodeURIComponent('100%_'))).total).toBe(1);
    expect((await list(cookie, 'q=' + encodeURIComponent('%'))).total).toBe(1);
  });

  it('filter kan kombineras', async () => {
    await seed();
    const { cookie } = await session('support_admin');
    expect((await list(cookie, 'product=tournament_system')).total).toBe(2);
    expect((await list(cookie, 'product=tournament_system&workspaceStatus=Active')).items.map((i: any) => i.name)).toEqual(['Lund Flipper']);
    expect((await list(cookie, 'subscriptionStatus=PastDue')).total).toBe(1);
    expect((await list(cookie, 'subscriptionStatus=Trialing&kind=association')).items.map((i: any) => i.name)).toEqual(['Malmö Bordtennis']);
    expect((await list(cookie, 'plan=standard&product=association_portal')).total).toBe(0);
    expect((await list(cookie, 'from=2999-01-01')).total).toBe(0);
  });

  it('utgången provperiod räknas som Expired i filter även om raden inte uppdaterats', async () => {
    const { a } = await seed();
    await pool.query(`update subscriptions set trial_ends_at = now() - interval '1 day' where workspace_id = $1`, [a.workspaceId]);
    const { cookie } = await session('support_admin');
    expect((await list(cookie, 'subscriptionStatus=Expired')).items.map((i: any) => i.name)).toEqual(['Malmö Bordtennis']);
    expect((await list(cookie, 'subscriptionStatus=Trialing')).total).toBe(0);
  });

  it('sidindelning och sortering sker på servern och sidstorleken begränsas', async () => {
    await seed();
    const { cookie } = await session('support_admin');
    const p1 = await list(cookie, 'pageSize=2&page=1&sort=name&dir=asc');
    const p2 = await list(cookie, 'pageSize=2&page=2&sort=name&dir=asc');
    expect(p1.total).toBe(3);
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(1);
    expect([...p1.items, ...p2.items].map((i: any) => i.name)).toEqual(['Båstad 100%_Tennis', 'Lund Flipper', 'Malmö Bordtennis']);
    const tooBig = await adminCall(app, { method: 'GET', url: '/workspaces?pageSize=1000', cookie });
    expect(tooBig.statusCode).toBe(400);
  });

  it('SQL-injektion i sökfältet och sortering ger ingen effekt', async () => {
    await seed();
    const { cookie } = await session('support_admin');
    const r = await adminCall(app, { method: 'GET', url: `/workspaces?q=${encodeURIComponent("'; drop table workspaces; --")}&sort=${encodeURIComponent('name; drop table users')}`, cookie });
    expect(r.statusCode).toBe(200);
    expect((await pool.query('select count(*)::int as n from workspaces')).rows[0].n).toBe(3);
  });

  it('Support Admin ser abonnemangsstatus men Technical Admin gör det inte', async () => {
    await seed();
    const su = await list((await session('support_admin')).cookie, '');
    expect(su.items[0].subscriptionStatus).toBeDefined();
    const te = await list((await session('technical_admin')).cookie, '');
    expect(te.items[0].subscriptionStatus).toBeUndefined();
  });

  it('användarsökning på namn, e-post, id och arbetsyta', async () => {
    const { a } = await seed();
    const { cookie } = await session('support_admin');
    const u = async (qs: string) => (await adminCall(app, { method: 'GET', url: `/users?${qs}`, cookie })).json();
    expect((await u(`q=${encodeURIComponent(a.email)}`)).total).toBe(1);
    expect((await u(`q=${a.userId}`)).total).toBe(1);
    expect((await u(`workspaceId=${a.workspaceId}`)).total).toBe(1);
    expect((await u('q=Malm%C3%B6%20Bordtennis')).items[0].id).toBe(a.userId);
  });
});

describe('administrativa åtgärder loggas i audit log (SA-AUDIT)', () => {
  it('suspend/reactivate: status, notis till kund, audit med orsak, före och efter', async () => {
    const c = await registerCustomer(app);
    const { admin, cookie } = await session('superadmin');
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/suspend`, cookie, payload: { reason: 'Utredning av missbruk pågår' } });
    expect(r.statusCode).toBe(200);
    expect((await pool.query('select status from workspaces where id = $1', [c.workspaceId])).rows[0].status).toBe('Suspended');
    const rows = await auditRows(`action = 'workspace.suspend'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ admin_id: admin.id, admin_email: admin.email, admin_role: 'superadmin', workspace_id: c.workspaceId, reason: 'Utredning av missbruk pågår', severity: 'warning' });
    expect(rows[0]!.before).toEqual({ status: 'Active' });
    expect(rows[0]!.after).toEqual({ status: 'Suspended' });
    expect(rows[0]!.request_id).toBeTruthy();
    expect((await pool.query(`select 1 from workspace_notifications where workspace_id = $1 and kind = 'workspace_suspended'`, [c.workspaceId])).rowCount).toBe(1);
    // dubbel suspend nekas
    expect((await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/suspend`, cookie, payload: { reason: 'Utredning av missbruk pågår' } })).statusCode).toBe(409);
    const re = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/reactivate`, cookie, payload: { reason: 'Utredningen är avslutad utan fynd' } });
    expect(re.statusCode).toBe(200);
    expect((await auditRows(`action = 'workspace.reactivate'`)).length).toBe(1);
  });

  it('misslyckad åtgärd lämnar inga spår av ändring (transaktion) och ingen audit-post om statusen inte ändrats', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('superadmin');
    const before = (await pool.query('select count(*)::int as n from admin_audit_log')).rows[0].n;
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/reactivate`, cookie, payload: { reason: 'Försök att återaktivera aktiv yta' } });
    expect(r.statusCode).toBe(409);
    expect((await pool.query('select count(*)::int as n from admin_audit_log')).rows[0].n).toBe(before);
  });

  it('kontaktuppgifter: före/efter loggas och validering sker', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('support_admin');
    const bad = await adminCall(app, { method: 'PATCH', url: `/workspaces/${c.workspaceId}`, cookie, payload: { reason: REASON, contactEmail: 'inte-en-epost' } });
    expect(bad.statusCode).toBe(400);
    const ok = await adminCall(app, { method: 'PATCH', url: `/workspaces/${c.workspaceId}`, cookie, payload: { reason: REASON, contactEmail: 'ny@example.test', contactName: 'Ny Person' } });
    expect(ok.statusCode).toBe(200);
    const row = (await auditRows(`action = 'workspace.update'`))[0]!;
    expect(row.before.contact_email).toBe(c.email);
    expect(row.after.contact_email).toBe('ny@example.test');
  });

  it('interna anteckningar sparas, loggas och visas inte i kund-API:t', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('support_admin');
    const n = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/notes`, cookie, payload: { body: 'Kunden ringde och var missnöjd' } });
    expect(n.statusCode).toBe(201);
    const detail = (await adminCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}`, cookie })).json();
    expect(detail.notes[0].body).toBe('Kunden ringde och var missnöjd');
    for (const url of [`/workspaces/${c.workspaceId}`, `/workspaces/${c.workspaceId}/notifications`, '/me']) {
      const res = await custCall(app, { method: 'GET', url, cookie: c.cookie });
      expect(res.body).not.toContain('missnöjd');
    }
  });

  it('återkalla sessioner i arbetsyta loggas och loggar ut kunden', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('support_admin');
    expect((await custCall(app, { method: 'GET', url: '/me', cookie: c.cookie })).statusCode).toBe(200);
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/revoke-sessions`, cookie, payload: { reason: REASON } });
    expect(r.json().sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await custCall(app, { method: 'GET', url: '/me', cookie: c.cookie })).statusCode).toBe(401);
    expect((await auditRows(`action = 'workspace.sessions_revoked'`)).length).toBe(1);
  });
});

describe('användarkonton (SA-USER)', () => {
  it('lås och lås upp: sessioner återkallas, inloggning nekas, audit', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('support_admin');
    expect((await adminCall(app, { method: 'POST', url: `/users/${c.userId}/lock`, cookie, payload: { reason: 'Misstänkt kontoövertagande' } })).statusCode).toBe(200);
    expect((await custCall(app, { method: 'GET', url: '/me', cookie: c.cookie })).statusCode).toBe(401);
    const login = await custCall(app, { method: 'POST', url: '/auth/login', payload: { email: c.email, password: 'Kundlösenord-2026' } });
    expect(login.statusCode).toBe(401);
    expect((await adminCall(app, { method: 'POST', url: `/users/${c.userId}/lock`, cookie, payload: { reason: 'Misstänkt kontoövertagande' } })).statusCode).toBe(200); // idempotent nog
    expect((await adminCall(app, { method: 'POST', url: `/users/${c.userId}/unlock`, cookie, payload: { reason: 'Kontoinnehavaren har verifierats' } })).statusCode).toBe(200);
    expect((await custCall(app, { method: 'POST', url: '/auth/login', payload: { email: c.email, password: 'Kundlösenord-2026' } })).statusCode).toBe(200);
    expect((await auditRows(`user_id = $1 and action like 'user.%'`, [c.userId])).map((r) => r.action)).toEqual(['user.lock', 'user.lock', 'user.unlock']);
  });

  it('lösenordsåterställning: länk skickas via utkorg, aldrig i API-svaret, kan användas en gång och loggar ut gamla sessioner', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('support_admin');
    const r = await adminCall(app, { method: 'POST', url: `/users/${c.userId}/reset-password`, cookie, payload: { reason: REASON } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/token=/);
    const mail = (await pool.query(`select body, to_email from notification_outbox where template = 'password_reset' and user_id = $1`, [c.userId])).rows[0];
    expect(mail.to_email).toBe(c.email);
    const token = /token=([\w-]+)/.exec(mail.body)![1]!;
    const bad = await custCall(app, { method: 'POST', url: '/auth/reset-password', payload: { token, password: 'kort' } });
    expect(bad.statusCode).toBe(400);
    const ok = await custCall(app, { method: 'POST', url: '/auth/reset-password', payload: { token, password: 'Nytt-bra-lösenord-9' } });
    expect(ok.statusCode).toBe(200);
    expect((await custCall(app, { method: 'POST', url: '/auth/reset-password', payload: { token, password: 'Annat-bra-lösenord-9' } })).statusCode).toBe(400); // engångs
    expect((await custCall(app, { method: 'GET', url: '/me', cookie: c.cookie })).statusCode).toBe(401); // gammal session död
    expect((await custCall(app, { method: 'POST', url: '/auth/login', payload: { email: c.email, password: 'Nytt-bra-lösenord-9' } })).statusCode).toBe(200);
    // token lagras som hash
    expect((await pool.query(`select 1 from user_tokens where token_hash = $1`, [token])).rowCount).toBe(0);
  });

  it('utgången återställningslänk nekas', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('support_admin');
    await adminCall(app, { method: 'POST', url: `/users/${c.userId}/reset-password`, cookie, payload: { reason: REASON } });
    const token = /token=([\w-]+)/.exec((await pool.query(`select body from notification_outbox where template = 'password_reset'`)).rows[0].body)![1]!;
    await pool.query(`update user_tokens set expires_at = now() - interval '1 second' where kind = 'password_reset'`);
    expect((await custCall(app, { method: 'POST', url: '/auth/reset-password', payload: { token, password: 'Nytt-bra-lösenord-9' } })).statusCode).toBe(400);
  });

  it('verifieringsmejl och inbjudan skickas via utkorgen och inbjudan kan aktiveras', async () => {
    const owner = await registerCustomer(app);
    await custCall(app, { method: 'POST', url: `/workspaces/${owner.workspaceId}/members`, cookie: owner.cookie, payload: { email: 'inbjuden@example.test', name: 'Inbjuden Person' } });
    const invitee = (await pool.query(`select id, password_hash from users where email = 'inbjuden@example.test'`)).rows[0];
    expect(invitee.password_hash).toBeNull();
    const { cookie } = await session('support_admin');
    expect((await adminCall(app, { method: 'POST', url: `/users/${invitee.id}/resend-invite`, cookie, payload: { reason: REASON } })).statusCode).toBe(200);
    const mails = (await pool.query(`select body from notification_outbox where template = 'invite' and user_id = $1 order by created_at`, [invitee.id])).rows;
    expect(mails).toHaveLength(2);
    const tokenNew = /token=([\w-]+)/.exec(mails[1]!.body)![1]!;
    const tokenOld = /token=([\w-]+)/.exec(mails[0]!.body)![1]!;
    expect((await custCall(app, { method: 'POST', url: '/auth/accept-invite', payload: { token: tokenOld, password: 'Inbjudans-lösenord-1' } })).statusCode).toBe(400); // ersatt
    expect((await custCall(app, { method: 'POST', url: '/auth/accept-invite', payload: { token: tokenNew, password: 'Inbjudans-lösenord-1' } })).statusCode).toBe(200);
    expect((await adminCall(app, { method: 'POST', url: `/users/${invitee.id}/resend-invite`, cookie, payload: { reason: REASON } })).statusCode).toBe(409); // redan aktiverad
    // verifiering
    expect((await adminCall(app, { method: 'POST', url: `/users/${owner.userId}/send-verification`, cookie, payload: { reason: REASON } })).statusCode).toBe(200);
    const vt = /token=([\w-]+)/.exec((await pool.query(`select body from notification_outbox where template = 'email_verify' and user_id = $1 order by created_at desc limit 1`, [owner.userId])).rows[0].body)![1]!;
    expect((await custCall(app, { method: 'POST', url: '/auth/verify-email', payload: { token: vt } })).statusCode).toBe(200);
    expect((await adminCall(app, { method: 'POST', url: `/users/${owner.userId}/send-verification`, cookie, payload: { reason: REASON } })).statusCode).toBe(409);
  });
});

describe('fyra-ögon-principen (avsnitt 6.3)', () => {
  it('avslut av arbetsyta skapar begäran och utförs inte direkt', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('superadmin');
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    expect(r.statusCode).toBe(202);
    expect(r.json().approvalRequired).toBe(true);
    expect((await pool.query('select status from workspaces where id = $1', [c.workspaceId])).rows[0].status).toBe('Active');
    expect((await custCall(app, { method: 'GET', url: '/me', cookie: c.cookie })).statusCode).toBe(200);
    expect((await auditRows(`action = 'approval.requested'`)).length).toBe(1);
    expect((await auditRows(`action = 'workspace.close'`)).length).toBe(0);
  });

  it('dubbel begäran för samma mål nekas', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('superadmin');
    const payload = { reason: 'Kunden har begärt uppsägning skriftligen' };
    await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie, payload });
    const again = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie, payload });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_PENDING');
  });

  it('en annan administratör godkänner: åtgärden utförs, sessioner dör, kund notifieras, allt loggas', async () => {
    const c = await registerCustomer(app);
    const req = await session('superadmin');
    const apr = await session('platform_owner');
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: req.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    const id = r.json().approvalId;
    const ok = await adminCall(app, { method: 'POST', url: `/approvals/${id}/approve`, cookie: apr.cookie, payload: { reason: 'Bekräftat med kunden' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('executed');
    expect(ok.json().selfApproved).toBe(false);
    expect((await pool.query('select status from workspaces where id = $1', [c.workspaceId])).rows[0].status).toBe('Closed');
    expect((await custCall(app, { method: 'GET', url: '/me', cookie: c.cookie })).statusCode).toBe(401);
    expect((await pool.query(`select 1 from workspace_notifications where kind = 'workspace_closed'`)).rowCount).toBe(1);
    const close = (await auditRows(`action = 'workspace.close'`))[0]!;
    expect(close.admin_id).toBe(apr.admin.id);
    expect(close.meta.requestedBy).toBe(req.admin.id);
    expect(close.severity).toBe('critical');
    expect((await auditRows(`action in ('approval.requested','approval.approved')`)).length).toBe(2);
    // kan inte godkännas igen
    expect((await adminCall(app, { method: 'POST', url: `/approvals/${id}/approve`, cookie: apr.cookie, payload: {} })).statusCode).toBe(409);
  });

  it('beställaren får inte godkänna sin egen begäran när det finns två godkännare (FYRA-2)', async () => {
    const c = await registerCustomer(app);
    const a = await session('superadmin');
    await createAdmin('platform_owner'); // andra godkännare finns
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: a.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    const self = await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/approve`, cookie: a.cookie, payload: {} });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await pool.query('select status from workspaces where id = $1', [c.workspaceId])).rows[0].status).toBe('Active');
  });

  it('superadmin utan andra godkännare nekas självgodkännande, ensam Platform Owner tillåts och flaggas (FYRA-5)', async () => {
    const c = await registerCustomer(app);
    const sa = await session('superadmin'); // enda godkännare utöver ingen annan: superadmin är inte owner
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: sa.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    expect((await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/approve`, cookie: sa.cookie, payload: {} })).statusCode).toBe(403);

    await resetDb();
    const c2 = await registerCustomer(app);
    const owner = await session('platform_owner'); // ensam godkännare
    const r2 = await adminCall(app, { method: 'POST', url: `/workspaces/${c2.workspaceId}/close`, cookie: owner.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    const ok = await adminCall(app, { method: 'POST', url: `/approvals/${r2.json().approvalId}/approve`, cookie: owner.cookie, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().selfApproved).toBe(true);
    const rows = await auditRows(`self_approved = true`);
    expect(rows.map((x) => x.action).sort()).toEqual(['approval.approved', 'workspace.close']);
    const dash = (await adminCall(app, { method: 'GET', url: '/dashboard', cookie: owner.cookie })).json();
    expect(dash.selfApprovedLast30d).toBe(1);
  });

  it('självgodkännande kan stängas av i inställningarna', async () => {
    await pool.query(`update platform_settings set value = 'false' where key = 'security.allow_sole_owner_self_approval'`);
    try {
      const c = await registerCustomer(app);
      const owner = await session('platform_owner');
      const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: owner.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
      expect((await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/approve`, cookie: owner.cookie, payload: {} })).statusCode).toBe(403);
    } finally {
      await pool.query(`update platform_settings set value = 'true' where key = 'security.allow_sole_owner_self_approval'`);
    }
  });

  it('godkännare kräver approvals.decide och nylig MFA: support och billing nekas', async () => {
    const c = await registerCustomer(app);
    const req = await session('superadmin');
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: req.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    for (const role of ['support_admin', 'billing_admin', 'technical_admin', 'readonly_admin'] as Role[]) {
      const s = await session(role);
      expect((await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/approve`, cookie: s.cookie, payload: {} })).statusCode, role).toBe(403);
    }
    const owner = await session('platform_owner');
    await pool.query(`update platform_admin_sessions set reauth_at = now() - interval '10 minutes' where admin_id = $1`, [owner.admin.id]);
    const stale = await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/approve`, cookie: owner.cookie, payload: {} });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('REAUTH_REQUIRED');
  });

  it('avslag utför ingenting', async () => {
    const c = await registerCustomer(app);
    const req = await session('superadmin');
    const owner = await session('platform_owner');
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: req.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    const rej = await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/reject`, cookie: owner.cookie, payload: { reason: 'Underlag saknas' } });
    expect(rej.json().status).toBe('rejected');
    expect((await pool.query('select status from workspaces where id = $1', [c.workspaceId])).rows[0].status).toBe('Active');
    expect((await auditRows(`action = 'approval.rejected'`)).length).toBe(1);
  });

  it('begäran förfaller efter 72 timmar och kan då inte godkännas', async () => {
    const c = await registerCustomer(app);
    const req = await session('superadmin');
    const owner = await session('platform_owner');
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: req.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    await pool.query(`update approval_requests set expires_at = now() - interval '1 second'`);
    const res = await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/approve`, cookie: owner.cookie, payload: {} });
    expect(res.statusCode).toBe(409);
    expect((await pool.query('select status from workspaces where id = $1', [c.workspaceId])).rows[0].status).toBe('Active');
    expect((await pool.query('select status from approval_requests')).rows[0].status).toBe('expired');
  });

  it('endast beställaren och godkännare ser begäranden i listan', async () => {
    const c = await registerCustomer(app);
    const req = await session('superadmin');
    await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: req.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    const owner = await session('platform_owner');
    const tech = await session('technical_admin');
    expect((await adminCall(app, { method: 'GET', url: '/approvals', cookie: owner.cookie })).json().items).toHaveLength(1);
    expect((await adminCall(app, { method: 'GET', url: '/approvals', cookie: req.cookie })).json().items).toHaveLength(1);
    expect((await adminCall(app, { method: 'GET', url: '/approvals', cookie: tech.cookie })).json().items).toHaveLength(0);
  });

  it('borttagning av användare: begäran, godkännande, anonymisering av personuppgifter', async () => {
    const owner = await registerCustomer(app);
    await custCall(app, { method: 'POST', url: `/workspaces/${owner.workspaceId}/members`, cookie: owner.cookie, payload: { email: 'medlem@example.test', name: 'Mia Medlem' } });
    const member = (await pool.query(`select id from users where email = 'medlem@example.test'`)).rows[0].id;
    const req = await session('superadmin');
    const apr = await session('platform_owner');
    const r = await adminCall(app, { method: 'POST', url: `/users/${member}/delete`, cookie: req.cookie, payload: { reason: 'Registrerad begäran om radering (GDPR)' } });
    expect(r.statusCode).toBe(202);
    expect((await pool.query('select name from users where id = $1', [member])).rows[0].name).toBe('Mia Medlem');
    expect((await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/approve`, cookie: apr.cookie, payload: {} })).statusCode).toBe(200);
    const u = (await pool.query('select name, email, phone, password_hash, status from users where id = $1', [member])).rows[0];
    expect(u).toMatchObject({ name: 'Raderad användare', phone: null, password_hash: null, status: 'deleted' });
    expect(u.email).toBe(`deleted+${member}@invalid`);
    expect((await pool.query('select 1 from workspace_members where user_id = $1', [member])).rowCount).toBe(0);
    const row = (await auditRows(`action = 'user.delete'`))[0]!;
    expect(JSON.stringify(row)).not.toContain('Mia');
    expect(JSON.stringify(row)).not.toContain('medlem@example.test');
  });

  it('ensam ägare kan inte tas bort: åtgärden misslyckas säkert och begäran markeras failed', async () => {
    const owner = await registerCustomer(app);
    const req = await session('superadmin');
    const apr = await session('platform_owner');
    const r = await adminCall(app, { method: 'POST', url: `/users/${owner.userId}/delete`, cookie: req.cookie, payload: { reason: 'Registrerad begäran om radering (GDPR)' } });
    const res = await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/approve`, cookie: apr.cookie, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EXECUTION_FAILED');
    expect((await pool.query('select status from users where id = $1', [owner.userId])).rows[0].status).toBe('active');
    expect((await pool.query('select status from approval_requests where id = $1', [r.json().approvalId])).rows[0].status).toBe('failed');
  });
});

describe('produktlicenser och abonnemang (SA-ENT, SA-SUB-BASIC)', () => {
  it('inaktivera en produkt raderar ingen data och går att återaktivera (KRAV-S1, ARK-2)', async () => {
    const c = await registerCustomer(app, { products: ['association_portal', 'tournament_system'] });
    const { cookie } = await session('superadmin');
    const url = `/workspaces/${c.workspaceId}/entitlements/tournament_system`;
    const off = await adminCall(app, { method: 'POST', url, cookie, payload: { reason: REASON, action: 'disable' } });
    expect(off.statusCode).toBe(200);
    const prods = off.json().access.products;
    expect(prods.find((p: any) => p.product === 'tournament_system').mode).toBe('none');
    expect(prods.find((p: any) => p.product === 'association_portal').mode).toBe('full'); // den andra produkten påverkas inte
    expect((await pool.query(`select count(*)::int as n from product_entitlements where workspace_id = $1`, [c.workspaceId])).rows[0].n).toBe(2); // raden finns kvar
    const on = await adminCall(app, { method: 'POST', url, cookie, payload: { reason: REASON, action: 'enable' } });
    expect(on.json().access.products.find((p: any) => p.product === 'tournament_system').mode).toBe('full');
    expect((await auditRows(`action like 'entitlement.%'`)).map((r) => r.action)).toEqual(['entitlement.disable', 'entitlement.enable']);
  });

  it('suspend ger skrivskyddat läge och gränsändring ger LimitExceeded som återgår', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('superadmin');
    const url = `/workspaces/${c.workspaceId}/entitlements/association_portal`;
    const s = await adminCall(app, { method: 'POST', url, cookie, payload: { reason: REASON, action: 'suspend' } });
    expect(s.json().access.products[0].mode).toBe('read_only');
    await adminCall(app, { method: 'POST', url, cookie, payload: { reason: REASON, action: 'enable' } });
    await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: 'a@example.test', name: 'A' } });
    await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: 'b@example.test', name: 'B' } });
    const lim = await adminCall(app, { method: 'POST', url, cookie, payload: { reason: REASON, action: 'set_limits', limits: { max_users: 1 } } });
    expect(lim.json().access.products[0].entitlementStatus).toBe('LimitExceeded');
    expect(lim.json().access.products[0].mode).toBe('limited');
    const raise = await adminCall(app, { method: 'POST', url, cookie, payload: { reason: REASON, action: 'set_limits', limits: { max_users: 50 } } });
    expect(raise.json().access.products[0].entitlementStatus).toBe('Enabled');
  });

  it('LimitExceeded blockerar skapande men tillåter läsning (ENT-2)', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('superadmin');
    await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: 'a@example.test', name: 'A' } });
    await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/entitlements/association_portal`, cookie, payload: { reason: REASON, action: 'set_limits', limits: { max_users: 1 } } });
    const add = await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: 'c@example.test', name: 'C' } });
    expect(add.statusCode).toBe(409);
    expect(add.json().error.code).toBe('LIMIT_EXCEEDED');
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie })).statusCode).toBe(200);
  });

  it('tillfällig åtkomst med utgångsdatum', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('superadmin');
    await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/entitlements/tournament_system`, cookie, payload: { reason: REASON, action: 'enable', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } });
    const mode = async () => (await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/products/tournament_system/access`, cookie: c.cookie })).json().mode;
    expect(await mode()).toBe('full');
    await pool.query(`update product_entitlements set expires_at = now() - interval '1 second' where product = 'tournament_system'`);
    expect(await mode()).toBe('none');
  });

  it('abonnemangsövergångar följer statusmaskinen och otillåtna nekas med 409', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('billing_admin');
    const act = (payload: Record<string, unknown>) => adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/subscription`, cookie, payload: { reason: REASON, ...payload } });
    expect((await act({ action: 'mark_past_due' })).statusCode).toBe(409); // Trialing -> PastDue otillåtet
    expect((await act({ action: 'activate' })).statusCode).toBe(400); // plan krävs
    expect((await act({ action: 'activate', planId: 'trial' })).statusCode).toBe(400); // provplan ej betalplan
    const a = await act({ action: 'activate', planId: 'standard' });
    expect(a.json().status).toBe('Active');
    expect((await act({ action: 'mark_past_due' })).json().status).toBe('PastDue');
    expect((await act({ action: 'pause' })).json().status).toBe('Paused');
    expect((await act({ action: 'pause' })).statusCode).toBe(409);
    expect((await act({ action: 'resume' })).json().status).toBe('Active');
    expect((await act({ action: 'cancel_at_period_end' })).json().status).toBe('CanceledAtPeriodEnd');
    expect((await act({ action: 'undo_cancel' })).json().status).toBe('Active');
    expect((await act({ action: 'expire' })).json().status).toBe('Expired');
    expect((await act({ action: 'mark_past_due' })).statusCode).toBe(409);
    expect((await act({ action: 'extend_trial', days: 14 })).json().status).toBe('Trialing');
    const rows = await auditRows(`action like 'subscription.%'`);
    expect(rows.length).toBe(8); // activate, past_due, pause, resume, cancel, undo_cancel, expire, extend_trial
    expect(rows[0]!.before.status).toBe('Trialing');
  });

  it('PastDue: full åtkomst under respiten och skrivskyddat efter, med konfigurerbar respitperiod', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('billing_admin');
    await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/subscription`, cookie, payload: { reason: REASON, action: 'activate', planId: 'standard' } });
    await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/subscription`, cookie, payload: { reason: REASON, action: 'mark_past_due' } });
    const mode = async () => (await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/products/association_portal/access`, cookie: c.cookie })).json().mode;
    expect(await mode()).toBe('full');
    await pool.query(`update subscriptions set past_due_since = now() - interval '13 days' where workspace_id = $1`, [c.workspaceId]);
    expect(await mode()).toBe('full');
    await pool.query(`update subscriptions set past_due_since = now() - interval '15 days' where workspace_id = $1`, [c.workspaceId]);
    expect(await mode()).toBe('read_only');
    expect((await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/members`, cookie: c.cookie, payload: { email: 'x@example.test', name: 'X' } })).statusCode).toBe(403);
    await pool.query(`update platform_settings set value = '30' where key = 'billing.grace_period_days'`);
    try { expect(await mode()).toBe('full'); } finally { await pool.query(`update platform_settings set value = '14' where key = 'billing.grace_period_days'`); }
  });

  it('förlängd provperiod: återaktiverar utgången trial och loggar före/efter', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update subscriptions set trial_ends_at = now() - interval '2 days' where workspace_id = $1`, [c.workspaceId]);
    const { cookie } = await session('superadmin');
    const mode = async () => (await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/products/association_portal/access`, cookie: c.cookie })).json().mode;
    expect(await mode()).toBe('none');
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/subscription`, cookie, payload: { reason: REASON, action: 'extend_trial', days: 14 } });
    expect(r.json().status).toBe('Trialing');
    expect(await mode()).toBe('full');
    const left = (await pool.query(`select extract(epoch from (trial_ends_at - now()))/86400 as d from subscriptions where workspace_id = $1`, [c.workspaceId])).rows[0].d;
    expect(Number(left)).toBeGreaterThan(11.9);
    expect(Number(left)).toBeLessThan(14.1);
    expect((await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/subscription`, cookie, payload: { reason: REASON, action: 'extend_trial', days: 31 } })).statusCode).toBe(400);
  });

  it('återaktivera avslutad arbetsyta bara inom retentionstiden', async () => {
    const c = await registerCustomer(app);
    const req = await session('superadmin');
    const owner = await session('platform_owner');
    const r = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: req.cookie, payload: { reason: 'Kunden har begärt uppsägning skriftligen' } });
    await adminCall(app, { method: 'POST', url: `/approvals/${r.json().approvalId}/approve`, cookie: owner.cookie, payload: {} });
    await pool.query(`update workspaces set closed_at = now() - interval '91 days' where id = $1`, [c.workspaceId]);
    const late = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/reactivate`, cookie: req.cookie, payload: { reason: 'Kunden vill komma tillbaka' } });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('RETENTION_EXPIRED');
    await pool.query(`update workspaces set closed_at = now() - interval '30 days' where id = $1`, [c.workspaceId]);
    const ok = await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/reactivate`, cookie: req.cookie, payload: { reason: 'Kunden vill komma tillbaka' } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('supportärenden (SA-SUP)', () => {
  it('skapa, ändra status via tillåtna övergångar, kommentera internt och koppla till kund', async () => {
    const c = await registerCustomer(app);
    const { cookie } = await session('support_admin');
    const created = await adminCall(app, { method: 'POST', url: '/support/cases', cookie, payload: { subject: 'Kan inte logga in', category: 'account_login', priority: 'high', workspaceId: c.workspaceId, userId: c.userId } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().number).toBe(1);
    const patch = (payload: unknown) => adminCall(app, { method: 'PATCH', url: `/support/cases/${id}`, cookie, payload });
    expect((await patch({ status: 'Closed' })).statusCode).toBe(409);
    expect((await patch({ status: 'InProgress' })).statusCode).toBe(200);
    expect((await patch({ status: 'WaitingCustomer' })).statusCode).toBe(200);
    expect((await patch({ status: 'Resolved' })).statusCode).toBe(200);
    expect((await patch({ status: 'Closed' })).statusCode).toBe(200);
    expect((await patch({ status: 'InProgress' })).statusCode).toBe(200); // kan öppnas igen
    const cm = await adminCall(app, { method: 'POST', url: `/support/cases/${id}/comments`, cookie, payload: { body: 'Internt: kontrollerat loggar', internal: true } });
    expect(cm.statusCode).toBe(201);
    const detail = (await adminCall(app, { method: 'GET', url: `/support/cases/${id}`, cookie })).json();
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0].internal).toBe(true);
    expect(detail.case.workspaceName).toBeTruthy();
    // visas i kundens detaljvy och användarens detaljvy
    expect((await adminCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}`, cookie })).json().cases).toHaveLength(1);
    expect((await adminCall(app, { method: 'GET', url: `/users/${c.userId}`, cookie })).json().cases).toHaveLength(1);
    // kundsynligt svar köar e-post till ärendets användare och flyttar ärendet till "Väntar på kund"
    const rep = await adminCall(app, { method: 'POST', url: `/support/cases/${id}/comments`, cookie, payload: { body: 'Hej kund', internal: false } });
    expect(rep.statusCode).toBe(201);
    const mail = (await pool.query(`select to_email, subject from notification_outbox where template = 'support_reply'`)).rows;
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toContain(`#${detail.case.number}`);
    expect((await adminCall(app, { method: 'GET', url: `/support/cases/${id}`, cookie })).json().case.status).toBe('WaitingCustomer');
  });

  it('listfilter: öppna, prioritet, kategori, fritext, mina', async () => {
    const { admin, cookie } = await session('support_admin');
    const mk = (subject: string, extra: Record<string, unknown> = {}) => adminCall(app, { method: 'POST', url: '/support/cases', cookie, payload: { subject, ...extra } });
    await mk('Betalning dubbel', { category: 'payments', priority: 'critical' });
    await mk('Fråga om export', { category: 'other', priority: 'low' });
    const r = await mk('Fel i ranking', { category: 'results_scoring' });
    await adminCall(app, { method: 'PATCH', url: `/support/cases/${r.json().id}`, cookie, payload: { status: 'InProgress' } });
    await adminCall(app, { method: 'PATCH', url: `/support/cases/${r.json().id}`, cookie, payload: { status: 'Resolved' } });
    const l = async (qs: string) => (await adminCall(app, { method: 'GET', url: `/support/cases?${qs}`, cookie })).json();
    expect((await l('open=true')).total).toBe(2);
    expect((await l('priority=critical')).items[0].subject).toBe('Betalning dubbel');
    expect((await l('category=results_scoring')).total).toBe(1);
    expect((await l('q=export')).total).toBe(1);
    expect((await l('assignedTo=me')).total).toBe(3);
    expect((await l('')).items[0].priority).toBe('critical'); // sorterat på prioritet
    void admin;
  });
});
