import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { pool, tx } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import { dummyVerify, hashPassword, randomToken, sha256Hex, verifyPassword } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { assertStrongPassword } from '../../lib/passwords.js';
import { rateLimit } from '../../lib/ratelimit.js';
import { camel, camelAll } from '../../lib/camel.js';
import { clientInfo } from '../context.js';
import { evaluateLimits, loadWorkspaceAccess, workspaceMaxUsers } from '../../services/access.js';
import { enqueueEmail, notifyWorkspaceAdmins } from '../../services/outbox.js';
import { audit } from '../../services/audit.js';
import { ASSISTED_ACTIONS, ASSISTED_LABELS } from '../../services/assisted.js';
import { getSetting } from '../../services/settings.js';
import { associationRoutes, importRoutes } from './association.js';
import { newsRoutes } from './news.js';
import { eventRoutes } from './events.js';
import { tournamentRoutes } from './tournaments.js';
import { billingRoutes } from './billing.js';
import { mailingRoutes, unsubscribeRoutes } from './mailings.js';
import { publicPageAdminRoutes, publicPageRoutes } from './publicPage.js';
import { canWrite, workspaceAccess, subscriptionAccess } from '../../domain/access.js';

export const CUSTOMER_COOKIE = 'cust_session';
const CSRF = 'platform-customer';
const BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:5174';
const uuid = z.string().uuid();
const product = z.enum(['association_portal', 'tournament_system']);

function csrf(req: FastifyRequest): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers['x-requested-with'] !== CSRF) throw forbidden('Förfrågan saknar obligatorisk säkerhetsrubrik.', 'CSRF_HEADER_MISSING');
}

async function loadSession(req: FastifyRequest): Promise<void> {
  const token = req.cookies[CUSTOMER_COOKIE];
  if (!token) throw unauthorized();
  const { rows } = await pool.query<{ id: string; user_id: string; email: string; name: string; status: string }>(
    `select s.id, s.user_id, u.email, u.name, u.status from user_sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`, [sha256Hex(token)]);
  const r = rows[0];
  if (!r || r.status !== 'active') throw unauthorized('Sessionen har gått ut. Logga in igen.', 'SESSION_REQUIRED');
  await pool.query('update user_sessions set last_seen_at = now() where id = $1', [r.id]);
  req.customer = { sessionId: r.id, userId: r.user_id, email: r.email, name: r.name };
  req.errCtx.userId = r.user_id;
}

const authed = async (req: FastifyRequest): Promise<void> => { csrf(req); await loadSession(req); };

/** Tenant-isolering (SEC-14): arbetsytan slås upp via den inloggades medlemskap. Icke-medlemmar får 404, inte 403. */
async function requireMember(req: FastifyRequest, workspaceId: string, roles?: Array<'owner' | 'admin' | 'member'>): Promise<'owner' | 'admin' | 'member'> {
  const r = (await pool.query<{ role: 'owner' | 'admin' | 'member' }>(
    'select role from workspace_members where workspace_id = $1 and user_id = $2', [workspaceId, req.customer!.userId])).rows[0];
  if (!r) throw notFound('Arbetsytan hittades inte.');
  req.errCtx.workspaceId = workspaceId;
  if (roles && !roles.includes(r.role)) throw forbidden('Endast arbetsytans administratörer kan göra detta.');
  return r.role;
}

async function startSession(reply: FastifyReply, req: FastifyRequest, userId: string): Promise<void> {
  const token = randomToken();
  const c = clientInfo(req);
  await pool.query(
    `insert into user_sessions (user_id, token_hash, expires_at, ip, user_agent) values ($1,$2, now() + make_interval(days => $3), $4, $5)`,
    [userId, sha256Hex(token), config.customer.sessionDays, c.ip, c.userAgent]);
  reply.setCookie(CUSTOMER_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: config.secureCookies, path: '/api/v1', maxAge: config.customer.sessionDays * 86_400,
  });
}

async function makeToken(db: Db, userId: string, kind: 'password_reset' | 'email_verify' | 'invite', minutes: number, workspaceId?: string): Promise<string> {
  const token = randomToken();
  await db.query(`update user_tokens set used_at = now() where user_id = $1 and kind = $2 and used_at is null`, [userId, kind]);
  await db.query(`insert into user_tokens (user_id, kind, token_hash, workspace_id, expires_at) values ($1,$2,$3,$4, now() + make_interval(mins => $5))`,
    [userId, kind, sha256Hex(token), workspaceId ?? null, minutes]);
  return token;
}

