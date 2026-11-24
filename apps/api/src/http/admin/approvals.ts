import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { hasPermission } from '../../domain/permissions.js';
import { camelAll } from '../../lib/camel.js';
import { conflict } from '../../lib/errors.js';
import { auditCtx } from '../context.js';
import { decideApproval, expireStaleApprovals } from '../../services/approvals.js';
import { adminRoute } from './guard.js';

const uuid = z.string().uuid();

export function approvalRoutes(app: FastifyInstance): void {
  adminRoute(app, { method: 'GET', url: '/approvals', access: { perm: 'dashboard.view' } }, async (req) => {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed', 'failed']).optional() }).parse(req.query);
    await expireStaleApprovals();
    const where: string[] = []; const p: unknown[] = [];
    if (q.status) { p.push(q.status); where.push(`r.status = $${p.length}`); }
    // Endast de som får besluta ser alla begäranden. Övriga ser sina egna.
    if (!hasPermission(req.admin!.role, 'approvals.decide')) { p.push(req.admin!.adminId); where.push(`r.requested_by = $${p.length}`); }
    const rows = (await pool.query(
      `select r.id, r.action, r.target_type, r.target_id, r.workspace_id, r.reason, r.status, r.requested_at, r.expires_at, r.decided_at,
              r.decision_reason, r.self_approved, r.result, rq.name as requested_by_name, rq.id as requested_by, d.name as decided_by_name,
              coalesce(w.name, u.name, pa.name, r.params->>'email') as target_name, r.params
         from approval_requests r join platform_admins rq on rq.id = r.requested_by left join platform_admins d on d.id = r.decided_by
         left join workspaces w on r.target_type = 'workspace' and w.id = r.target_id
         left join users u on r.target_type = 'user' and u.id = r.target_id
         left join platform_admins pa on r.target_type = 'platform_admin' and pa.id = r.target_id
        ${where.length ? 'where ' + where.join(' and ') : ''} order by r.requested_at desc limit 100`, p)).rows;
    return { items: camelAll(rows) };
  });

  adminRoute(app, { method: 'POST', url: '/approvals/:id/approve', access: { perm: 'approvals.decide' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
    const r = await decideApproval(auditCtx(req), id, 'approve', b.reason);
    if (r.status === 'expired') throw conflict('EXPIRED', 'Begäran har förfallit och utfördes inte.');
    if (r.status === 'failed') {
      const row = (await pool.query('select result from approval_requests where id = $1', [id])).rows[0];
      throw conflict('EXECUTION_FAILED', `Åtgärden kunde inte utföras: ${row?.result?.error ?? 'okänt fel'}`);
    }
    return { ok: true, ...r };
  });

  adminRoute(app, { method: 'POST', url: '/approvals/:id/reject', access: { perm: 'approvals.decide' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
    const r = await decideApproval(auditCtx(req), id, 'reject', b.reason);
    return { ok: true, ...r };
  });
}
