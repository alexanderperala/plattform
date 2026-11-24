import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { pool, tx } from '../../db/pool.js';
import type { Db } from '../../db/pool.js';
import {
  decryptSecret, dummyVerify, encryptSecret, generateRecoveryCode, normalizeRecoveryCode, randomToken, sha256Hex, verifyPassword,
} from '../../lib/crypto.js';
import { AppError, badRequest, forbidden } from '../../lib/errors.js';
import { rateLimit } from '../../lib/ratelimit.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../../lib/totp.js';
import { permissionsFor, REQUIREMENTS, type Role } from '../../domain/permissions.js';
import { audit } from '../../services/audit.js';
import { auditCtx, clientInfo } from '../context.js';
import { ADMIN_COOKIE, adminRoute } from './guard.js';

const GENERIC = () => new AppError(401, 'INVALID_CREDENTIALS', 'Felaktiga inloggningsuppgifter.');

interface AdminRow {
  id: string; email: string; name: string; role: Role; password_hash: string; status: string; is_break_glass: boolean;
  breakglass_open_until: Date | null; mfa_secret_enc: string | null; mfa_pending_secret_enc: string | null;
  mfa_enrolled_at: Date | null; mfa_last_step: number | null; failed_count: number; locked_until: Date | null;
}

async function logHistory(db: Db, adminId: string | null, email: string, success: boolean, reason: string, req: FastifyRequest) {
  const c = clientInfo(req);
  await db.query(
    `insert into login_history (subject_type, subject_id, email_attempted, success, reason, ip, user_agent) values ('admin',$1,$2,$3,$4,$5,$6)`,
    [adminId, email.slice(0, 200), success, reason, c.ip, c.userAgent],
  );
}

async function registerFailure(adminId: string, req: FastifyRequest, reason: string): Promise<void> {
  const { rows } = await pool.query<{ failed_count: number }>(
    `update platform_admins set failed_count = failed_count + 1,
        locked_until = case when failed_count + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end,
        updated_at = now()
      where id = $1 returning failed_count`,
    [adminId, config.admin.lockAfterFailures, config.admin.lockMinutes],
  );
  if ((rows[0]?.failed_count ?? 0) >= config.admin.lockAfterFailures) {
    await pool.query('update platform_admins set failed_count = 0 where id = $1', [adminId]);
    await pool.query('update platform_admin_sessions set revoked_at = now() where admin_id = $1 and revoked_at is null and stage <> \'active\'', [adminId]);
    await audit(pool, { requestId: req.id, ip: req.ip }, {
      action: 'admin.locked', severity: 'warning', targetType: 'platform_admin', targetId: adminId,
      meta: { minutes: config.admin.lockMinutes, trigger: reason },
    });
  }
}

async function issueSession(
  reply: FastifyReply, req: FastifyRequest, a: AdminRow, stage: 'mfa_pending' | 'mfa_enroll' | 'active', opts: { reauth?: boolean } = {},
): Promise<void> {
  const token = randomToken();
  let expires = new Date(Date.now() + config.admin.absoluteHours * 3_600_000);
  if (a.is_break_glass && a.breakglass_open_until && a.breakglass_open_until < expires) expires = a.breakglass_open_until;
  const c = clientInfo(req);
  await pool.query(
    `insert into platform_admin_sessions (admin_id, token_hash, stage, expires_at, reauth_at, break_glass, ip, user_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.id, sha256Hex(token), stage, expires, opts.reauth ? new Date() : null, a.is_break_glass, c.ip, c.userAgent],
  );
  reply.setCookie(ADMIN_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: config.secureCookies, path: '/api/platform-admin',
    maxAge: Math.floor((expires.getTime() - Date.now()) / 1000),
  });
}

async function requireAdminRow(req: FastifyRequest): Promise<AdminRow> {
  const { rows } = await pool.query<AdminRow>('select * from platform_admins where id = $1', [req.admin!.adminId]);
  if (!rows[0]) throw forbidden('Kontot finns inte.');
  return rows[0];
}

async function endSupportSessions(db: Db, adminId: string, reason: 'manual' | 'admin_session_revoked'): Promise<void> {
  await db.query(`update support_access_sessions set ended_at = now(), ended_reason = $2 where admin_id = $1 and ended_at is null`, [adminId, reason]);
}

/** Förbrukar en återställningskod. Returnerar true om en giltig kod hittades. */
async function consumeRecoveryCode(db: Db, adminId: string, code: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update platform_admin_recovery_codes set used_at = now()
      where id = (select id from platform_admin_recovery_codes where admin_id = $1 and code_hash = $2 and used_at is null limit 1)`,
    [adminId, sha256Hex(normalizeRecoveryCode(code))],
  );
  return (rowCount ?? 0) > 0;
}

