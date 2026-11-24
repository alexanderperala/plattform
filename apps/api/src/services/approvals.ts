import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { hasPermission, ROLES, type Role } from '../domain/permissions.js';
import { audit, type AuditCtx } from './audit.js';
import { closeWorkspace, deleteUser } from './actions.js';
import { getSetting } from './settings.js';
import { changeAdminRole, createAdminAccount, enableAdmin, resetAdminMfa } from './admins.js';

export type ApprovalAction = 'workspace.close' | 'user.delete' | 'admin.create' | 'admin.change_role' | 'admin.enable' | 'admin.reset_mfa';

interface ApprovalRow {
  id: string; action: ApprovalAction; target_type: string; target_id: string; workspace_id: string | null;
  params: Record<string, unknown>; reason: string; requested_by: string; expires_at: Date; status: string;
}

export async function requestApproval(
  db: Db, ctx: AuditCtx,
  input: { action: ApprovalAction; targetType: string; targetId: string; workspaceId?: string | null; params?: Record<string, unknown>; reason: string },
): Promise<{ id: string; expiresAt: Date }> {
  const expires = new Date(Date.now() + config.admin.approvalValidHours * 3_600_000);
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into approval_requests (action, target_type, target_id, workspace_id, params, reason, requested_by, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [input.action, input.targetType, input.targetId, input.workspaceId ?? null, JSON.stringify(input.params ?? {}), input.reason, ctx.admin!.id, expires],
    );
    await audit(db, ctx, {
      action: 'approval.requested', severity: 'warning', workspaceId: input.workspaceId ?? null, targetType: input.targetType, targetId: input.targetId,
      reason: input.reason, meta: { approvalId: rows[0]!.id, requestedAction: input.action },
    });
    return { id: rows[0]!.id, expiresAt: expires };
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('ALREADY_PENDING', 'Det finns redan en väntande begäran för samma åtgärd och mål.');
    throw e;
  }
}

/** Antal aktiva administratörer (ej break-glass) som får fatta godkännandebeslut. */
export async function eligibleApproverCount(db: Db): Promise<number> {
  const roles = ROLES.filter((r) => hasPermission(r, 'approvals.decide'));
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from platform_admins where status = 'active' and is_break_glass = false and role = any($1)`, [roles]);
  return rows[0]!.n;
}

async function execute(db: PoolClient, ctx: AuditCtx, a: ApprovalRow): Promise<void> {
  const meta = { approvalId: a.id, requestedBy: a.requested_by };
  if (a.action === 'workspace.close') await closeWorkspace(db, ctx, a.target_id, a.reason, meta);
  else if (a.action === 'user.delete') await deleteUser(db, ctx, a.target_id, a.reason, meta);
  else if (a.action === 'admin.create') {
    const p = a.params as { email: string; name: string; role: Role };
    const id = await createAdminAccount(db, ctx, p, a.reason, meta);
    await db.query(`update approval_requests set target_id = $2 where id = $1`, [a.id, id]);
  }
  else if (a.action === 'admin.change_role') await changeAdminRole(db, ctx, a.target_id, (a.params as { role: Role }).role, a.reason, meta);
  else if (a.action === 'admin.enable') await enableAdmin(db, ctx, a.target_id, a.reason, meta);
  else if (a.action === 'admin.reset_mfa') await resetAdminMfa(db, ctx, a.target_id, a.reason, meta);
  else throw new AppError(500, 'UNKNOWN_ACTION', 'Okänd åtgärdstyp.');
}

export async function decideApproval(
  ctx: AuditCtx, approvalId: string, decision: 'approve' | 'reject', decisionReason?: string,
): Promise<{ status: string; selfApproved: boolean }> {
  const approver = ctx.admin!;
  return tx(async (c) => {
    const { rows } = await c.query<ApprovalRow>('select * from approval_requests where id = $1 for update', [approvalId]);
    const a = rows[0];
    if (!a) throw notFound('Godkännandebegäran hittades inte.');
    if (a.status !== 'pending') throw conflict('NOT_PENDING', `Begäran har redan status ${a.status}.`);
    if (a.expires_at <= new Date()) {
      await c.query(`update approval_requests set status = 'expired' where id = $1`, [a.id]);
      await audit(c, ctx, { action: 'approval.expired', targetType: a.target_type, targetId: a.target_id, meta: { approvalId: a.id } });
      return { status: 'expired', selfApproved: false };
    }

    if (decision === 'reject') {
      await c.query(`update approval_requests set status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = $3 where id = $1`, [a.id, approver.id, decisionReason ?? null]);
      await audit(c, ctx, { action: 'approval.rejected', workspaceId: a.workspace_id, targetType: a.target_type, targetId: a.target_id, reason: decisionReason ?? null, meta: { approvalId: a.id, requestedAction: a.action } });
      return { status: 'rejected', selfApproved: false };
    }

    // FYRA-2 / FYRA-5: godkännaren måste vara en annan person, utom för ensam ägare
    let selfApproved = false;
    if (a.requested_by === approver.id) {
      const allowed = await getSetting<boolean>(c, 'security.allow_sole_owner_self_approval');
      const eligible = await eligibleApproverCount(c);
      if (allowed && approver.role === 'platform_owner' && eligible < 2) selfApproved = true;
      else throw forbidden('Du kan inte godkänna din egen begäran. En annan administratör måste godkänna.', 'SELF_APPROVAL_FORBIDDEN');
    }
    const execCtx: AuditCtx = { ...ctx, selfApproved };
    await c.query(`update approval_requests set status = 'approved', decided_by = $2, decided_at = now(), decision_reason = $3, self_approved = $4 where id = $1`, [a.id, approver.id, decisionReason ?? null, selfApproved]);
    await audit(c, execCtx, { action: 'approval.approved', severity: selfApproved ? 'warning' : 'info', workspaceId: a.workspace_id, targetType: a.target_type, targetId: a.target_id, reason: decisionReason ?? null, meta: { approvalId: a.id, requestedAction: a.action, requestedBy: a.requested_by, selfApproved } });

    await c.query('savepoint exec');
    try {
      await execute(c, execCtx, a);
      await c.query('release savepoint exec');
      await c.query(`update approval_requests set status = 'executed', executed_at = now(), result = '{"ok":true}' where id = $1`, [a.id]);
      return { status: 'executed', selfApproved };
    } catch (e) {
      await c.query('rollback to savepoint exec');
      const msg = e instanceof AppError ? e.message : 'Åtgärden kunde inte utföras.';
      await c.query(`update approval_requests set status = 'failed', result = $2 where id = $1`, [a.id, JSON.stringify({ ok: false, error: msg })]);
      await audit(c, execCtx, { action: 'approval.failed', severity: 'warning', workspaceId: a.workspace_id, targetType: a.target_type, targetId: a.target_id, meta: { approvalId: a.id, error: msg } });
      return { status: 'failed', selfApproved };
    }
  });
}

export async function expireStaleApprovals(db: Db = pool): Promise<number> {
  const r = await db.query(`update approval_requests set status = 'expired' where status = 'pending' and expires_at <= now()`);
  return r.rowCount ?? 0;
}

export type { Role };
