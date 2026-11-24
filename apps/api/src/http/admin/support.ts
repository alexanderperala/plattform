import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { camel, camelAll } from '../../lib/camel.js';
import { conflict, notFound, badRequest } from '../../lib/errors.js';
import { CASE_TRANSITIONS } from '../../domain/subscription.js';
import { auditCtx } from '../context.js';
import { audit } from '../../services/audit.js';
import { enqueueEmail } from '../../services/outbox.js';
import { adminRoute } from './guard.js';
import { likeEscape } from './workspaces.js';

const uuid = z.string().uuid();
const CATEGORY = z.enum(['account_login', 'member_admin', 'forum_communication', 'tournament_system', 'results_scoring', 'payments', 'subscription', 'technical_error', 'other']);
const PRIORITY = z.enum(['low', 'normal', 'high', 'critical']);
const STATUS = z.enum(['New', 'InProgress', 'WaitingCustomer', 'WaitingInternal', 'Resolved', 'Closed']);

export function supportRoutes(app: FastifyInstance): void {
  adminRoute(app, { method: 'GET', url: '/support/cases', access: { perm: 'support.view' } }, async (req) => {
    const q = z.object({
      q: z.string().trim().max(200).optional(), status: STATUS.optional(), open: z.enum(['true', 'false']).optional(),
      priority: PRIORITY.optional(), category: CATEGORY.optional(), workspaceId: uuid.optional(), userId: uuid.optional(),
      assignedTo: z.union([uuid, z.literal('me')]).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query);
    const where: string[] = []; const p: unknown[] = [];
    const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
    if (q.q) { const l = add(`%${likeEscape(q.q.toLowerCase())}%`); where.push(`(lower(c.subject) like ${l} or c.number::text = ${add(q.q)} or lower(coalesce(c.requester_email,'')) like ${l})`); }
    if (q.status) where.push(`c.status = ${add(q.status)}`);
    if (q.open === 'true') where.push(`c.status not in ('Resolved','Closed')`);
    if (q.open === 'false') where.push(`c.status in ('Resolved','Closed')`);
    if (q.priority) where.push(`c.priority = ${add(q.priority)}`);
    if (q.category) where.push(`c.category = ${add(q.category)}`);
    if (q.workspaceId) where.push(`c.workspace_id = ${add(q.workspaceId)}`);
    if (q.userId) where.push(`c.user_id = ${add(q.userId)}`);
    if (q.assignedTo) where.push(`c.assigned_admin_id = ${add(q.assignedTo === 'me' ? req.admin!.adminId : q.assignedTo)}`);
    const limit = add(q.pageSize); const offset = add((q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `select c.id, c.number, c.subject, c.category, c.priority, c.status, c.created_at, c.updated_at, c.workspace_id, w.name as workspace_name,
              c.user_id, c.assigned_admin_id, a.name as assigned_admin_name, count(*) over()::int as total
         from support_cases c left join workspaces w on w.id = c.workspace_id left join platform_admins a on a.id = c.assigned_admin_id
        ${where.length ? 'where ' + where.join(' and ') : ''}
        order by case c.priority when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, c.updated_at desc
        limit ${limit} offset ${offset}`, p);
    const total = (rows[0] as { total?: number } | undefined)?.total ?? 0;
    return { items: camelAll<Record<string, unknown>>(rows).map(({ total: _t, ...r }) => r), total, page: q.page, pageSize: q.pageSize };
  });

  adminRoute(app, { method: 'POST', url: '/support/cases', access: { perm: 'support.manage' } }, async (req, reply) => {
    const b = z.object({
      subject: z.string().trim().min(3).max(200), description: z.string().trim().max(10000).default(''),
      category: CATEGORY.default('other'), priority: PRIORITY.default('normal'),
      workspaceId: uuid.nullable().optional(), userId: uuid.nullable().optional(), requesterEmail: z.string().email().max(200).nullable().optional(),
    }).parse(req.body);
    if (b.workspaceId && !(await pool.query('select 1 from workspaces where id = $1', [b.workspaceId])).rowCount) throw notFound('Arbetsytan hittades inte.');
    if (b.userId && !(await pool.query('select 1 from users where id = $1', [b.userId])).rowCount) throw notFound('Användaren hittades inte.');
    const row = await tx(async (c) => {
      const r = await c.query(
        `insert into support_cases (subject, description, category, priority, workspace_id, user_id, requester_email, created_by_admin_id, assigned_admin_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id, number`,
        [b.subject, b.description, b.category, b.priority, b.workspaceId ?? null, b.userId ?? null, b.requesterEmail ?? null, req.admin!.adminId]);
      await audit(c, auditCtx(req), { action: 'support.case_created', workspaceId: b.workspaceId ?? null, userId: b.userId ?? null, targetType: 'support_case', targetId: r.rows[0].id, supportCaseId: r.rows[0].id, meta: { number: r.rows[0].number } });
      return r.rows[0];
    });
    return reply.status(201).send(camel(row));
  });

  adminRoute(app, { method: 'GET', url: '/support/cases/:id', access: { perm: 'support.view' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const c = (await pool.query(
      `select c.*, w.name as workspace_name, u.name as user_name, a.name as assigned_admin_name
         from support_cases c left join workspaces w on w.id = c.workspace_id left join users u on u.id = c.user_id
         left join platform_admins a on a.id = c.assigned_admin_id where c.id = $1`, [id])).rows[0];
    if (!c) throw notFound('Ärendet hittades inte.');
    const comments = camelAll((await pool.query(
      `select cm.id, cm.body, cm.internal, cm.sent_to, cm.created_at, a.name as author_name from support_case_comments cm
         left join platform_admins a on a.id = cm.author_admin_id where cm.case_id = $1 order by cm.created_at`, [id])).rows);
    const sessions = camelAll((await pool.query(
      `select s.id, s.mode, s.started_at, s.expires_at, s.ended_at, a.name as admin_name from support_access_sessions s
         join platform_admins a on a.id = s.admin_id where s.support_case_id = $1 order by s.started_at desc`, [id])).rows);
    return { case: camel(c), comments, accessSessions: sessions, allowedTransitions: CASE_TRANSITIONS[c.status] ?? [] };
  });

  adminRoute(app, { method: 'PATCH', url: '/support/cases/:id', access: { perm: 'support.manage' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      status: STATUS.optional(), priority: PRIORITY.optional(), category: CATEGORY.optional(), assignedAdminId: uuid.nullable().optional(),
      workspaceId: uuid.nullable().optional(), userId: uuid.nullable().optional(),
    }).parse(req.body);
    return tx(async (c) => {
      const cur = (await c.query('select * from support_cases where id = $1 for update', [id])).rows[0];
      if (!cur) throw notFound('Ärendet hittades inte.');
      if (b.status && b.status !== cur.status && !(CASE_TRANSITIONS[cur.status] ?? []).includes(b.status)) {
        throw conflict('INVALID_TRANSITION', `Ärendet kan inte gå från ${cur.status} till ${b.status}.`);
      }
      if (b.assignedAdminId && !(await c.query(`select 1 from platform_admins where id = $1 and status = 'active'`, [b.assignedAdminId])).rowCount) throw badRequest('UNKNOWN_ADMIN', 'Administratören finns inte.');
      const next = {
        status: b.status ?? cur.status, priority: b.priority ?? cur.priority, category: b.category ?? cur.category,
        assigned_admin_id: b.assignedAdminId === undefined ? cur.assigned_admin_id : b.assignedAdminId,
        workspace_id: b.workspaceId === undefined ? cur.workspace_id : b.workspaceId,
        user_id: b.userId === undefined ? cur.user_id : b.userId,
      };
      await c.query(
        `update support_cases set status=$2, priority=$3, category=$4, assigned_admin_id=$5, workspace_id=$6, user_id=$7, updated_at=now(),
            closed_at = case when $2 in ('Resolved','Closed') then coalesce(closed_at, now()) else null end where id=$1`,
        [id, next.status, next.priority, next.category, next.assigned_admin_id, next.workspace_id, next.user_id]);
      await audit(c, auditCtx(req), {
        action: 'support.case_updated', workspaceId: next.workspace_id, userId: next.user_id, targetType: 'support_case', targetId: id, supportCaseId: id,
        before: { status: cur.status, priority: cur.priority, category: cur.category, assignedAdminId: cur.assigned_admin_id },
        after: { status: next.status, priority: next.priority, category: next.category, assignedAdminId: next.assigned_admin_id },
      });
      return { ok: true, status: next.status };
    });
  });

  // Interna kommentarer syns aldrig för kund. Kundsynliga kommentarer skickas som e-post i Fas S1.
  adminRoute(app, { method: 'POST', url: '/support/cases/:id/comments', access: { perm: 'support.manage' } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ body: z.string().trim().min(1).max(10000), internal: z.boolean().default(true) }).parse(req.body);
    const row = await tx(async (c) => {
      const sc = (await c.query(
        `select c.id, c.number, c.subject, c.status, c.workspace_id, coalesce(c.requester_email, u.email) as recipient
           from support_cases c left join users u on u.id = c.user_id where c.id = $1 for update of c`, [id])).rows[0];
      if (!sc) throw notFound('Ärendet hittades inte.');
      let sentTo: string | null = null;
      if (!b.internal) {
        if (!sc.recipient) throw conflict('NO_RECIPIENT', 'Ärendet saknar mottagare. Koppla en användare eller ange avsändarens e-post innan du svarar kunden.');
        if (sc.status === 'Closed') throw conflict('CASE_CLOSED', 'Ärendet är stängt. Öppna det igen innan du svarar kunden.');
        sentTo = sc.recipient as string;
        await enqueueEmail(c, {
          workspaceId: sc.workspace_id, to: sentTo, template: 'support_reply', subject: `[Ärende #${sc.number}] ${sc.subject}`,
          body: `${b.body}\n\n—\nDetta är ett svar på ditt supportärende #${sc.number}.`,
          payload: { caseId: sc.id },
        });
        // Svar till kund flyttar ärendet till "Väntar på kund" om det var nytt eller pågående
        if (['New', 'InProgress'].includes(sc.status)) await c.query(`update support_cases set status = 'WaitingCustomer' where id = $1`, [id]);
      }
      const r = await c.query(
        'insert into support_case_comments (case_id, author_admin_id, body, internal, sent_to) values ($1,$2,$3,$4,$5) returning id, created_at',
        [id, req.admin!.adminId, b.body, b.internal, sentTo]);
      await c.query('update support_cases set updated_at = now() where id = $1', [id]);
      await audit(c, auditCtx(req), {
        action: 'support.comment_added', workspaceId: sc.workspace_id, targetType: 'support_case', targetId: id, supportCaseId: id,
        meta: { internal: b.internal, sentTo: sentTo ? '[e-post]' : null },
      });
      return r.rows[0];
    });
    return reply.status(201).send(camel(row));
  });
}
