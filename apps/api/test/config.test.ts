import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { REASON, adminCall, auditRows, createAdmin, loginAdmin, makeApp, registerCustomer, resetDb, setReauth } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

const owner = async () => { const a = await createAdmin('platform_owner'); return { a, cookie: await loginAdmin(app, a) }; };

describe('funktionsflaggor', () => {
  it('listar flaggor med överstyrningar och ändrar standardvärde med orsak och audit', async () => {
    const { cookie } = await owner();
    const l = (await adminCall(app, { method: 'GET', url: '/flags', cookie })).json().items;
    const f = l.find((x: any) => x.key === 'association.forum_v2');
    expect(f.defaultEnabled).toBe(false);
    const noReason = await adminCall(app, { method: 'PATCH', url: '/flags/association.forum_v2', cookie, payload: { defaultEnabled: true } });
    expect(noReason.json().error.code).toBe('REASON_REQUIRED');
    expect((await adminCall(app, { method: 'PATCH', url: '/flags/association.forum_v2', cookie, payload: { defaultEnabled: true, reason: REASON } })).statusCode).toBe(200);
    expect((await pool.query(`select default_enabled from feature_flags where key = 'association.forum_v2'`)).rows[0].default_enabled).toBe(true);
    const log = (await auditRows(`action = 'flag.default_changed'`))[0]!;
    expect(log.before).toEqual({ defaultEnabled: false });
    expect(log.after).toEqual({ defaultEnabled: true });
    expect((await adminCall(app, { method: 'PATCH', url: '/flags/finns.inte', cookie, payload: { defaultEnabled: true, reason: REASON } })).statusCode).toBe(404);
  });

  it('sätter och tar bort överstyrning per arbetsyta, och loggar på arbetsytan', async () => {
    const { cookie } = await owner();
    const c = await registerCustomer(app);
    const url = `/workspaces/${c.workspaceId}/flags/tournament.custom_formats`;
    expect((await adminCall(app, { method: 'PUT', url, cookie, payload: { enabled: true, reason: REASON } })).statusCode).toBe(200);
    let list = (await adminCall(app, { method: 'GET', url: '/flags', cookie })).json().items.find((x: any) => x.key === 'tournament.custom_formats');
    expect(list.overrides).toHaveLength(1);
    expect(list.overrides[0]).toMatchObject({ workspaceId: c.workspaceId, enabled: true });
    expect((await adminCall(app, { method: 'PUT', url, cookie, payload: { enabled: null, reason: REASON } })).statusCode).toBe(200);
    list = (await adminCall(app, { method: 'GET', url: '/flags', cookie })).json().items.find((x: any) => x.key === 'tournament.custom_formats');
    expect(list.overrides).toHaveLength(0);
    const log = await auditRows(`action = 'flag.override_changed'`);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ workspace_id: c.workspaceId });
    expect(log[1]!.before).toEqual({ enabled: true });
    expect((await adminCall(app, { method: 'PUT', url: `/workspaces/00000000-0000-4000-8000-000000000000/flags/tournament.custom_formats`, cookie, payload: { enabled: true, reason: REASON } })).statusCode).toBe(404);
  });

  it('Technical Admin får hantera flaggor men inte inställningar; Support Admin inget av dem', async () => {
    const t = await createAdmin('technical_admin'); const tc = await loginAdmin(app, t);
    expect((await adminCall(app, { method: 'PATCH', url: '/flags/association.forum_v2', cookie: tc, payload: { defaultEnabled: true, reason: REASON } })).statusCode).toBe(200);
    expect((await adminCall(app, { method: 'GET', url: '/settings', cookie: tc })).statusCode).toBe(403);
    const s = await createAdmin('support_admin'); const sc = await loginAdmin(app, s);
    expect((await adminCall(app, { method: 'PATCH', url: '/flags/association.forum_v2', cookie: sc, payload: { defaultEnabled: false, reason: REASON } })).statusCode).toBe(403);
  });
});

describe('systeminställningar', () => {
  it('listar alla ändringsbara inställningar med standardvärden och metadata', async () => {
    const { cookie } = await owner();
    const items = (await adminCall(app, { method: 'GET', url: '/settings', cookie })).json().items;
    expect(items.map((i: any) => i.key)).toContain('billing.grace_period_days');
    expect(items.find((i: any) => i.key === 'billing.grace_period_days')).toMatchObject({ value: 14, unit: 'dagar', min: 0, max: 90 });
  });

  it('kräver orsak och färsk MFA, validerar gränser och typer och loggar före/efter', async () => {
    const { cookie } = await owner();
    const patch = (key: string, payload: unknown) => adminCall(app, { method: 'PATCH', url: `/settings/${key}`, cookie, payload });
    await setReauth(cookie, 30);
    expect((await patch('trial.default_days', { value: 21, reason: REASON })).json().error.code).toBe('REAUTH_REQUIRED');
    await setReauth(cookie, 0);
    expect((await patch('trial.default_days', { value: 21 })).json().error.code).toBe('REASON_REQUIRED');
    expect((await patch('trial.default_days', { value: 9999, reason: REASON })).statusCode).toBe(400);
    expect((await patch('trial.default_days', { value: 1.5, reason: REASON })).statusCode).toBe(400);
    expect((await patch('trial.default_days', { value: '21', reason: REASON })).statusCode).toBe(400);
    expect((await patch('security.allow_sole_owner_self_approval', { value: 1, reason: REASON })).statusCode).toBe(400);
    expect((await patch('nagot.okant', { value: 1, reason: REASON })).statusCode).toBe(404);
    expect((await patch('trial.default_days', { value: 21, reason: REASON })).statusCode).toBe(200);
    expect((await pool.query(`select value from platform_settings where key = 'trial.default_days'`)).rows[0].value).toBe(21);
    const log = (await auditRows(`action = 'settings.updated'`))[0]!;
    expect(log.before).toEqual({ value: 30 });
    expect(log.after).toEqual({ value: 21 });
    const items = (await adminCall(app, { method: 'GET', url: '/settings', cookie })).json().items;
    expect(items.find((i: any) => i.key === 'trial.default_days')).toMatchObject({ value: 21, updatedByName: expect.any(String) });
  });

  it('ändrad respitperiod används av backend (inte bara sparad)', async () => {
    const { cookie } = await owner();
    await setReauth(cookie, 0);
    await adminCall(app, { method: 'PATCH', url: '/settings/billing.grace_period_days', cookie, payload: { value: 5, reason: REASON } });
    const { getSetting } = await import('../src/services/settings.js');
    expect(await getSetting(pool, 'billing.grace_period_days')).toBe(5);
  });

  it('flaggan som varnas: avstängd självgodkännande loggas som warning', async () => {
    const { cookie } = await owner();
    await setReauth(cookie, 0);
    await adminCall(app, { method: 'PATCH', url: '/settings/security.allow_sole_owner_self_approval', cookie, payload: { value: false, reason: REASON } });
    expect((await auditRows(`action = 'settings.updated'`))[0]!.severity).toBe('warning');
  });
});
