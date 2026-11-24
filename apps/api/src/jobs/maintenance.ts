import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { audit } from '../services/audit.js';
import { expireStaleApprovals } from '../services/approvals.js';
import { sealBreakGlass } from '../services/breakglass.js';
import { getSetting } from '../services/settings.js';

export interface MaintenanceResult {
  approvalsExpired: number; supportSessionsEnded: number; subscriptionsExpired: number; breakGlassSealed: number;
  purgeCandidatesCreated: number; errorsDeleted: number; loginHistoryDeleted: number;
}

/**
 * Periodiska jobb. Raderar ALDRIG kunddata: skapar endast gallringskandidater som kräver fyra-ögon-godkännande (GALL-1, GALL-3).
 */
export async function runMaintenance(db: Db = pool): Promise<MaintenanceResult> {
  const r: MaintenanceResult = { approvalsExpired: 0, supportSessionsEnded: 0, subscriptionsExpired: 0, breakGlassSealed: 0, purgeCandidatesCreated: 0, errorsDeleted: 0, loginHistoryDeleted: 0 };
  r.approvalsExpired = await expireStaleApprovals(db);
  r.supportSessionsEnded = (await db.query(`update support_access_sessions set ended_at = now(), ended_reason = 'expired' where ended_at is null and expires_at <= now()`)).rowCount ?? 0;
  r.breakGlassSealed = await sealBreakGlass(db, 'expired');

  const expired = (await db.query<{ workspace_id: string; id: string; status: string }>(
    `update subscriptions set status = 'Expired', updated_at = now()
      where (status = 'Trialing' and trial_ends_at <= now()) or (status = 'CanceledAtPeriodEnd' and current_period_end <= now())
      returning id, workspace_id, status`)).rows;
  for (const s of expired) {
    await audit(db, {}, { action: 'subscription.expired_auto', workspaceId: s.workspace_id, targetType: 'subscription', targetId: s.id, meta: { by: 'maintenance' } });
  }
  r.subscriptionsExpired = expired.length;

  const closedDays = await getSetting<number>(db, 'retention.closed_workspace_days');
  const productMonths = await getSetting<number>(db, 'retention.product_data_months');
  r.purgeCandidatesCreated += (await db.query(
    `insert into purge_candidates (workspace_id, product, reason, eligible_at)
       select id, null, 'closed_retention', closed_at + make_interval(days => $1) from workspaces
        where status = 'Closed' and closed_at + make_interval(days => $1) <= now()
     on conflict do nothing`, [closedDays])).rowCount ?? 0;
  r.purgeCandidatesCreated += (await db.query(
    `insert into purge_candidates (workspace_id, product, reason, eligible_at)
       select e.workspace_id, e.product, 'product_retention', e.updated_at + make_interval(months => $1) from product_entitlements e
         join subscriptions s on s.workspace_id = e.workspace_id
        where (e.status = 'Disabled' or s.status = 'Expired') and e.updated_at + make_interval(months => $1) <= now()
     on conflict do nothing`, [productMonths])).rowCount ?? 0;

  r.errorsDeleted = (await db.query(`delete from system_errors where at < now() - interval '90 days'`)).rowCount ?? 0;
  r.loginHistoryDeleted = (await db.query(`delete from login_history where created_at < now() - interval '12 months'`)).rowCount ?? 0;
  return r;
}
