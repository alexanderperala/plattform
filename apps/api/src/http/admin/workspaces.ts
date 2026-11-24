import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { hasPermission } from '../../domain/permissions.js';
import { camel, camelAll } from '../../lib/camel.js';
import { notFound } from '../../lib/errors.js';
import { auditCtx } from '../context.js';
import { audit } from '../../services/audit.js';
import { loadWorkspaceAccess } from '../../services/access.js';
import { requestApproval } from '../../services/approvals.js';
import { closeWorkspace as _close, reactivateWorkspace, revokeWorkspaceUserSessions, suspendWorkspace } from '../../services/actions.js';
import { adminRoute } from './guard.js';

void _close;
const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);

export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (m) => '\\' + m);

// Effektiv abonnemangsstatus i SQL (spegel av effectiveSubscriptionStatus)
const EFF_STATUS = `case when s.status = 'Trialing' and s.trial_ends_at <= now() then 'Expired'
                         when s.status = 'CanceledAtPeriodEnd' and s.current_period_end <= now() then 'Expired'
                         else s.status end`;

const SORTS: Record<string, string> = {
  name: 'lower(w.name)', createdAt: 'w.created_at', status: 'w.status', plan: 's.plan_id', lastActivityAt: 'w.last_activity_at',
};

export function workspaceRoutes(app: FastifyInstance): void {
  adminRoute(app, { method: 'GET', url: '/workspaces', access: { perm: 'workspaces.view' } }, async (req) => {
    const q = z.object({
      q: z.string().trim().max(200).optional(),
      product: z.enum(['association_portal', 'tournament_system']).optional(),
      workspaceStatus: z.enum(['Active', 'Suspended', 'Closed']).optional(),
      subscriptionStatus: z.enum(['Trialing', 'Active', 'PastDue', 'Paused', 'CanceledAtPeriodEnd', 'Expired']).optional(),
      plan: z.string().max(40).optional(),
      kind: z.enum(['association', 'organizer', 'other']).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      sort: z.string().default('createdAt'),
      dir: z.enum(['asc', 'desc']).default('desc'),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query);

    const where: string[] = [];
    const p: unknown[] = [];
    const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
    if (q.q) {
      const like = `%${likeEscape(q.q.toLowerCase())}%`;
      const l = add(like);
      const exact = add(q.q);
      where.push(`(lower(w.name) like ${l} or w.id::text = ${exact} or w.id::text like ${add(likeEscape(q.q.toLowerCase()) + '%')}
                   or lower(coalesce(w.org_number,'')) like ${l} or lower(w.contact_name) like ${l} or lower(w.contact_email) like ${l})`);
    }
    if (q.product) where.push(`exists (select 1 from product_entitlements e where e.workspace_id = w.id and e.product = ${add(q.product)} and e.status <> 'Disabled')`);
    if (q.workspaceStatus) where.push(`w.status = ${add(q.workspaceStatus)}`);
    if (q.subscriptionStatus) where.push(`(${EFF_STATUS}) = ${add(q.subscriptionStatus)}`);
    if (q.plan) where.push(`s.plan_id = ${add(q.plan)}`);
    if (q.kind) where.push(`w.kind = ${add(q.kind)}`);
    if (q.from) where.push(`w.created_at >= ${add(q.from)}`);
    if (q.to) where.push(`w.created_at <= ${add(q.to)}`);
    const sort = SORTS[q.sort] ?? SORTS.createdAt!;
    const canSub = hasPermission(req.admin!.role, 'subscriptions.view');
    const limit = add(q.pageSize);
    const offset = add((q.page - 1) * q.pageSize);

    const { rows } = await pool.query(
      `select w.id, w.name, w.kind, w.org_number, w.contact_name, w.contact_email, w.status, w.created_at, w.last_activity_at,
              s.plan_id, (${EFF_STATUS}) as subscription_status, s.trial_ends_at,
              coalesce((select json_agg(json_build_object('product', e.product, 'status', e.status) order by e.product)
                          from product_entitlements e where e.workspace_id = w.id), '[]'::json) as products,
              count(*) over()::int as total
         from workspaces w left join subscriptions s on s.workspace_id = w.id
        ${where.length ? 'where ' + where.join(' and ') : ''}
        order by ${sort} ${q.dir === 'asc' ? 'asc' : 'desc'} nulls last, w.id
        limit ${limit} offset ${offset}`, p);
    const total = (rows[0] as { total?: number } | undefined)?.total ?? 0;
    const items = camelAll<Record<string, unknown>>(rows).map(({ total: _t, ...r }) => {
      if (!canSub) { delete r.planId; delete r.subscriptionStatus; delete r.trialEndsAt; }
      return r;
    });
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  adminRoute(app, { method: 'GET', url: '/workspaces/:id', access: { perm: 'workspaces.view' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    req.errCtx.workspaceId = id;
    const role = req.admin!.role;
    const can = (perm: string) => hasPermission(role, perm);
    const ws = (await pool.query('select * from workspaces where id = $1', [id])).rows[0];
    if (!ws) throw notFound('Arbetsytan hittades inte.');
    const out: Record<string, unknown> = { workspace: camel(ws) };
    if (can('entitlements.view') || can('subscriptions.view')) {
      const access = await loadWorkspaceAccess(pool, id);
      out.access = {
        ...access,
        subscription: can('subscriptions.view') ? access?.subscription : null,
        products: can('entitlements.view') ? access?.products : [],
      };
    }
    out.members = can('users.view')
      ? camelAll((await pool.query(
          `select u.id as user_id, u.name, u.email, m.role, u.status, u.last_login_at, m.created_at
             from workspace_members m join users u on u.id = m.user_id where m.workspace_id = $1
            order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(u.name)`, [id])).rows)
      : [];
    out.memberCount = (await pool.query('select count(*)::int as n from workspace_members where workspace_id = $1', [id])).rows[0].n;
    if (can('workspaces.notes')) {
      out.notes = camelAll((await pool.query(
        `select n.id, n.body, n.created_at, a.name as admin_name from workspace_notes n left join platform_admins a on a.id = n.admin_id
          where n.workspace_id = $1 order by n.created_at desc limit 50`, [id])).rows);
    }
    if (can('support.view')) {
      out.cases = camelAll((await pool.query(
        `select id, number, subject, status, priority, category, created_at from support_cases where workspace_id = $1 order by created_at desc limit 20`, [id])).rows);
      out.supportAccess = camelAll((await pool.query(
        `select s.id, s.mode, s.started_at, s.expires_at, s.ended_at, s.ended_reason, s.personal_data, a.name as admin_name
           from support_access_sessions s join platform_admins a on a.id = s.admin_id where s.workspace_id = $1 order by s.started_at desc limit 10`, [id])).rows);
    }
    if (can('audit.view')) {
      out.events = camelAll((await pool.query(
        `select id, at, action, severity, admin_email, reason, meta from admin_audit_log where workspace_id = $1 order by at desc limit 30`, [id])).rows);
    }
    if (can('logs.view')) {
      out.errors = camelAll((await pool.query(
        `select id, at, code, message, route, status_code, request_id from system_errors where workspace_id = $1 order by at desc limit 20`, [id])).rows);
    }
    return out;
  });

  adminRoute(app, { method: 'PATCH', url: '/workspaces/:id', access: { perm: 'workspaces.update' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    req.errCtx.workspaceId = id;
    const b = z.object({
      reason,
      name: z.string().trim().min(1).max(200).optional(),
      contactName: z.string().trim().min(1).max(200).optional(),
      contactEmail: z.string().trim().email().max(200).optional(),
      orgNumber: z.string().trim().max(30).nullable().optional(),
      vatId: z.string().trim().max(30).nullable().optional(),
      country: z.string().trim().length(2).toUpperCase().optional(),
    }).parse(req.body);
    return tx(async (c) => {
      const cur = (await c.query('select name, contact_name, contact_email, org_number, vat_id, country from workspaces where id = $1 for update', [id])).rows[0];
      if (!cur) throw notFound('Arbetsytan hittades inte.');
      const next = {
        name: b.name ?? cur.name, contact_name: b.contactName ?? cur.contact_name, contact_email: b.contactEmail ?? cur.contact_email,
        org_number: b.orgNumber === undefined ? cur.org_number : b.orgNumber, vat_id: b.vatId === undefined ? cur.vat_id : b.vatId,
        country: b.country ?? cur.country,
      };
      await c.query(
        `update workspaces set name=$2, contact_name=$3, contact_email=$4, org_number=$5, vat_id=$6, country=$7, updated_at=now() where id=$1`,
        [id, next.name, next.contact_name, next.contact_email, next.org_number, next.vat_id, next.country]);
      await audit(c, auditCtx(req), { action: 'workspace.update', workspaceId: id, targetType: 'workspace', targetId: id, reason: b.reason, before: cur, after: next });
      return { ok: true };
    });
  });

  adminRoute(app, { method: 'POST', url: '/workspaces/:id/suspend', access: { perm: 'workspaces.suspend' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.workspaceId = id;
    await tx((c) => suspendWorkspace(c, auditCtx(req), id, b.reason));
    return { ok: true, status: 'Suspended' };
  });

  adminRoute(app, { method: 'POST', url: '/workspaces/:id/reactivate', access: { perm: 'workspaces.suspend' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.workspaceId = id;
    await tx((c) => reactivateWorkspace(c, auditCtx(req), id, b.reason));
    return { ok: true, status: 'Active' };
  });

  // Avslut kräver fyra-ögon: skapar en godkännandebegäran i stället för att utföra åtgärden
  adminRoute(app, { method: 'POST', url: '/workspaces/:id/close', access: { perm: 'workspaces.close' } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.workspaceId = id;
    const ws = (await pool.query('select status from workspaces where id = $1', [id])).rows[0];
    if (!ws) throw notFound('Arbetsytan hittades inte.');
    const r = await tx((c) => requestApproval(c, auditCtx(req), { action: 'workspace.close', targetType: 'workspace', targetId: id, workspaceId: id, reason: b.reason }));
    return reply.status(202).send({ approvalRequired: true, approvalId: r.id, expiresAt: r.expiresAt });
  });

  adminRoute(app, { method: 'POST', url: '/workspaces/:id/revoke-sessions', access: { perm: 'users.lock' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    req.errCtx.workspaceId = id;
    const n = await tx((c) => revokeWorkspaceUserSessions(c, auditCtx(req), id, b.reason));
    return { ok: true, sessionsRevoked: n };
  });

  adminRoute(app, { method: 'POST', url: '/workspaces/:id/notes', access: { perm: 'workspaces.notes' } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ body: z.string().trim().min(1).max(5000) }).parse(req.body);
    req.errCtx.workspaceId = id;
    const ws = (await pool.query('select 1 from workspaces where id = $1', [id])).rows[0];
    if (!ws) throw notFound('Arbetsytan hittades inte.');
    const note = await tx(async (c) => {
      const r = await c.query('insert into workspace_notes (workspace_id, admin_id, body) values ($1,$2,$3) returning id, created_at', [id, req.admin!.adminId, b.body]);
      await audit(c, auditCtx(req), { action: 'workspace.note_added', workspaceId: id, targetType: 'workspace', targetId: id, meta: { noteId: r.rows[0].id } });
      return r.rows[0];
    });
    return reply.status(201).send(camel(note));
  });
}
