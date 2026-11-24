import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { sha256Hex } from '../../lib/crypto.js';
import { AppError, badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { hasPermission, REQUIREMENTS, type Role } from '../../domain/permissions.js';
import type { AdminSession } from '../context.js';

export const ADMIN_COOKIE = 'padm_session';
export const CSRF_HEADER = 'platform-admin';

/** Hur en rutt skyddas. Varje Superadmin-rutt MÅSTE deklarera detta, annars vägrar servern starta. */
export type RouteAccess =
  | { public: true }
  | { stage: 'mfa_pending' | 'mfa_enroll' | 'any' }
  | { authenticated: true } // aktiv session, ingen särskild behörighet (t.ex. /auth/me)
  | { perm: string };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

interface SessionRow {
  session_id: string; admin_id: string; stage: AdminSession['stage']; reauth_at: Date | null; expires_at: Date;
  last_seen_at: Date; break_glass: boolean; email: string; name: string; role: Role; status: string;
  is_break_glass: boolean; breakglass_open_until: Date | null; mfa_enrolled_at: Date | null;
}

export async function loadAdminSession(req: FastifyRequest): Promise<AdminSession | null> {
  const token = req.cookies[ADMIN_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query<SessionRow>(
    `select s.id as session_id, s.admin_id, s.stage, s.reauth_at, s.expires_at, s.last_seen_at, s.break_glass,
            a.email, a.name, a.role, a.status, a.is_break_glass, a.breakglass_open_until, a.mfa_enrolled_at
       from platform_admin_sessions s join platform_admins a on a.id = s.admin_id
      where s.token_hash = $1 and s.revoked_at is null`,
    [sha256Hex(token)],
  );
  const r = rows[0];
  if (!r) return null;
  const now = Date.now();
  const idleOk = now - r.last_seen_at.getTime() < config.admin.idleMinutes * 60_000;
  const bgOk = !r.is_break_glass || (r.breakglass_open_until !== null && r.breakglass_open_until.getTime() > now);
  if (r.status !== 'active' || r.expires_at.getTime() <= now || !idleOk || !bgOk) {
    // Utgången session återkallas och avslutar eventuell supportåtkomst (SUP-6)
    await pool.query('update platform_admin_sessions set revoked_at = now() where id = $1 and revoked_at is null', [r.session_id]);
    await pool.query(
      `update support_access_sessions set ended_at = now(), ended_reason = 'admin_session_revoked'
        where admin_id = $1 and ended_at is null`, [r.admin_id]);
    return null;
  }
  await pool.query('update platform_admin_sessions set last_seen_at = now() where id = $1', [r.session_id]);
  return {
    sessionId: r.session_id, adminId: r.admin_id, email: r.email, name: r.name, role: r.role, stage: r.stage,
    reauthAt: r.reauth_at, expiresAt: r.expires_at, breakGlass: r.break_glass, mfaEnrolled: r.mfa_enrolled_at !== null,
  };
}

function checkHostAndIp(req: FastifyRequest): void {
  const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (config.adminAllowedHosts.length && !config.adminAllowedHosts.includes(host)) {
    throw new AppError(404, 'NOT_FOUND', 'Sökvägen finns inte.'); // avslöja inte att adminytan finns på andra värdar
  }
  if (config.adminIpAllowlist.length && !config.adminIpAllowlist.includes(req.ip.toLowerCase())) {
    throw new AppError(404, 'NOT_FOUND', 'Sökvägen finns inte.');
  }
}

function checkCsrf(req: FastifyRequest): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  if (req.headers['x-requested-with'] !== CSRF_HEADER) {
    throw forbidden('Förfrågan saknar obligatorisk säkerhetsrubrik.', 'CSRF_HEADER_MISSING');
  }
  const origin = req.headers.origin;
  if (origin) {
    const ok = config.adminAllowedOrigins.length
      ? config.adminAllowedOrigins.includes(origin.toLowerCase())
      : (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
    if (!ok) throw forbidden('Förfrågan kommer från en otillåten ursprungsadress.', 'CSRF_ORIGIN');
  }
}

/** Central kontroll: värd/IP, CSRF, session, behörighet, orsak och åter-autentisering. */
async function guard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  checkHostAndIp(req);
  checkCsrf(req);
  const access = req.routeOptions.config.access;
  if (!access) throw forbidden('Rutten saknar åtkomstdeklaration.', 'ROUTE_UNDECLARED'); // fail closed
  if ('public' in access) return;

  const s = await loadAdminSession(req);
  if (!s) throw unauthorized('Sessionen har gått ut. Logga in igen.', 'SESSION_REQUIRED');
  req.admin = s;
  req.errCtx.adminId = s.adminId;

  if ('stage' in access) {
    if (access.stage !== 'any' && s.stage !== access.stage) throw forbidden('Fel steg i inloggningen.', 'WRONG_AUTH_STAGE');
    return;
  }
  if (s.stage !== 'active') throw forbidden('Inloggningen är inte slutförd (MFA saknas).', 'MFA_REQUIRED');
  if ('authenticated' in access) return;

  if (!hasPermission(s.role, access.perm)) {
    throw forbidden('Din roll saknar behörighet för den här åtgärden.', 'FORBIDDEN', { permission: access.perm });
  }
  const req_ = REQUIREMENTS[access.perm];
  if (req_ && !['GET', 'HEAD'].includes(req.method)) {
    if (req_.reason) {
      const reason = (req.body as { reason?: unknown } | undefined)?.reason;
      if (typeof reason !== 'string' || reason.trim().length < 10) {
        throw badRequest('REASON_REQUIRED', 'Du måste ange en orsak på minst 10 tecken för den här åtgärden.');
      }
    }
    if (req_.reauth) {
      const limit = config.admin.reauthMinutes * 60_000;
      if (!s.reauthAt || Date.now() - s.reauthAt.getTime() > limit) {
        throw forbidden('Bekräfta din identitet med en MFA-kod för att fortsätta.', 'REAUTH_REQUIRED');
      }
    }
  }
}

export interface AdminRouteOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  access: RouteAccess;
}

/** Registrerar en Superadmin-rutt med obligatorisk åtkomstdeklaration. */
export function adminRoute(app: FastifyInstance, opts: AdminRouteOpts, handler: RouteHandlerMethod): void {
  app.route({ method: opts.method, url: opts.url, config: { access: opts.access }, preHandler: guard, handler });
}

/** Misslyckas vid uppstart om någon rutt i Superadmin-scopet saknar åtkomstdeklaration. */
export function enforceDeclaredAccess(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    if (route.method === 'HEAD' || route.method?.toString().includes('HEAD')) return;
    if (!route.config?.access) {
      throw new Error(`Superadmin-rutten ${String(route.method)} ${route.url} saknar åtkomstdeklaration (fail closed).`);
    }
  });
}

export const reauthRecent = (s: AdminSession): boolean =>
  !!s.reauthAt && Date.now() - s.reauthAt.getTime() <= config.admin.reauthMinutes * 60_000;
