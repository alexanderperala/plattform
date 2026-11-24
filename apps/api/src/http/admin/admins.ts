import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { ROLES } from '../../domain/permissions.js';
import { assertStrongPassword } from '../../lib/passwords.js';
import { camel, camelAll } from '../../lib/camel.js';
import { hashPassword, sha256Hex } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { rateLimit } from '../../lib/ratelimit.js';
import { audit } from '../../services/audit.js';
import { requestApproval } from '../../services/approvals.js';
import { disableAdmin } from '../../services/admins.js';
import { auditCtx } from '../context.js';
import { adminRoute } from './guard.js';

const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);
const role = z.enum(ROLES as unknown as [string, ...string[]]);
const accepted = (r: { id: string; expiresAt: Date }) => ({ approvalRequired: true, approvalId: r.id, expiresAt: r.expiresAt });
/** Stabilt uuid från e-post så att dubblettbegäran för samma kandidat stoppas av unikt index. */
const inviteKey = (email: string) => { const h = createHash('sha256').update(`admin-invite:${email.toLowerCase()}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

export function adminManagementRoutes(app: FastifyInstance): void {
  adminRoute(app, { method: 'GET', url: '/admins', access: { perm: 'admins.manage' } }, async () => ({
    items: camelAll((await pool.query(
      `select a.id, a.email, a.name, a.role, a.status, a.is_break_glass, a.mfa_enrolled_at, a.last_login_at, a.locked_until, a.created_at,
              (select count(*)::int from platform_admin_sessions s where s.admin_id = a.id and s.revoked_at is null and s.expires_at > now() and s.stage = 'active') as active_sessions,
              exists (select 1 from admin_setup_tokens t where t.admin_id = a.id and t.used_at is null and t.expires_at > now()) as setup_pending
         from platform_admins a order by a.is_break_glass, a.created_at`)).rows),
  }));

  adminRoute(app, { method: 'POST', url: '/admins', access: { perm: 'admins.manage' } }, async (req, reply) => {
    const b = z.object({ reason, email: z.string().email().max(200), name: z.string().trim().min(2).max(120), role }).parse(req.body);
    const exists = (await pool.query('select 1 from platform_admins where lower(email) = lower($1)', [b.email])).rowCount;
    if (exists) throw badRequest('EMAIL_TAKEN', 'Det finns redan en administratör med den e-postadressen.');
    const r = await tx((c) => requestApproval(c, auditCtx(req), {
      action: 'admin.create', targetType: 'platform_admin_invite', targetId: inviteKey(b.email), params: { email: b.email, name: b.name, role: b.role }, reason: b.reason,
    }));
    return reply.status(202).send(accepted(r));
  });

  const target = async (id: string, req: { admin?: { adminId: string } }, selfBlocked = false) => {
    const a = (await pool.query('select id, is_break_glass from platform_admins where id = $1', [id])).rows[0];
    if (!a) throw notFound('Administratören hittades inte.');
    if (a.is_break_glass) throw forbidden('Break-glass-kontot kan inte hanteras här. Använd CLI.', 'BREAKGLASS_NOT_MANAGEABLE');
    if (selfBlocked && id === req.admin?.adminId) throw forbidden('Du kan inte göra detta på ditt eget konto. Be en annan Platform Owner.', 'SELF_CHANGE_FORBIDDEN');
  };

  adminRoute(app, { method: 'POST', url: '/admins/:id/role', access: { perm: 'admins.manage' } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason, role }).parse(req.body);
    await target(id, req, true);
    const r = await tx((c) => requestApproval(c, auditCtx(req), { action: 'admin.change_role', targetType: 'platform_admin', targetId: id, params: { role: b.role }, reason: b.reason }));
    return reply.status(202).send(accepted(r));
  });

  adminRoute(app, { method: 'POST', url: '/admins/:id/enable', access: { perm: 'admins.manage' } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    await target(id, req);
    const r = await tx((c) => requestApproval(c, auditCtx(req), { action: 'admin.enable', targetType: 'platform_admin', targetId: id, reason: b.reason }));
    return reply.status(202).send(accepted(r));
  });

  adminRoute(app, { method: 'POST', url: '/admins/:id/reset-mfa', access: { perm: 'admins.manage' } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    await target(id, req, true);
    const r = await tx((c) => requestApproval(c, auditCtx(req), { action: 'admin.reset_mfa', targetType: 'platform_admin', targetId: id, reason: b.reason }));
    return reply.status(202).send(accepted(r));
  });

  // Inaktivering är skyddande och sker direkt (orsak + omautentisering), utan godkännande.
  adminRoute(app, { method: 'POST', url: '/admins/:id/disable', access: { perm: 'admins.manage' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    await tx((c) => disableAdmin(c, auditCtx(req), id, b.reason));
    return { ok: true };
  });

  // Offentlig: kontoinställning via engångslänk (nytt lösenord). MFA registreras därefter vid första inloggningen.
  adminRoute(app, { method: 'POST', url: '/auth/setup', access: { public: true } }, async (req) => {
    rateLimit(`admin-setup:${req.ip}`);
    const b = z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(200) }).parse(req.body);
    assertStrongPassword(b.password, 14);
    const hash = await hashPassword(b.password);
    await tx(async (c) => {
      const t = (await c.query<{ id: string; admin_id: string; purpose: string }>(
        `select id, admin_id, purpose from admin_setup_tokens where token_hash = $1 and used_at is null and expires_at > now() for update`, [sha256Hex(b.token)])).rows[0];
      if (!t) throw badRequest('INVALID_TOKEN', 'Länken är ogiltig eller har gått ut. Be en Platform Owner skicka en ny.');
      const a = (await c.query<{ status: string }>('select status from platform_admins where id = $1 for update', [t.admin_id])).rows[0];
      if (!a || a.status !== 'active') throw badRequest('INVALID_TOKEN', 'Länken är ogiltig eller har gått ut. Be en Platform Owner skicka en ny.');
      await c.query('update platform_admins set password_hash = $2, failed_count = 0, locked_until = null, updated_at = now() where id = $1', [t.admin_id, hash]);
      await c.query('update admin_setup_tokens set used_at = now() where id = $1', [t.id]);
      await c.query('update platform_admin_sessions set revoked_at = now() where admin_id = $1 and revoked_at is null', [t.admin_id]);
      await audit(c, { requestId: req.id, ip: req.ip }, { action: 'admin.setup_completed', severity: 'warning', targetType: 'platform_admin', targetId: t.admin_id, meta: { purpose: t.purpose } });
    });
    return { ok: true };
  });
}

void camel;
