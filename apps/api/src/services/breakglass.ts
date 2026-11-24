import type { Db } from '../db/pool.js';
import { audit } from './audit.js';
import { enqueueEmail } from './outbox.js';
import { AppError } from '../lib/errors.js';

export const BREAKGLASS_MAX_MINUTES = 60;

/** Öppnar det förseglade break-glass-kontot tidsbegränsat (BG-2). Notifierar alla Platform Owners (BG-3). */
export async function openBreakGlass(db: Db, input: { reason: string; minutes: number; operator: string }): Promise<{ email: string; openUntil: Date }> {
  if (input.reason.trim().length < 10) throw new AppError(400, 'REASON_REQUIRED', 'Orsak (minst 10 tecken) krävs.');
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > BREAKGLASS_MAX_MINUTES) {
    throw new AppError(400, 'INVALID_DURATION', `Tiden måste vara 1–${BREAKGLASS_MAX_MINUTES} minuter.`);
  }
  const a = (await db.query<{ id: string; email: string }>(`select id, email from platform_admins where is_break_glass and status = 'active' limit 1`)).rows[0];
  if (!a) throw new AppError(404, 'NO_BREAKGLASS_ACCOUNT', 'Inget break-glass-konto finns. Skapa ett med admin:create --break-glass.');
  const openUntil = new Date(Date.now() + input.minutes * 60_000);
  await db.query('update platform_admins set breakglass_open_until = $2, failed_count = 0, locked_until = null, updated_at = now() where id = $1', [a.id, openUntil]);
  await audit(db, { requestId: undefined }, {
    action: 'breakglass.opened', severity: 'critical', targetType: 'platform_admin', targetId: a.id, reason: input.reason,
    meta: { minutes: input.minutes, openUntil, operator: input.operator },
  });
  const owners = (await db.query<{ email: string }>(`select email from platform_admins where status = 'active' and role = 'platform_owner' and not is_break_glass`)).rows;
  for (const o of owners) {
    await enqueueEmail(db, {
      to: o.email, template: 'breakglass_opened', subject: 'KRITISKT: break-glass-kontot har öppnats',
      body: `Break-glass-kontot har öppnats till ${openUntil.toISOString()}. Orsak: ${input.reason}. Om detta inte var förväntat, kontrollera servern omedelbart.`,
    });
  }
  return { email: a.email, openUntil };
}

export async function sealBreakGlass(db: Db, why: 'manual' | 'expired'): Promise<number> {
  const rows = (await db.query<{ id: string }>(
    `update platform_admins set breakglass_open_until = null, updated_at = now()
      where is_break_glass and breakglass_open_until is not null and ($1 = 'manual' or breakglass_open_until <= now()) returning id`, [why])).rows;
  for (const r of rows) {
    await db.query('update platform_admin_sessions set revoked_at = now() where admin_id = $1 and revoked_at is null', [r.id]);
    await db.query(`update support_access_sessions set ended_at = now(), ended_reason = 'admin_session_revoked' where admin_id = $1 and ended_at is null`, [r.id]);
    await audit(db, {}, { action: 'breakglass.sealed', severity: 'warning', targetType: 'platform_admin', targetId: r.id, meta: { why } });
  }
  return rows.length;
}
