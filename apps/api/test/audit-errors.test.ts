import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { buildApp } from '../src/http/app.js';
import { runMaintenance } from '../src/jobs/maintenance.js';
import { audit } from '../src/services/audit.js';
import { REASON, adminCall, auditRows, createAdmin, custCall, loginAdmin, registerCustomer, resetDb } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
  // Testrutter som kastar fel, för att verifiera felhantering och felloggning
  app.get('/api/v1/__boom', async (req) => {
    req.errCtx.workspaceId = String(req.headers['x-ws'] ?? '') || undefined;
    throw new Error('Anslutning misslyckades med Authorization: Bearer abcdefghijklmnopqrstuv och kort 4111 1111 1111 1111');
  });
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

describe('audit log är append-only (SEC-10)', () => {
  it('UPDATE, DELETE och TRUNCATE nekas av databasen', async () => {
    await audit(pool, {}, { action: 'test.event' });
    await expect(pool.query(`update admin_audit_log set action = 'manipulerad'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`delete from admin_audit_log`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`truncate admin_audit_log`)).rejects.toThrow(/append-only/);
    expect((await auditRows(`action = 'test.event'`)).length).toBe(1);
  });

  it('hemligheter i före/efter-data maskeras innan de lagras', async () => {
    await audit(pool, {}, { action: 'test.secret', before: { password: 'hemligt', token: 'abc', note: 'ok' }, after: { apiKey: 'k', nested: { cookie: 'c' } } });
    const r = (await auditRows(`action = 'test.secret'`))[0]!;
    expect(r.before).toEqual({ password: '[REDACTED]', token: '[REDACTED]', note: 'ok' });
    expect(r.after).toEqual({ apiKey: '[REDACTED]', nested: { cookie: '[REDACTED]' } });
  });

  it('audit-vyn kan filtreras och sidindelas, och kräver audit.view', async () => {
    const owner = await createAdmin('platform_owner');
    const oc = await loginAdmin(app, owner);
    const c = await registerCustomer(app);
    const su = await createAdmin('superadmin');
    const sc = await loginAdmin(app, su);
    await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/suspend`, cookie: sc, payload: { reason: 'Utredning av missbruk pågår' } });
    const all = (await adminCall(app, { method: 'GET', url: '/audit', cookie: oc })).json();
    expect(all.total).toBeGreaterThanOrEqual(3);
    const byAction = (await adminCall(app, { method: 'GET', url: '/audit?action=workspace.', cookie: oc })).json();
    expect(byAction.items.map((i: any) => i.action)).toEqual(['workspace.suspend']);
    expect((await adminCall(app, { method: 'GET', url: `/audit?workspaceId=${c.workspaceId}`, cookie: oc })).json().total).toBe(1);
    expect((await adminCall(app, { method: 'GET', url: `/audit?adminId=${su.id}&severity=warning`, cookie: oc })).json().total).toBe(1);
    expect((await adminCall(app, { method: 'GET', url: '/audit?q=missbruk', cookie: oc })).json().total).toBe(1);
    expect((await adminCall(app, { method: 'GET', url: '/audit?pageSize=1&page=2', cookie: oc })).json().items).toHaveLength(1);
    const support = await loginAdmin(app, await createAdmin('support_admin'));
    expect((await adminCall(app, { method: 'GET', url: '/audit', cookie: support })).statusCode).toBe(403);
  });

  it('det finns inga rutter som kan ändra eller radera audit-poster', async () => {
    const owner = await createAdmin('platform_owner');
    const oc = await loginAdmin(app, owner);
    for (const method of ['PATCH', 'POST', 'DELETE'] as const) {
      const r = await adminCall(app, { method, url: '/audit/1', cookie: oc, payload: {} });
      expect(r.statusCode).toBe(404);
    }
  });
});