export function authRoutes(app: FastifyInstance): void {
  // 1) Lösenord
  adminRoute(app, { method: 'POST', url: '/auth/login', access: { public: true } }, async (req, reply) => {
    rateLimit(`admin-login:${req.ip}`);
    const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(req.body);
    const { rows } = await pool.query<AdminRow>('select * from platform_admins where lower(email) = lower($1)', [body.email]);
    const a = rows[0];
    if (!a) {
      await dummyVerify(body.password);
      await logHistory(pool, null, body.email, false, 'unknown_account', req);
      throw GENERIC();
    }
    const locked = a.locked_until !== null && a.locked_until > new Date();
    const passwordOk = await verifyPassword(body.password, a.password_hash);
    if (locked) { await logHistory(pool, a.id, body.email, false, 'locked', req); throw GENERIC(); }
    if (!passwordOk) {
      await registerFailure(a.id, req, 'password');
      await logHistory(pool, a.id, body.email, false, 'bad_password', req);
      throw GENERIC();
    }
    const sealed = a.is_break_glass && !(a.breakglass_open_until && a.breakglass_open_until > new Date());
    if (a.status !== 'active' || sealed) {
      await logHistory(pool, a.id, body.email, false, sealed ? 'sealed' : 'disabled', req);
      throw GENERIC();
    }
    const stage = a.mfa_enrolled_at ? 'mfa_pending' : 'mfa_enroll';
    await issueSession(reply, req, a, stage);
    await logHistory(pool, a.id, body.email, true, `password_ok_${stage}`, req);
    return { stage };
  });

  // 2) MFA-kod eller återställningskod
  adminRoute(app, { method: 'POST', url: '/auth/mfa/verify', access: { stage: 'mfa_pending' } }, async (req, reply) => {
    rateLimit(`admin-mfa:${req.ip}`);
    const body = z.object({ code: z.string().max(40).optional(), recoveryCode: z.string().max(40).optional() }).refine((b) => b.code || b.recoveryCode).parse(req.body);
    const a = await requireAdminRow(req);
    if (a.locked_until && a.locked_until > new Date()) throw GENERIC();
    let ok = false;
    let usedRecovery = false;
    let step: number | null = null;
    if (body.recoveryCode) {
      ok = await consumeRecoveryCode(pool, a.id, body.recoveryCode);
      usedRecovery = ok;
    } else if (body.code && a.mfa_secret_enc) {
      step = verifyTotp(decryptSecret(a.mfa_secret_enc), body.code.trim(), Date.now(), a.mfa_last_step);
      ok = step !== null;
    }
    if (!ok) {
      await registerFailure(a.id, req, 'mfa');
      await logHistory(pool, a.id, a.email, false, 'bad_mfa', req);
      throw new AppError(401, 'INVALID_MFA', 'Felaktig kod.');
    }
    await tx(async (c) => {
      await c.query('update platform_admin_sessions set revoked_at = now() where id = $1', [req.admin!.sessionId]); // ny token vid stegbyte
      await c.query('update platform_admins set failed_count = 0, locked_until = null, last_login_at = now(), mfa_last_step = coalesce($2, mfa_last_step) where id = $1', [a.id, step]);
      await audit(c, { admin: { id: a.id, email: a.email, role: a.role }, requestId: req.id, ip: req.ip, breakGlass: a.is_break_glass }, {
        action: 'admin.login', severity: a.is_break_glass ? 'critical' : 'info', targetType: 'platform_admin', targetId: a.id,
        meta: { usedRecoveryCode: usedRecovery },
      });
    });
    await issueSession(reply, req, a, 'active', { reauth: true });
    await logHistory(pool, a.id, a.email, true, usedRecovery ? 'login_recovery_code' : 'login', req);
    const left = (await pool.query<{ n: number }>('select count(*)::int as n from platform_admin_recovery_codes where admin_id = $1 and used_at is null', [a.id])).rows[0]!.n;
    return { stage: 'active', recoveryCodesLeft: left, lowRecoveryCodes: left <= 3 };
  });

  // 3) MFA-registrering
  adminRoute(app, { method: 'POST', url: '/auth/mfa/enroll/start', access: { stage: 'mfa_enroll' } }, async (req) => {
    rateLimit(`admin-mfa:${req.ip}`);
    const a = await requireAdminRow(req);
    const secret = generateTotpSecret();
    await pool.query('update platform_admins set mfa_pending_secret_enc = $2, updated_at = now() where id = $1', [a.id, encryptSecret(secret)]);
    return { secret, otpauthUri: otpauthUri(secret, a.email) };
  });

  adminRoute(app, { method: 'POST', url: '/auth/mfa/enroll/confirm', access: { stage: 'mfa_enroll' } }, async (req, reply) => {
    rateLimit(`admin-mfa:${req.ip}`);
    const body = z.object({ code: z.string().regex(/^\d{6}$/, 'Koden ska vara 6 siffror') }).parse(req.body);
    const a = await requireAdminRow(req);
    if (!a.mfa_pending_secret_enc) throw badRequest('ENROLL_NOT_STARTED', 'Starta MFA-registreringen först.');
    const step = verifyTotp(decryptSecret(a.mfa_pending_secret_enc), body.code);
    if (step === null) throw new AppError(401, 'INVALID_MFA', 'Felaktig kod. Kontrollera att klockan i din enhet är korrekt.');
    const codes = Array.from({ length: 10 }, () => generateRecoveryCode());
    await tx(async (c) => {
      await c.query(
        `update platform_admins set mfa_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = null, mfa_enrolled_at = now(),
            mfa_last_step = $2, failed_count = 0, last_login_at = now(), updated_at = now() where id = $1`, [a.id, step]);
      await c.query('delete from platform_admin_recovery_codes where admin_id = $1', [a.id]);
      for (const code of codes) {
        await c.query('insert into platform_admin_recovery_codes (admin_id, code_hash) values ($1,$2)', [a.id, sha256Hex(normalizeRecoveryCode(code))]);
      }
      await c.query('update platform_admin_sessions set revoked_at = now() where id = $1', [req.admin!.sessionId]);
      await audit(c, { admin: { id: a.id, email: a.email, role: a.role }, requestId: req.id, ip: req.ip, breakGlass: a.is_break_glass }, {
        action: 'admin.mfa.enrolled', severity: 'info', targetType: 'platform_admin', targetId: a.id,
      });
    });
    await issueSession(reply, req, { ...a, mfa_enrolled_at: new Date() }, 'active', { reauth: true });
    return { stage: 'active', recoveryCodes: codes }; // visas endast en gång
  });

  // Åter-autentisering inför känsliga åtgärder (SEC-5)
  adminRoute(app, { method: 'POST', url: '/auth/reauth', access: { authenticated: true } }, async (req) => {
    rateLimit(`admin-mfa:${req.ip}`);
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const a = await requireAdminRow(req);
    const step = a.mfa_secret_enc ? verifyTotp(decryptSecret(a.mfa_secret_enc), body.code, Date.now(), a.mfa_last_step) : null;
    if (step === null) {
      await registerFailure(a.id, req, 'reauth');
      throw new AppError(401, 'INVALID_MFA', 'Felaktig kod.');
    }
    await pool.query('update platform_admins set mfa_last_step = $2 where id = $1', [a.id, step]);
    await pool.query('update platform_admin_sessions set reauth_at = now() where id = $1', [req.admin!.sessionId]);
    await audit(pool, auditCtx(req), { action: 'admin.reauth', targetType: 'platform_admin', targetId: a.id });
    return { reauthenticatedUntil: new Date(Date.now() + config.admin.reauthMinutes * 60_000) };
  });

  adminRoute(app, { method: 'POST', url: '/auth/logout', access: { stage: 'any' } }, async (req, reply) => {
    await pool.query('update platform_admin_sessions set revoked_at = now() where id = $1', [req.admin!.sessionId]);
    await endSupportSessions(pool, req.admin!.adminId, 'admin_session_revoked');
    reply.clearCookie(ADMIN_COOKIE, { path: '/api/platform-admin' });
    return { ok: true };
  });

  adminRoute(app, { method: 'GET', url: '/auth/me', access: { stage: 'any' } }, async (req) => {
    const s = req.admin!;
    if (s.stage !== 'active') return { stage: s.stage, email: s.email };
    const lastSeen = Date.now() + config.admin.idleMinutes * 60_000;
    return {
      stage: 'active',
      admin: { id: s.adminId, email: s.email, name: s.name, role: s.role, breakGlass: s.breakGlass },
      permissions: permissionsFor(s.role),
      requirements: REQUIREMENTS,
      session: {
        expiresAt: s.expiresAt,
        idleExpiresAt: new Date(Math.min(lastSeen, s.expiresAt.getTime())),
        reauthValidUntil: s.reauthAt ? new Date(s.reauthAt.getTime() + config.admin.reauthMinutes * 60_000) : null,
      },
    };
  });
}
