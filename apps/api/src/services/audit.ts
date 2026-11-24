import type { Db } from '../db/pool.js';
import { maskDeep } from '../lib/mask.js';

export interface AuditCtx {
  admin?: { id: string; email: string; role: string };
  requestId?: string;
  ip?: string;
  breakGlass?: boolean;
  selfApproved?: boolean;
}

export interface AuditEvent {
  action: string;
  severity?: 'info' | 'warning' | 'critical';
  workspaceId?: string | null;
  userId?: string | null;
  targetType?: string;
  targetId?: string;
  supportCaseId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

/** Skriver en append-only audit-post. Anropas i samma transaktion som själva åtgärden. */
export async function audit(db: Db, ctx: AuditCtx, e: AuditEvent): Promise<void> {
  await db.query(
    `insert into admin_audit_log
      (admin_id, admin_email, admin_role, action, severity, workspace_id, user_id, target_type, target_id, support_case_id,
       reason, before, after, meta, break_glass, self_approved, request_id, ip)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      ctx.admin?.id ?? null, ctx.admin?.email ?? null, ctx.admin?.role ?? null, e.action, e.severity ?? 'info',
      e.workspaceId ?? null, e.userId ?? null, e.targetType ?? null, e.targetId ?? null, e.supportCaseId ?? null,
      e.reason ?? null,
      e.before === undefined ? null : JSON.stringify(maskDeep(e.before)),
      e.after === undefined ? null : JSON.stringify(maskDeep(e.after)),
      JSON.stringify(maskDeep(e.meta ?? {})),
      ctx.breakGlass ?? false, ctx.selfApproved ?? false, ctx.requestId ?? null, ctx.ip ?? null,
    ],
  );
}