describe('tekniska fel per kund och användare (SA-ERR, SEC-12)', () => {
  it('ohanterat fel ger generiskt svar med felreferens, och loggas maskerat med koppling till arbetsyta', async () => {
    const c = await registerCustomer(app);
    const r = await app.inject({ method: 'GET', url: '/api/v1/__boom', headers: { 'x-ws': c.workspaceId } });
    expect(r.statusCode).toBe(500);
    const err = r.json().error;
    expect(err.code).toBe('INTERNAL');
    expect(err.requestId).toBe(r.headers['x-request-id']);
    expect(r.body).not.toMatch(/Bearer|4111|abcdefghijkl|stack|Anslutning/); // inga interna detaljer läcker
    const row = (await pool.query('select * from system_errors where request_id = $1', [err.requestId])).rows[0];
    expect(row.workspace_id).toBe(c.workspaceId);
    expect(row.status_code).toBe(500);
    expect(row.message).not.toContain('abcdefghijklmnopqrstuv');
    expect(row.message).not.toContain('4111');
    expect(row.message).toContain('[REDACTED]');
  });

  it('fel kan sökas per arbetsyta och per referens och kräver logs.view', async () => {
    const a = await registerCustomer(app);
    const b = await registerCustomer(app);
    await app.inject({ method: 'GET', url: '/api/v1/__boom', headers: { 'x-ws': a.workspaceId } });
    await app.inject({ method: 'GET', url: '/api/v1/__boom', headers: { 'x-ws': b.workspaceId } });
    const tech = await loginAdmin(app, await createAdmin('technical_admin'));
    const list = async (qs: string) => (await adminCall(app, { method: 'GET', url: `/logs/errors?${qs}`, cookie: tech })).json();
    expect((await list('')).total).toBe(2);
    const forA = await list(`workspaceId=${a.workspaceId}`);
    expect(forA.total).toBe(1);
    expect(forA.items[0].workspaceName).toBeTruthy();
    expect((await list(`requestId=${forA.items[0].requestId}`)).total).toBe(1);
    // synligt i kunddetaljen
    const detail = (await adminCall(app, { method: 'GET', url: `/workspaces/${a.workspaceId}`, cookie: tech })).json();
    expect(detail.errors).toHaveLength(1);
    const billing = await loginAdmin(app, await createAdmin('billing_admin'));
    expect((await adminCall(app, { method: 'GET', url: '/logs/errors', cookie: billing })).statusCode).toBe(403);
  });

  it('valideringsfel och 404 är begripliga och loggas inte som tekniska fel', async () => {
    const owner = await loginAdmin(app, await createAdmin('platform_owner'));
    const bad = await adminCall(app, { method: 'GET', url: '/workspaces?page=0', cookie: owner });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    expect(bad.json().error.message).toContain('page');
    const nf = await adminCall(app, { method: 'GET', url: '/workspaces/00000000-0000-4000-8000-000000000000', cookie: owner });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.message).toBe('Arbetsytan hittades inte.');
    expect((await pool.query('select count(*)::int as n from system_errors')).rows[0].n).toBe(0);
    const malformed = await adminCall(app, { method: 'GET', url: '/workspaces/inte-ett-uuid', cookie: owner });
    expect(malformed.statusCode).toBe(400);
  });

  it('felsvar har säkerhetsrubriker och no-store', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-request-id']).toBeTruthy();
  });

  it('dashboarden visar antal fel och systemstatus, och ärligt vad som inte övervakas än', async () => {
    const c = await registerCustomer(app);
    await app.inject({ method: 'GET', url: '/api/v1/__boom', headers: { 'x-ws': c.workspaceId } });
    const tech = await loginAdmin(app, await createAdmin('technical_admin'));
    const d = (await adminCall(app, { method: 'GET', url: '/dashboard', cookie: tech })).json();
    expect(d.system.database).toBe('ok');
    expect(d.system.errors24h).toBe(1);
    expect(d.system.recentErrors).toHaveLength(1);
    expect(d.system.notYetMonitored).toContain('Bakgrundsjobb');
  });
});

describe('dashboard nyckeltal', () => {
  it('räknar kunder, produkter, abonnemang och väntande godkännanden korrekt', async () => {
    const a = await registerCustomer(app, { products: ['association_portal'] });
    const b = await registerCustomer(app, { products: ['association_portal', 'tournament_system'] });
    const c = await registerCustomer(app, { products: ['tournament_system'] });
    await pool.query(`update subscriptions set status = 'Active', plan_id = 'standard', trial_ends_at = null where workspace_id = $1`, [b.workspaceId]);
    await pool.query(`update subscriptions set status = 'PastDue', plan_id = 'start', trial_ends_at = null, past_due_since = now() where workspace_id = $1`, [c.workspaceId]);
    await pool.query(`update subscriptions set trial_ends_at = now() + interval '3 days' where workspace_id = $1`, [a.workspaceId]);
    const owner = await createAdmin('platform_owner');
    const oc = await loginAdmin(app, owner);
    const sa = await loginAdmin(app, await createAdmin('superadmin'));
    await adminCall(app, { method: 'POST', url: `/workspaces/${a.workspaceId}/close`, cookie: sa, payload: { reason: REASON } });
    const d = (await adminCall(app, { method: 'GET', url: '/dashboard', cookie: oc })).json();
    expect(d.customers).toMatchObject({ total: 3, activeWorkspaces: 3, newLast30d: 3 });
    expect(d.products).toEqual({ associationPortals: 2, tournamentSystems: 2 });
    expect(d.bothProducts).toBe(1);
    expect(d.subscriptions).toMatchObject({ trials: 1, paying: 1, pastDue: 1 });
    expect(d.expiringTrials.map((x: any) => x.workspaceId)).toEqual([a.workspaceId]);
    expect(d.pastDueList.map((x: any) => x.workspaceId)).toEqual([c.workspaceId]);
    expect(d.pendingApprovals).toBe(1);
    expect(d.activeUsers).toBe(0);
    await custCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: 'Kundlösenord-2026' } });
    expect((await adminCall(app, { method: 'GET', url: '/dashboard', cookie: oc })).json().activeUsers).toBe(1);
  });
});

