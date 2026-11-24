import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { hasPermission } from '../../domain/permissions.js';
import { camel, camelAll } from '../../lib/camel.js';
import { adminRoute } from './guard.js';

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => camel((await pool.query(sql, params)).rows[0]) as T;

export function dashboardRoutes(app: FastifyInstance): void {
  adminRoute(app, { method: 'GET', url: '/dashboard', access: { perm: 'dashboard.view' } }, async (req) => {
    const role = req.admin!.role;
    const can = (p: string) => hasPermission(role, p);
    const out: Record<string, unknown> = { generatedAt: new Date() };

    // Kunder och produkter
    out.customers = await one(
      `select count(*)::int as total,
              count(*) filter (where status = 'Active')::int as active_workspaces,
              count(*) filter (where status = 'Suspended')::int as suspended_workspaces,
              count(*) filter (where status = 'Closed')::int as closed_workspaces,
              count(*) filter (where created_at > now() - interval '30 days')::int as new_last30d
         from workspaces`);
    out.products = await one(
      `select
         count(*) filter (where product = 'association_portal' and e.status in ('Enabled','LimitExceeded') and w.status = 'Active')::int as association_portals,
         count(*) filter (where product = 'tournament_system'  and e.status in ('Enabled','LimitExceeded') and w.status = 'Active')::int as tournament_systems
         from product_entitlements e join workspaces w on w.id = e.workspace_id`);
    out.bothProducts = (await one<{ n: number }>(
      `select count(*)::int as n from workspaces w where w.status = 'Active'
          and (select count(*) from product_entitlements e where e.workspace_id = w.id and e.status in ('Enabled','LimitExceeded')) = 2`)).n;

    if (can('users.view')) {
      out.activeUsers = (await one<{ n: number }>(`select count(*)::int as n from users where last_login_at > now() - interval '30 days' and status = 'active'`)).n;
      out.lockedUsers = (await one<{ n: number }>(`select count(*)::int as n from users where status = 'locked'`)).n;
    }

    if (can('subscriptions.view')) {
      out.subscriptions = await one(
        `select count(*) filter (where status = 'Trialing' and trial_ends_at > now())::int as trials,
                count(*) filter (where status = 'Active' and plan_id <> 'trial')::int as paying,
                count(*) filter (where status = 'PastDue')::int as past_due,
                count(*) filter (where status in ('Expired','CanceledAtPeriodEnd') or (status = 'Trialing' and trial_ends_at <= now()))::int as ended
           from subscriptions`);
      out.expiringTrials = camelAll(
        (await pool.query(
          `select w.id as workspace_id, w.name, s.trial_ends_at from subscriptions s join workspaces w on w.id = s.workspace_id
            where s.status = 'Trialing' and s.trial_ends_at > now() and s.trial_ends_at < now() + interval '7 days'
            order by s.trial_ends_at limit 5`)).rows);
      out.pastDueList = camelAll(
        (await pool.query(
          `select w.id as workspace_id, w.name, s.past_due_since from subscriptions s join workspaces w on w.id = s.workspace_id
            where s.status = 'PastDue' order by s.past_due_since limit 5`)).rows);
    }

    out.recentRegistrations = camelAll(
      (await pool.query(`select id, name, kind, created_at from workspaces order by created_at desc limit 5`)).rows);

    if (can('support.view')) {
      out.support = await one(
        `select count(*) filter (where status = 'New')::int as new_cases,
                count(*) filter (where status not in ('Resolved','Closed'))::int as open_cases,
                count(*) filter (where status not in ('Resolved','Closed') and priority in ('high','critical'))::int as urgent_cases
           from support_cases`);
    }

    // Godkännanden: de som får besluta ser alla väntande, andra ser sina egna
    out.pendingApprovals = can('approvals.decide')
      ? (await one<{ n: number }>(`select count(*)::int as n from approval_requests where status = 'pending' and expires_at > now()`)).n
      : (await one<{ n: number }>(`select count(*)::int as n from approval_requests where status = 'pending' and expires_at > now() and requested_by = $1`, [req.admin!.adminId])).n;

    if (can('audit.view')) {
      out.selfApprovedLast30d = (await one<{ n: number }>(`select count(*)::int as n from admin_audit_log where self_approved and at > now() - interval '30 days' and action = 'approval.approved'`)).n;
      out.breakGlassOpen = (await one<{ n: number }>(`select count(*)::int as n from platform_admins where is_break_glass and breakglass_open_until > now()`)).n > 0;
    }

    // Systemstatus och tekniska fel
    if (can('logs.view')) {
      let db = 'ok';
      try { await pool.query('select 1'); } catch { db = 'error'; }
      const outbox = await one<{ pending: number; failed: number }>(
        `select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'failed')::int as failed from notification_outbox`);
      out.system = {
        api: 'ok', database: db, emailQueue: outbox,
        // Dessa tjänster finns först i Fas S3 och visas ärligt som ej tillgängliga
        notYetMonitored: ['Bakgrundsjobb', 'Fillagring', 'Realtidstjänster', 'Externa integrationer'],
        errors24h: (await one<{ n: number }>(`select count(*)::int as n from system_errors where at > now() - interval '24 hours'`)).n,
        recentErrors: camelAll((await pool.query(
          `select id, at, code, message, route, status_code, workspace_id from system_errors order by at desc limit 5`)).rows),
      };
    }
    return out;
  });
}
