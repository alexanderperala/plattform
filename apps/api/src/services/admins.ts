import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { ROLES, type Role } from '../domain/permissions.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { hashPassword, randomToken, sha256Hex } from '../lib/crypto.js';
import { audit, type AuditCtx } from './audit.js';
import { enqueueEmail } from './outbox.js';

export const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL ?? 'http://127.0.0.1:5173';
const SETUP_HOURS = 48;

interface AdminRow { id: string; email: string; name: string; role: Role; status: string; is_break_glass: boolean }

async function load(db: Db, id: string): Promise<AdminRow> {
  const r = await db.query<AdminRow>('select id, email, name, role, status, is_break_glass from platform_admins where id = $1 for update', [id]);
  if (!r.rows[0]) throw notFound('Administratören hittades inte.');
  return r.rows[0];
}

/** Den som begärde åtgärden (vid four-eyes är ctx.admin godkännaren). */
const requesterOf = (ctx: AuditCtx, meta: Record<string, unknown>): string | undefined => (meta.requestedBy as string | undefined) ?? ctx.admin?.id;

/** Break-glass-kontot hanteras uteslutande via CLI. */
const assertManageable = (a: AdminRow) => { if (a.is_break_glass) throw forbidden('Break-glass-kontot kan inte hanteras här. Använd CLI.', 'BREAKGLASS_NOT_MANAGEABLE'); };

/** Minst en aktiv Platform Owner måste alltid finnas kvar. */
async function assertOwnerRemains(db: Db, excludingAdminId: string): Promise<void> {
  const r = await db.query<{ n: number }>(
    `select count(*)::int as n from platform_admins where role = 'platform_owner' and status = 'active' and is_break_glass = false and id <> $1`, [excludingAdminId]);
  if (r.rows[0]!.n < 1) throw conflict('LAST_OWNER', 'Det måste finnas minst en aktiv Platform Owner. Åtgärden skulle ta bort den sista.');
}

async function revokeSessions(db: Db, adminId: string): Promise<number> {
  const r = await db.query(`update platform_admin_sessions set revoked_at = now() where admin_id = $1 and revoked_at is null`, [adminId]);
  return r.rowCount ?? 0;
}

/** Skapar engångslänk (token visas aldrig för administratörer, bara i mejlet till kontoinnehavaren). */
async function issueSetupLink(db: Db, a: AdminRow, purpose: 'invite' | 'mfa_reset'): Promise<void> {
  await db.query(`update admin_setup_tokens set used_at = now() where admin_id = $1 and used_at is null`, [a.id]);
  const token = randomToken();
  await db.query(`insert into admin_setup_tokens (admin_id, token_hash, purpose, expires_at) values ($1,$2,$3, now() + make_interval(hours => $4))`, [a.id, sha256Hex(token), purpose, SETUP_HOURS]);
  const link = `${ADMIN_BASE_URL}/setup?token=${token}`;
  await enqueueEmail(db, {
    to: a.email, template: 'invite', // "invite" rensas ur utkorgen efter leverans
    subject: purpose === 'invite' ? 'Ditt administratörskonto är skapat' : 'Återställning av ditt administratörskonto',
    body: `Hej ${a.name},\n\n${purpose === 'invite' ? 'Ett administratörskonto har skapats åt dig.' : 'Din tvåstegsverifiering har återställts av en annan administratör.'}\nVälj ett nytt lösenord med länken nedan. Du registrerar sedan tvåstegsverifiering vid första inloggningen.\n\n${link}\n\nLänken gäller i ${SETUP_HOURS} timmar och kan användas en gång. Kontakta en Platform Owner om du inte väntar dig detta mejl.`,
    payload: { adminId: a.id, purpose },
  });
}

export async function createAdminAccount(db: Db, ctx: AuditCtx, p: { email: string; name: string; role: Role }, reason: string, meta: Record<string, unknown>): Promise<string> {
  if (!(ROLES as readonly string[]).includes(p.role)) throw conflict('BAD_ROLE', 'Okänd roll.');
  const unusable = await hashPassword(randomBytes(32).toString('base64url')); // ingen känd lösenord, kontot aktiveras via länk
  let id: string;
  try {
    id = (await db.query<{ id: string }>(
      `insert into platform_admins (email, name, role, password_hash, created_by) values ($1,$2,$3,$4,$5) returning id`,
      [p.email, p.name, p.role, unusable, requesterOf(ctx, meta) ?? null])).rows[0]!.id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('EMAIL_TAKEN', 'Det finns redan en administratör med den e-postadressen.');
    throw e;
  }
  await issueSetupLink(db, { id, email: p.email, name: p.name, role: p.role, status: 'active', is_break_glass: false }, 'invite');
  await audit(db, ctx, { action: 'admin.created', severity: 'critical', targetType: 'platform_admin', targetId: id, reason, after: { email: p.email, role: p.role }, meta });
  return id;
}

