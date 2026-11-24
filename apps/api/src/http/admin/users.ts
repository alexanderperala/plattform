import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import { hasPermission } from '../../domain/permissions.js';
import { camel, camelAll } from '../../lib/camel.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { conflict, notFound } from '../../lib/errors.js';
import { maskPhone } from '../../lib/mask.js';
import { auditCtx } from '../context.js';
import { audit } from '../../services/audit.js';
import { requestApproval } from '../../services/approvals.js';
import { enqueueEmail } from '../../services/outbox.js';
import { loadWorkspaceAccess } from '../../services/access.js';
import { adminRoute } from './guard.js';
import { likeEscape } from './workspaces.js';
import { config } from '../../config.js';

const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);
export const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:5174';

interface UserRow { id: string; email: string; name: string; status: string; password_hash: string | null; email_verified_at: Date | null }

async function getUser(id: string): Promise<UserRow> {
  const u = (await pool.query<UserRow>('select id, email, name, status, password_hash, email_verified_at from users where id = $1', [id])).rows[0];
  if (!u) throw notFound('Användaren hittades inte.');
  return u;
}

async function makeToken(c: Db, userId: string, kind: 'password_reset' | 'email_verify' | 'invite', minutes: number, workspaceId?: string): Promise<string> {
  const token = randomToken();
  await c.query(`update user_tokens set used_at = now() where user_id = $1 and kind = $2 and used_at is null`, [userId, kind]); // ersätt tidigare länkar
  await c.query(
    `insert into user_tokens (user_id, kind, token_hash, workspace_id, expires_at) values ($1,$2,$3,$4, now() + make_interval(mins => $5))`,
    [userId, kind, sha256Hex(token), workspaceId ?? null, minutes],
  );
  return token;
}

