import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { camelAll } from '../../lib/camel.js';
import { adminRoute } from './guard.js';
import { likeEscape } from './workspaces.js';

const uuid = z.string().uuid();

export function auditRoutes(app: FastifyInstance): void {
  adminRoute(app, { method: 'GET', url: '/audit', access: { perm: 'audit.view' } }, async (req) => {
    const q = z.object({
      action: z.string().trim().max(100).optional(), adminId: uuid.optional(), workspaceId: uuid.optional(), userId: uuid.optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional(), q: z.string().trim().max(200).optional(),
      from: z.coerce.date().optional(), to: z.coerce.date().optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    const where: string[] = []; const p: unknown[] = [];
    const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
    if (q.action) where.push(`action like ${add(likeEscape(q.action) + '%')}`);
    if (q.adminId) where.push(`admin_id = ${add(q.adminId)}`);
    if (q.workspaceId) where.push(`workspace_id = ${add(q.workspaceId)}`);
    if (q.userId) where.push(`user_id = ${add(q.userId)}`);
    if (q.severity) where.push(`severity = ${add(q.severity)}`);
    if (q.q) where.push(`(lower(coalesce(reason,'')) like ${add('%' + likeEscape(q.q.toLowerCase()) + '%')} or lower(coalesce(admin_email,'')) like $${p.length})`);
    if (q.from) where.push(`at >= ${add(q.from)}`);
    if (q.to) where.push(`at <= ${add(q.to)}`);
    const limit = add(q.pageSize); const offset = add((q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `select id, at, admin_id, admin_email, admin_role, action, severity, workspace_id, user_id, target_type, target_id, support_case_id, reason,
              before, after, meta, break_glass, self_approved, request_id, count(*) over()::int as total
         from admin_audit_log ${where.length ? 'where ' + where.join(' and ') : ''} order by at desc, id desc limit ${limit} offset ${offset}`, p);
    const total = (rows[0] as { total?: number } | undefined)?.total ?? 0;
    return { items: camelAll<Record<string, unknown>>(rows).map(({ total: _t, ...r }) => r), total, page: q.page, pageSize: q.pageSize };
  });

  // Tekniska fel per arbetsyta och användare. Hemligheter maskeras redan vid skrivning.
  adminRoute(app, { method: 'GET', url: '/logs/errors', access: { perm: 'logs.view' } }, async (req) => {
    const q = z.object({
      workspaceId: uuid.optional(), userId: uuid.optional(), requestId: z.string().max(60).optional(), q: z.string().trim().max(200).optional(),
      from: z.coerce.date().optional(), to: z.coerce.date().optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    const where: string[] = []; const p: unknown[] = [];
    const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
    if (q.workspaceId) where.push(`e.workspace_id = ${add(q.workspaceId)}`);
    if (q.userId) where.push(`e.user_id = ${add(q.userId)}`);
    if (q.requestId) where.push(`e.request_id = ${add(q.requestId)}`);
    if (q.q) where.push(`(lower(e.message) like ${add('%' + likeEscape(q.q.toLowerCase()) + '%')} or lower(coalesce(e.code,'')) like $${p.length})`);
    if (q.from) where.push(`e.at >= ${add(q.from)}`);
    if (q.to) where.push(`e.at <= ${add(q.to)}`);
    const limit = add(q.pageSize); const offset = add((q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `select e.id, e.at, e.request_id, e.source, e.workspace_id, w.name as workspace_name, e.user_id, e.method, e.route, e.status_code, e.code, e.message, e.details,
              count(*) over()::int as total
         from system_errors e left join workspaces w on w.id = e.workspace_id ${where.length ? 'where ' + where.join(' and ') : ''}
        order by e.at desc, e.id desc limit ${limit} offset ${offset}`, p);
    const total = (rows[0] as { total?: number } | undefined)?.total ?? 0;
    return { items: camelAll<Record<string, unknown>>(rows).map(({ total: _t, ...r }) => r), total, page: q.page, pageSize: q.pageSize };
  });
}