describe('underhållsjobb och gallring (avsnitt 8.2)', () => {
  it('utgångna provperioder blir Expired och loggas, utan att radera data', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update subscriptions set trial_ends_at = now() - interval '1 day' where workspace_id = $1`, [c.workspaceId]);
    const r = await runMaintenance();
    expect(r.subscriptionsExpired).toBe(1);
    expect((await pool.query('select status from subscriptions where workspace_id = $1', [c.workspaceId])).rows[0].status).toBe('Expired');
    expect((await auditRows(`action = 'subscription.expired_auto'`)).length).toBe(1);
    expect((await pool.query('select count(*)::int as n from workspaces')).rows[0].n).toBe(1);
    expect((await pool.query('select count(*)::int as n from users')).rows[0].n).toBe(1);
  });

  it('gallringskandidater skapas efter retentionstiden men kunddata raderas aldrig av jobbet (GALL-1)', async () => {
    const closed = await registerCustomer(app);
    const fresh = await registerCustomer(app);
    const expired = await registerCustomer(app);
    await pool.query(`update workspaces set status = 'Closed', closed_at = now() - interval '91 days' where id = $1`, [closed.workspaceId]);
    await pool.query(`update workspaces set status = 'Closed', closed_at = now() - interval '10 days' where id = $1`, [fresh.workspaceId]);
    await pool.query(`update subscriptions set status = 'Expired', trial_ends_at = now() - interval '400 days' where workspace_id = $1`, [expired.workspaceId]);
    await pool.query(`update product_entitlements set updated_at = now() - interval '13 months' where workspace_id = $1`, [expired.workspaceId]);
    const before = {
      ws: (await pool.query('select count(*)::int as n from workspaces')).rows[0].n,
      users: (await pool.query('select count(*)::int as n from users')).rows[0].n,
      members: (await pool.query('select count(*)::int as n from workspace_members')).rows[0].n,
    };
    const r = await runMaintenance();
    expect(r.purgeCandidatesCreated).toBe(2);
    const cands = (await pool.query('select workspace_id, reason from purge_candidates order by reason')).rows;
    expect(cands).toEqual([{ workspace_id: closed.workspaceId, reason: 'closed_retention' }, { workspace_id: expired.workspaceId, reason: 'product_retention' }]);
    expect((await runMaintenance()).purgeCandidatesCreated).toBe(0); // idempotent
    expect({
      ws: (await pool.query('select count(*)::int as n from workspaces')).rows[0].n,
      users: (await pool.query('select count(*)::int as n from users')).rows[0].n,
      members: (await pool.query('select count(*)::int as n from workspace_members')).rows[0].n,
    }).toEqual(before);
  });

  it('gamla tekniska fel och inloggningshistorik rensas enligt retention, nya behålls', async () => {
    await pool.query(`insert into system_errors (at, message) values (now() - interval '91 days', 'gammal'), (now() - interval '1 day', 'ny')`);
    await pool.query(`insert into login_history (subject_type, email_attempted, success, created_at) values ('user','a@x.test',true, now() - interval '13 months'), ('user','b@x.test',true, now())`);
    const r = await runMaintenance();
    expect(r).toMatchObject({ errorsDeleted: 1, loginHistoryDeleted: 1 });
    expect((await pool.query('select message from system_errors')).rows).toEqual([{ message: 'ny' }]);
  });

  it('utgångna godkännanden markeras', async () => {
    const c = await registerCustomer(app);
    const sa = await loginAdmin(app, await createAdmin('superadmin'));
    await adminCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/close`, cookie: sa, payload: { reason: REASON } });
    await pool.query(`update approval_requests set expires_at = now() - interval '1 second'`);
    expect((await runMaintenance()).approvalsExpired).toBe(1);
  });
});