export function userRoutes(app: FastifyInstance): void {
  adminRoute(app, { method: 'GET', url: '/users', access: { perm: 'users.view' } }, async (req) => {
    const q = z.object({
      q: z.string().trim().max(200).optional(),
      workspaceId: uuid.optional(),
      status: z.enum(['active', 'locked', 'deleted']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query);
    const where: string[] = []; const p: unknown[] = [];
    const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
    if (q.q) {
      const l = add(`%${likeEscape(q.q.toLowerCase())}%`);
      const exact = add(q.q);
      where.push(`(lower(u.name) like ${l} or lower(u.email) like ${l} or u.id::text = ${exact} or coalesce(u.phone,'') like ${l}
                   or exists (select 1 from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = u.id and (lower(w.name) like ${l} or w.id::text = ${exact})))`);
    }
    if (q.workspaceId) where.push(`exists (select 1 from workspace_members m where m.user_id = u.id and m.workspace_id = ${add(q.workspaceId)})`);
    if (q.status) where.push(`u.status = ${add(q.status)}`);
    const limit = add(q.pageSize); const offset = add((q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `select u.id, u.name, u.email, u.phone, u.status, u.email_verified_at, u.last_login_at, u.created_at,
              (select count(*)::int from workspace_members m where m.user_id = u.id) as workspace_count,
              count(*) over()::int as total
         from users u ${where.length ? 'where ' + where.join(' and ') : ''}
        order by u.created_at desc, u.id limit ${limit} offset ${offset}`, p);
    const full = hasPermission(req.admin!.role, 'users.account_actions');
    const total = (rows[0] as { total?: number } | undefined)?.total ?? 0;
    const items = camelAll<Record<string, unknown>>(rows).map(({ total: _t, phone, ...r }) => ({ ...r, phone: full ? phone : maskPhone(phone as string | null) }));
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  adminRoute(app, { method: 'GET', url: '/users/:id', access: { perm: 'users.view' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    req.errCtx.userId = id;
    const row = (await pool.query(
      `select id, name, email, phone, status, email_verified_at, failed_login_count, locked_until, last_login_at, created_at,
              (password_hash is not null) as has_password from users where id = $1`, [id])).rows[0];
    if (!row) throw notFound('Användaren hittades inte.');
    const role = req.admin!.role;
    const full = hasPermission(role, 'users.account_actions');
    const user = camel<Record<string, unknown>>(row);
    user.phone = full ? user.phone : maskPhone(user.phone as string | null);
    const memberships = camelAll<{ workspaceId: string }>((await pool.query(
      `select m.workspace_id, w.name as workspace_name, w.status as workspace_status, m.role, m.created_at
         from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = $1 order by w.name`, [id])).rows);
    const access = [];
    for (const m of memberships) {
      const a = await loadWorkspaceAccess(pool, m.workspaceId);
      access.push({ workspaceId: m.workspaceId, products: a?.products.map((p) => ({ product: p.product, mode: p.mode })) ?? [] });
    }
    const history = camelAll((await pool.query(
      `select id, success, reason, ip, created_at from login_history where subject_type = 'user' and subject_id = $1 order by created_at desc limit 20`, [id])).rows);
    const out: Record<string, unknown> = { user, memberships, productAccess: access, loginHistory: history };
    if (hasPermission(role, 'support.view')) {
      out.cases = camelAll((await pool.query(
        `select id, number, subject, status, priority, created_at from support_cases where user_id = $1 order by created_at desc limit 20`, [id])).rows);
    }
    return out;
  });

  adminRoute(app, { method: 'POST', url: '/users/:id/lock', access: { perm: 'users.lock' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.userId = id;
    const u = await getUser(id);
    if (u.status === 'deleted') throw conflict('ALREADY_DELETED', 'Användaren är borttagen.');
    await tx(async (c) => {
      await c.query(`update users set status = 'locked', updated_at = now() where id = $1`, [id]);
      await c.query('update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await audit(c, auditCtx(req), { action: 'user.lock', severity: 'warning', userId: id, targetType: 'user', targetId: id, reason: b.reason, before: { status: u.status }, after: { status: 'locked' } });
    });
    return { ok: true };
  });

  adminRoute(app, { method: 'POST', url: '/users/:id/unlock', access: { perm: 'users.lock' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.userId = id;
    const u = await getUser(id);
    if (u.status !== 'locked') throw conflict('NOT_LOCKED', 'Kontot är inte låst.');
    await tx(async (c) => {
      await c.query(`update users set status = 'active', failed_login_count = 0, locked_until = null, updated_at = now() where id = $1`, [id]);
      await audit(c, auditCtx(req), { action: 'user.unlock', userId: id, targetType: 'user', targetId: id, reason: b.reason, before: { status: 'locked' }, after: { status: 'active' } });
    });
    return { ok: true };
  });

  adminRoute(app, { method: 'POST', url: '/users/:id/revoke-sessions', access: { perm: 'users.lock' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.userId = id;
    await getUser(id);
    const n = await tx(async (c) => {
      const r = await c.query('update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await audit(c, auditCtx(req), { action: 'user.sessions_revoked', severity: 'warning', userId: id, targetType: 'user', targetId: id, reason: b.reason, meta: { sessionsRevoked: r.rowCount } });
      return r.rowCount ?? 0;
    });
    return { ok: true, sessionsRevoked: n };
  });

  // Länkar skickas endast via e-post till användarens adress. De returneras aldrig till administratören (KRAV-U3).
  adminRoute(app, { method: 'POST', url: '/users/:id/reset-password', access: { perm: 'users.account_actions' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.userId = id;
    const u = await getUser(id);
    if (u.status === 'deleted') throw conflict('ALREADY_DELETED', 'Användaren är borttagen.');
    await tx(async (c) => {
      const token = await makeToken(c, id, 'password_reset', 60);
      await enqueueEmail(c, { userId: id, to: u.email, template: 'password_reset', subject: 'Återställ ditt lösenord',
        body: `Hej ${u.name}! Använd länken för att välja ett nytt lösenord. Länken gäller i 60 minuter: ${APP_BASE_URL}/reset-password?token=${token}` });
      await audit(c, auditCtx(req), { action: 'user.password_reset_initiated', userId: id, targetType: 'user', targetId: id, reason: b.reason });
    });
    return { ok: true, sentTo: 'användarens registrerade e-postadress' };
  });

  adminRoute(app, { method: 'POST', url: '/users/:id/send-verification', access: { perm: 'users.account_actions' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.userId = id;
    const u = await getUser(id);
    if (u.email_verified_at) throw conflict('ALREADY_VERIFIED', 'E-postadressen är redan verifierad.');
    await tx(async (c) => {
      const token = await makeToken(c, id, 'email_verify', 60 * 24);
      await enqueueEmail(c, { userId: id, to: u.email, template: 'email_verify', subject: 'Verifiera din e-postadress',
        body: `Hej ${u.name}! Bekräfta din e-postadress: ${APP_BASE_URL}/verify-email?token=${token}` });
      await audit(c, auditCtx(req), { action: 'user.verification_sent', userId: id, targetType: 'user', targetId: id, reason: b.reason });
    });
    return { ok: true };
  });

  adminRoute(app, { method: 'POST', url: '/users/:id/resend-invite', access: { perm: 'users.account_actions' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.userId = id;
    const u = await getUser(id);
    if (u.password_hash) throw conflict('ALREADY_ACTIVATED', 'Användaren har redan aktiverat sitt konto.');
    await tx(async (c) => {
      const token = await makeToken(c, id, 'invite', 60 * 24 * 7);
      await enqueueEmail(c, { userId: id, to: u.email, template: 'invite', subject: 'Din inbjudan',
        body: `Hej ${u.name}! Aktivera ditt konto: ${APP_BASE_URL}/accept-invite?token=${token}` });
      await audit(c, auditCtx(req), { action: 'user.invite_resent', userId: id, targetType: 'user', targetId: id, reason: b.reason });
    });
    return { ok: true };
  });

  // Borttagning kräver fyra-ögon
  adminRoute(app, { method: 'POST', url: '/users/:id/delete', access: { perm: 'users.delete' } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.userId = id;
    const u = await getUser(id);
    if (u.status === 'deleted') throw conflict('ALREADY_DELETED', 'Användaren är redan borttagen.');
    const r = await tx((c) => requestApproval(c, auditCtx(req), { action: 'user.delete', targetType: 'user', targetId: id, reason: b.reason }));
    return reply.status(202).send({ approvalRequired: true, approvalId: r.id, expiresAt: r.expiresAt });
  });
}

void config;