async function useToken(db: Db, token: string, kind: string): Promise<{ user_id: string; workspace_id: string | null }> {
  const r = await db.query<{ user_id: string; workspace_id: string | null }>(
    `update user_tokens set used_at = now() where token_hash = $1 and kind = $2 and used_at is null and expires_at > now() returning user_id, workspace_id`,
    [sha256Hex(token), kind]);
  if (!r.rows[0]) throw badRequest('INVALID_TOKEN', 'Länken är ogiltig eller har gått ut.');
  return r.rows[0];
}

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  // ---------- Konto ----------
  app.post('/auth/register', async (req, reply) => {
    csrf(req);
    rateLimit(`register:${req.ip}`);
    const b = z.object({
      email: z.string().trim().email().max(200), password: z.string().max(200), name: z.string().trim().min(1).max(200),
      workspaceName: z.string().trim().min(1).max(200), kind: z.enum(['association', 'organizer', 'other']).default('association'),
      orgNumber: z.string().trim().max(30).optional(), country: z.string().length(2).toUpperCase().default('SE'),
      products: z.array(product).min(1).max(2), acceptTerms: z.literal(true, { message: 'Du måste godkänna villkoren och personuppgiftsbiträdesavtalet' }),
    }).parse(req.body);
    assertStrongPassword(b.password, 10);
    const hash = await hashPassword(b.password);
    const out = await tx(async (c) => {
      let userId: string;
      try {
        userId = (await c.query<{ id: string }>('insert into users (email, name, password_hash) values ($1,$2,$3) returning id', [b.email, b.name, hash])).rows[0]!.id;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('EMAIL_TAKEN', 'E-postadressen används redan.');
        throw e;
      }
      const wsId = (await c.query<{ id: string }>(
        `insert into workspaces (name, kind, org_number, country, contact_name, contact_email, terms_version, dpa_version, terms_accepted_at)
         values ($1,$2,$3,$4,$5,$6,'v1','v1',now()) returning id`, [b.workspaceName, b.kind, b.orgNumber ?? null, b.country, b.name, b.email])).rows[0]!.id;
      await c.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')`, [wsId, userId]);
      const days = await getSetting<number>(c, 'trial.default_days');
      await c.query(`insert into subscriptions (workspace_id, plan_id, status, trial_ends_at) values ($1,'trial','Trialing', now() + make_interval(days => $2))`, [wsId, days]);
      for (const p of b.products) await c.query(`insert into product_entitlements (workspace_id, product, status, source) values ($1,$2,'Enabled','trial')`, [wsId, p]);
      const token = await makeToken(c, userId, 'email_verify', 60 * 24);
      await enqueueEmail(c, { workspaceId: wsId, userId, to: b.email, template: 'email_verify', subject: 'Verifiera din e-postadress', body: `Välkommen! Bekräfta din e-postadress: ${BASE_URL}/verify-email?token=${token}` });
      return { userId, workspaceId: wsId };
    });
    await startSession(reply, req, out.userId);
    return reply.status(201).send(out);
  });

  app.post('/auth/login', async (req, reply) => {
    csrf(req);
    rateLimit(`login:${req.ip}`);
    const b = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(req.body);
    const c = clientInfo(req);
    const u = (await pool.query<{ id: string; password_hash: string | null; status: string; locked_until: Date | null; failed_login_count: number }>(
      'select id, password_hash, status, locked_until, failed_login_count from users where lower(email) = lower($1)', [b.email])).rows[0];
    const fail = async (reasonCode: string) => {
      await pool.query(`insert into login_history (subject_type, subject_id, email_attempted, success, reason, ip, user_agent) values ('user',$1,$2,false,$3,$4,$5)`, [u?.id ?? null, b.email.slice(0, 200), reasonCode, c.ip, c.userAgent]);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Felaktiga inloggningsuppgifter.');
    };
    if (!u) { await dummyVerify(b.password); return fail('unknown_account'); }
    const ok = await verifyPassword(b.password, u.password_hash);
    if (u.status !== 'active') return fail(u.status === 'locked' ? 'locked_by_admin' : 'deleted');
    if (u.locked_until && u.locked_until > new Date()) return fail('temporarily_locked');
    if (!ok) {
      await pool.query(`update users set failed_login_count = failed_login_count + 1,
          locked_until = case when failed_login_count + 1 >= 10 then now() + interval '15 minutes' else locked_until end where id = $1`, [u.id]);
      return fail('bad_password');
    }
    await pool.query('update users set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1', [u.id]);
    await pool.query(`insert into login_history (subject_type, subject_id, email_attempted, success, reason, ip, user_agent) values ('user',$1,$2,true,'login',$3,$4)`, [u.id, b.email.slice(0, 200), c.ip, c.userAgent]);
    await startSession(reply, req, u.id);
    return { ok: true };
  });

  app.post('/auth/logout', { preHandler: authed }, async (req, reply) => {
    await pool.query('update user_sessions set revoked_at = now() where id = $1', [req.customer!.sessionId]);
    reply.clearCookie(CUSTOMER_COOKIE, { path: '/api/v1' });
    return { ok: true };
  });

  app.post('/auth/forgot-password', async (req) => {
    csrf(req);
    rateLimit(`forgot:${req.ip}`);
    const b = z.object({ email: z.string().email().max(200) }).parse(req.body);
    const u = (await pool.query<{ id: string; name: string; email: string }>(`select id, name, email from users where lower(email) = lower($1) and status = 'active'`, [b.email])).rows[0];
    if (u) {
      await tx(async (c) => {
        const t = await makeToken(c, u.id, 'password_reset', 60);
        await enqueueEmail(c, { userId: u.id, to: u.email, template: 'password_reset', subject: 'Återställ ditt lösenord', body: `Hej ${u.name}! Välj ett nytt lösenord (gäller i 60 minuter): ${BASE_URL}/reset-password?token=${t}` });
      });
    }
    return { ok: true }; // samma svar oavsett om kontot finns
  });

  app.post('/auth/reset-password', async (req) => {
    csrf(req);
    rateLimit(`reset:${req.ip}`);
    const b = z.object({ token: z.string().min(10).max(200), password: z.string().max(200) }).parse(req.body);
    assertStrongPassword(b.password, 10);
    const hash = await hashPassword(b.password);
    await tx(async (c) => {
      const t = await useToken(c, b.token, 'password_reset');
      await c.query(`update users set password_hash = $2, failed_login_count = 0, locked_until = null, updated_at = now() where id = $1 and status <> 'deleted'`, [t.user_id, hash]);
      await c.query('update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [t.user_id]); // gamla sessioner ogiltigförklaras
    });
    return { ok: true };
  });

  app.post('/auth/verify-email', async (req) => {
    csrf(req);
    const b = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
    await tx(async (c) => {
      const t = await useToken(c, b.token, 'email_verify');
      await c.query('update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1', [t.user_id]);
    });
    return { ok: true };
  });

  app.post('/auth/accept-invite', async (req, reply) => {
    csrf(req);
    rateLimit(`invite:${req.ip}`);
    const b = z.object({ token: z.string().min(10).max(200), password: z.string().max(200), name: z.string().trim().min(1).max(200).optional() }).parse(req.body);
    assertStrongPassword(b.password, 10);
    const hash = await hashPassword(b.password);
    const userId = await tx(async (c) => {
      const t = await useToken(c, b.token, 'invite');
      await c.query(`update users set password_hash = $2, name = coalesce($3, name), email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1 and password_hash is null`, [t.user_id, hash, b.name ?? null]);
      return t.user_id;
    });
    await startSession(reply, req, userId);
    return { ok: true };
  });

  app.get('/me', { preHandler: authed }, async (req) => {
    const ws = (await pool.query(
      `select w.id, w.name, w.status, m.role from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = $1 order by w.name`, [req.customer!.userId])).rows;
    const workspaces = [];
    for (const w of ws) {
      const a = await loadWorkspaceAccess(pool, w.id);
      workspaces.push({ ...camel(w), subscription: a?.subscription, products: a?.products.map((p) => ({ product: p.product, mode: p.mode, status: p.entitlementStatus })) });
    }
    return { user: { id: req.customer!.userId, email: req.customer!.email, name: req.customer!.name }, workspaces };
  });

  // ---------- Arbetsyta (alla rutter är tenant-isolerade via medlemskap) ----------
  app.get('/workspaces/:wid', { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const role = await requireMember(req, wid);
    const ws = (await pool.query('select id, name, kind, country, status, created_at from workspaces where id = $1', [wid])).rows[0];
    return { workspace: camel(ws), role, access: await loadWorkspaceAccess(pool, wid) };
  });

  // Åtkomstläge för en produkt. Kundprodukterna anropar denna (eller delar logiken) vid varje skrivande operation.
  app.get('/workspaces/:wid/products/:product/access', { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, product }).parse(req.params);
    await requireMember(req, p.wid);
    const a = await loadWorkspaceAccess(pool, p.wid);
    const prod = a?.products.find((x) => x.product === p.product);
    return { product: p.product, mode: prod?.mode ?? 'none', limits: prod?.limits ?? {}, usage: prod?.usage ?? {}, entitlementStatus: prod?.entitlementStatus ?? null };
  });

  app.get('/workspaces/:wid/members', { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    await requireMember(req, wid);
    return { items: camelAll((await pool.query(
      `select u.id as user_id, u.name, u.email, m.role, (u.password_hash is not null) as activated from workspace_members m join users u on u.id = m.user_id
        where m.workspace_id = $1 order by lower(u.name)`, [wid])).rows) };
  });

  app.post('/workspaces/:wid/members', { preHandler: authed }, async (req, reply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = z.object({ email: z.string().trim().email().max(200), name: z.string().trim().min(1).max(200), role: z.enum(['admin', 'member']).default('member') }).parse(req.body);
    await requireMember(req, wid, ['owner', 'admin']);
    const res = await tx(async (c) => {
      await c.query('select id from workspaces where id = $1 for update', [wid]); // serialiserar gränskontroll per arbetsyta
      const a = await loadWorkspaceAccess(c, wid);
      if (!a) throw notFound();
      const writable = canWrite(workspaceAccess(a.workspaceStatus)) && a.subscription
        ? subscriptionAccess({ status: a.subscription.status, trialEndsAt: a.subscription.trialEndsAt, currentPeriodEnd: a.subscription.currentPeriodEnd, pastDueSince: a.subscription.pastDueSince, graceDays: await getSetting<number>(c, 'billing.grace_period_days') }, new Date())
        : 'none';
      if (writable !== 'full') throw forbidden('Arbetsytan är skrivskyddad eller har inget aktivt abonnemang.', 'WORKSPACE_READ_ONLY');
      const max = workspaceMaxUsers(a);
      const used = a.products[0]?.usage.max_users ?? 0;
      if (max !== null && used + 1 > max) {
        throw conflict('LIMIT_EXCEEDED', `Gränsen för antal användare (${max}) är nådd. Uppgradera abonnemanget eller ta bort en användare.`, { limit: 'max_users', max, used });
      }
      let user = (await c.query<{ id: string; password_hash: string | null; status: string }>('select id, password_hash, status from users where lower(email) = lower($1)', [b.email])).rows[0];
      if (user?.status === 'deleted') throw conflict('USER_UNAVAILABLE', 'Användaren kan inte läggas till.');
      if (!user) user = (await c.query<{ id: string; password_hash: string | null; status: string }>('insert into users (email, name) values ($1,$2) returning id, password_hash, status', [b.email, b.name])).rows[0]!;
      const exists = (await c.query('select 1 from workspace_members where workspace_id = $1 and user_id = $2', [wid, user.id])).rowCount;
      if (exists) throw conflict('ALREADY_MEMBER', 'Användaren är redan medlem i arbetsytan.');
      await c.query('insert into workspace_members (workspace_id, user_id, role) values ($1,$2,$3)', [wid, user.id, b.role]);
      if (!user.password_hash) {
        const t = await makeToken(c, user.id, 'invite', 60 * 24 * 7, wid);
        await enqueueEmail(c, { workspaceId: wid, userId: user.id, to: b.email, template: 'invite', subject: 'Du har blivit inbjuden', body: `Aktivera ditt konto: ${BASE_URL}/accept-invite?token=${t}` });
      }
      await evaluateLimits(c, wid);
      return { userId: user.id };
    });
    return reply.status(201).send(res);
  });

  // Kunden kan när som helst aktivera en produkt. Befintlig data påverkas inte (ARK-2).
  app.post('/workspaces/:wid/products/:product/activate', { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, product }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return tx(async (c) => {
      const a = await loadWorkspaceAccess(c, p.wid);
      if (!a || !a.subscription) throw notFound();
      if (a.workspaceStatus !== 'Active') throw forbidden('Arbetsytan är inte aktiv.', 'WORKSPACE_NOT_ACTIVE');
      if (a.subscription.effectiveStatus === 'Expired') throw conflict('SUBSCRIPTION_REQUIRED', 'Abonnemanget har gått ut. Förnya abonnemanget för att aktivera produkter.');
      const inPlan = (await c.query('select 1 from plan_entitlements where plan_id = $1 and product = $2', [a.subscription.planId, p.product])).rowCount;
      if (!inPlan) throw conflict('PRODUCT_NOT_IN_PLAN', 'Produkten ingår inte i din plan.');
      const cur = (await c.query('select status from product_entitlements where workspace_id = $1 and product = $2 for update', [p.wid, p.product])).rows[0];
      if (cur?.status === 'Suspended') throw conflict('SUSPENDED_BY_PLATFORM', 'Produkten är avstängd av plattformen. Kontakta supporten.');
      if (cur && cur.status !== 'Disabled') return { ok: true, alreadyActive: true };
      if (cur) await c.query(`update product_entitlements set status = 'Enabled', updated_at = now() where workspace_id = $1 and product = $2`, [p.wid, p.product]);
      else await c.query(`insert into product_entitlements (workspace_id, product, status, source) values ($1,$2,'Enabled','plan')`, [p.wid, p.product]);
      await evaluateLimits(c, p.wid);
      return { ok: true, alreadyActive: false, dataPreserved: true };
    });
  });

  app.get('/workspaces/:wid/notifications', { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    await requireMember(req, wid);
    return { items: camelAll((await pool.query('select id, kind, title, body, created_at, read_at from workspace_notifications where workspace_id = $1 order by created_at desc limit 50', [wid])).rows) };
  });

  // ---------- Kundens godkännande av supportåtkomst ----------
  app.get('/workspaces/:wid/support-grants', { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    await requireMember(req, wid, ['owner', 'admin']);
    return { items: camelAll((await pool.query(
      `select g.id, g.scope, g.allowed_actions, g.support_case_id, g.expires_at, g.revoked_at, g.created_at, u.name as granted_by_name
         from support_access_grants g left join users u on u.id = g.granted_by_user_id
        where g.workspace_id = $1 order by g.created_at desc limit 20`, [wid])).rows) };
  });

  app.post('/workspaces/:wid/support-grants', { preHandler: authed }, async (req, reply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = z.object({ hours: z.number().int().min(1).max(72).default(24) }).parse(req.body ?? {});
    await requireMember(req, wid, ['owner', 'admin']);
    const g = await tx(async (c) => {
      // Ett aktivt godkännande i taget: ersätt tidigare för att undvika otydlig giltighet
      await c.query(`update support_access_grants set revoked_at = now() where workspace_id = $1 and scope = 'personal_data' and revoked_at is null and expires_at > now()`, [wid]);
      const row = (await c.query(
        `insert into support_access_grants (workspace_id, granted_by_user_id, scope, expires_at) values ($1,$2,'personal_data', now() + make_interval(hours => $3)) returning id, expires_at`,
        [wid, req.customer!.userId, b.hours])).rows[0];
      await audit(c, { requestId: req.id }, { action: 'support.grant.created', severity: 'warning', workspaceId: wid, userId: req.customer!.userId, targetType: 'support_access_grant', targetId: row.id, meta: { hours: b.hours, by: 'customer' } });
      await notifyWorkspaceAdmins(c, wid, {
        kind: 'support_grant_created', template: 'support_grant_created', title: 'Supportpersonal får se personuppgifter',
        body: `${req.customer!.name} har godkänt att Supportpersonal får se personuppgifter i arbetsytan i ${b.hours} timmar. Godkännandet kan återkallas när som helst under Supportåtkomst.`,
      });
      return row;
    });
    return reply.status(201).send(camel(g));
  });

  // Godkännande av assisterad support: tillåtna åtgärdstyper, giltighet max 72 h, valfritt bundet till ett ärende
  app.post('/workspaces/:wid/support-grants/assisted', { preHandler: authed }, async (req, reply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = z.object({
      hours: z.number().int().min(1).max(72).default(24),
      actions: z.array(z.enum(ASSISTED_ACTIONS)).min(1),
      supportCaseNumber: z.number().int().positive().optional(),
    }).parse(req.body ?? {});
    await requireMember(req, wid, ['owner', 'admin']);
    const actions = [...new Set(b.actions)];
    const g = await tx(async (c) => {
      let caseId: string | null = null;
      if (b.supportCaseNumber) {
        const sc = (await c.query('select id, workspace_id from support_cases where number = $1', [b.supportCaseNumber])).rows[0];
        if (!sc || (sc.workspace_id && sc.workspace_id !== wid)) throw notFound('Supportärendet hittades inte.');
        caseId = sc.id;
      }
      await c.query(`update support_access_grants set revoked_at = now() where workspace_id = $1 and scope = 'assisted' and revoked_at is null and expires_at > now()`, [wid]);
      const row = (await c.query(
        `insert into support_access_grants (workspace_id, granted_by_user_id, scope, allowed_actions, support_case_id, expires_at)
         values ($1,$2,'assisted',$3,$4, now() + make_interval(hours => $5)) returning id, expires_at`,
        [wid, req.customer!.userId, actions, caseId, b.hours])).rows[0];
      await audit(c, { requestId: req.id }, { action: 'support.grant.created', severity: 'warning', workspaceId: wid, userId: req.customer!.userId, targetType: 'support_access_grant', targetId: row.id, supportCaseId: caseId, meta: { hours: b.hours, scope: 'assisted', actions, by: 'customer' } });
      await notifyWorkspaceAdmins(c, wid, {
        kind: 'support_grant_created', template: 'support_grant_created', title: 'Supportpersonal får utföra åtgärder åt er',
        body: `${req.customer!.name} har godkänt assisterad support i ${b.hours} timmar. Tillåtna åtgärder: ${actions.map((a) => ASSISTED_LABELS[a]).join('; ')}. Godkännandet kan återkallas när som helst under Supportåtkomst.`,
      });
      return row;
    });
    return reply.status(201).send(camel(g));
  });

  app.delete('/workspaces/:wid/support-grants/:gid', { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, gid: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return tx(async (c) => {
      const r = await c.query('update support_access_grants set revoked_at = now() where id = $1 and workspace_id = $2 and revoked_at is null', [p.gid, p.wid]);
      if (!r.rowCount) throw notFound('Godkännandet hittades inte.');
      // Pågående sessioner som bygger på godkännandet avslutas direkt
      const ended = await c.query(`update support_access_sessions set ended_at = now(), ended_reason = 'grant_revoked' where grant_id = $1 and ended_at is null`, [p.gid]);
      await audit(c, { requestId: req.id }, { action: 'support.grant.revoked', severity: 'warning', workspaceId: p.wid, userId: req.customer!.userId, targetType: 'support_access_grant', targetId: p.gid, meta: { sessionsEnded: ended.rowCount, by: 'customer' } });
      await notifyWorkspaceAdmins(c, p.wid, {
        kind: 'support_grant_revoked', template: 'support_grant_revoked', title: 'Godkännande för supportåtkomst återkallat',
        body: `${req.customer!.name} har återkallat ett godkännande för supportåtkomst. ${ended.rowCount ? 'Pågående supportsessioner har avslutats.' : ''}`.trim(),
      });
      return { ok: true, sessionsEnded: ended.rowCount ?? 0 };
    });
  });

  // Kundsynlig historik över supportåtkomst: vem, när, hur länge och i vilket läge
  app.get('/workspaces/:wid/support-access', { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    await requireMember(req, wid, ['owner', 'admin']);
    return { items: camelAll((await pool.query(
      `select s.id, s.mode, s.started_at, s.expires_at, s.ended_at, s.personal_data, s.actions, a.name as admin_name, c.number as case_number
         from support_access_sessions s join platform_admins a on a.id = s.admin_id join support_cases c on c.id = s.support_case_id
        where s.workspace_id = $1 order by s.started_at desc limit 50`, [wid])).rows) };
  });

  associationRoutes(app, { authed, requireMember });
  importRoutes(app, { authed, requireMember });
  newsRoutes(app, { authed, requireMember });
  eventRoutes(app, { authed, requireMember });
  tournamentRoutes(app, { authed, requireMember });
  billingRoutes(app, { authed, requireMember });
  mailingRoutes(app, { authed, requireMember });
  unsubscribeRoutes(app);
  publicPageAdminRoutes(app, { authed, requireMember });
  publicPageRoutes(app);
}