export async function changeAdminRole(db: Db, ctx: AuditCtx, id: string, role: Role, reason: string, meta: Record<string, unknown>): Promise<void> {
  const a = await load(db, id); assertManageable(a);
  if (a.id === requesterOf(ctx, meta)) throw forbidden('Du kan inte ändra din egen roll.', 'SELF_CHANGE_FORBIDDEN');
  if (a.role === role) throw conflict('NO_CHANGE', 'Administratören har redan den rollen.');
  if (a.role === 'platform_owner') await assertOwnerRemains(db, a.id);
  await db.query('update platform_admins set role = $2, updated_at = now() where id = $1', [id, role]);
  const revoked = await revokeSessions(db, id); // behörigheter cachas aldrig, men sessionen förnyas för tydlighet
  await audit(db, ctx, { action: 'admin.role_changed', severity: 'critical', targetType: 'platform_admin', targetId: id, reason, before: { role: a.role }, after: { role }, meta: { ...meta, sessionsRevoked: revoked } });
}

export async function disableAdmin(db: Db, ctx: AuditCtx, id: string, reason: string): Promise<void> {
  const a = await load(db, id); assertManageable(a);
  if (a.id === ctx.admin?.id) throw forbidden('Du kan inte inaktivera ditt eget konto.', 'SELF_CHANGE_FORBIDDEN');
  if (a.status === 'disabled') throw conflict('ALREADY_DISABLED', 'Kontot är redan inaktiverat.');
  if (a.role === 'platform_owner') await assertOwnerRemains(db, a.id);
  await db.query(`update platform_admins set status = 'disabled', updated_at = now() where id = $1`, [id]);
  const revoked = await revokeSessions(db, id);
  await audit(db, ctx, { action: 'admin.disabled', severity: 'critical', targetType: 'platform_admin', targetId: id, reason, before: { status: a.status }, after: { status: 'disabled' }, meta: { sessionsRevoked: revoked } });
}

export async function enableAdmin(db: Db, ctx: AuditCtx, id: string, reason: string, meta: Record<string, unknown>): Promise<void> {
  const a = await load(db, id); assertManageable(a);
  if (a.status === 'active') throw conflict('ALREADY_ACTIVE', 'Kontot är redan aktivt.');
  await db.query(`update platform_admins set status = 'active', failed_count = 0, locked_until = null, updated_at = now() where id = $1`, [id]);
  await audit(db, ctx, { action: 'admin.enabled', severity: 'critical', targetType: 'platform_admin', targetId: id, reason, before: { status: a.status }, after: { status: 'active' }, meta });
}

/**
 * Återställer MFA. Lösenordet ogiltigförklaras också och ersätts via engångslänk, annars kunde en
 * angripare med stulet lösenord registrera sin egen MFA-enhet.
 */
export async function resetAdminMfa(db: Db, ctx: AuditCtx, id: string, reason: string, meta: Record<string, unknown>): Promise<void> {
  const a = await load(db, id); assertManageable(a);
  if (a.id === requesterOf(ctx, meta)) throw forbidden('Du kan inte återställa din egen MFA. Be en annan Platform Owner.', 'SELF_CHANGE_FORBIDDEN');
  await db.query(
    `update platform_admins set mfa_secret_enc = null, mfa_pending_secret_enc = null, mfa_enrolled_at = null, mfa_last_step = null,
            password_hash = $2, failed_count = 0, locked_until = null, updated_at = now() where id = $1`,
    [id, await hashPassword(randomBytes(32).toString('base64url'))]);
  await db.query('delete from platform_admin_recovery_codes where admin_id = $1', [id]);
  const revoked = await revokeSessions(db, id);
  await issueSetupLink(db, a, 'mfa_reset');
  await audit(db, ctx, { action: 'admin.mfa_reset', severity: 'critical', targetType: 'platform_admin', targetId: id, reason, meta: { ...meta, sessionsRevoked: revoked } });
}

void config;
