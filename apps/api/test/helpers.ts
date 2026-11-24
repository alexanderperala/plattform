import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/pool.js';
import { buildApp } from '../src/http/app.js';
import { encryptSecret, hashPassword } from '../src/lib/crypto.js';
import { currentStep, generateTotpSecret, totpAt } from '../src/lib/totp.js';
import { resetRateLimits } from '../src/lib/ratelimit.js';
import type { Role } from '../src/domain/permissions.js';

export const PASSWORD = 'Testlösenord-2026!';

export async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/** Rensar all data utom referensdata. Audit-tabellens triggers stängs av enbart här (testmiljö). */
export async function resetDb(): Promise<void> {
  resetRateLimits();
  await pool.query('alter table admin_audit_log disable trigger user');
  await pool.query(`truncate admin_audit_log, support_access_sessions, support_access_grants, support_case_comments, support_cases, workspace_notes,
    approval_requests, platform_admin_recovery_codes, platform_admin_sessions, platform_admins, notification_outbox, workspace_notifications,
    system_errors, login_history, purge_candidates, feature_flag_overrides, product_entitlements, subscriptions, workspace_members,
    user_tokens, user_sessions, workspaces, users, invoices, billing_events restart identity cascade`);
  await pool.query('alter table admin_audit_log enable trigger user');
  // Referensdata som kan ändras via Superadmin återställs till seed-värden så testerna är oberoende
  await pool.query(`update feature_flags set default_enabled = false`);
  await pool.query(`delete from platform_settings where key in ('billing.grace_period_days','trial.default_days','retention.closed_workspace_days','retention.product_data_months','security.allow_sole_owner_self_approval')`);
  await pool.query(`insert into platform_settings (key, value) values ('billing.grace_period_days','14'),('trial.default_days','30'),('retention.closed_workspace_days','90'),('retention.product_data_months','12'),('security.allow_sole_owner_self_approval','true')`);
}

export interface TestAdmin { id: string; email: string; role: Role; secret: string }

export async function createAdmin(role: Role, opts: { mfa?: boolean; breakGlass?: boolean; name?: string } = {}): Promise<TestAdmin> {
  const secret = generateTotpSecret();
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const mfa = opts.mfa ?? true;
  const { rows } = await pool.query<{ id: string }>(
    `insert into platform_admins (email, name, role, password_hash, is_break_glass, mfa_secret_enc, mfa_enrolled_at)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [email, opts.name ?? `Admin ${role}`, role, await hashPassword(PASSWORD), opts.breakGlass ?? false, mfa ? encryptSecret(secret) : null, mfa ? new Date() : null]);
  return { id: rows[0]!.id, email, role, secret };
}

type Inject = { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: unknown; cookie?: string; headers?: Record<string, string> };

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  const c = res.cookies.find((x) => x.name === name);
  return c ? `${name}=${c.value}` : undefined;
}

export async function adminCall(app: FastifyInstance, i: Inject) {
  return app.inject({
    method: i.method, url: `/api/platform-admin${i.url}`, payload: i.payload as object | undefined,
    headers: { 'x-requested-with': 'platform-admin', ...(i.cookie ? { cookie: i.cookie } : {}), ...(i.headers ?? {}) },
  });
}

/** Fullständig inloggning (lösenord + MFA). Returnerar sessionscookie. */
export async function loginAdmin(app: FastifyInstance, a: TestAdmin): Promise<string> {
  await pool.query('update platform_admins set mfa_last_step = null, failed_count = 0, locked_until = null where id = $1', [a.id]);
  const r1 = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
  if (r1.statusCode !== 200) throw new Error(`login misslyckades: ${r1.body}`);
  const c1 = cookieFrom(r1, 'padm_session')!;
  const r2 = await adminCall(app, { method: 'POST', url: '/auth/mfa/verify', cookie: c1, payload: { code: totpAt(a.secret, currentStep()) } });
  if (r2.statusCode !== 200) throw new Error(`mfa misslyckades: ${r2.body}`);
  return cookieFrom(r2, 'padm_session')!;
}

export { cookieFrom };

export async function custCall(app: FastifyInstance, i: Inject) {
  return app.inject({
    method: i.method, url: `/api/v1${i.url}`, payload: i.payload as object | undefined,
    headers: { 'x-requested-with': 'platform-customer', ...(i.cookie ? { cookie: i.cookie } : {}), ...(i.headers ?? {}) },
  });
}

export interface TestCustomer { cookie: string; userId: string; workspaceId: string; email: string }

export async function registerCustomer(app: FastifyInstance, over: Record<string, unknown> = {}): Promise<TestCustomer> {
  const email = `kund-${randomUUID().slice(0, 8)}@example.test`;
  const res = await custCall(app, {
    method: 'POST', url: '/auth/register',
    payload: { email, password: 'Kundlösenord-2026', name: 'Kund Kundsson', workspaceName: `Förening ${email.slice(5, 9)}`, products: ['association_portal'], acceptTerms: true, ...over },
  });
  if (res.statusCode !== 201) throw new Error(`register misslyckades: ${res.body}`);
  const b = res.json() as { userId: string; workspaceId: string };
  return { cookie: cookieFrom(res, 'cust_session')!, userId: b.userId, workspaceId: b.workspaceId, email };
}

export const REASON = 'Testorsak för åtgärden i testet';

export async function setReauth(cookie: string, minutesAgo: number): Promise<void> {
  const token = cookie.split('=')[1]!;
  const { sha256Hex } = await import('../src/lib/crypto.js');
  await pool.query('update platform_admin_sessions set reauth_at = now() - make_interval(mins => $2) where token_hash = $1', [sha256Hex(token), minutesAgo]);
}

export async function auditRows(where: string, params: unknown[] = []): Promise<Array<Record<string, any>>> {
  return (await pool.query(`select * from admin_audit_log where ${where} order by id`, params)).rows;
}
