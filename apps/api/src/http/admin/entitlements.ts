import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { hasPermission } from '../../domain/permissions.js';
import { camelAll } from '../../lib/camel.js';
import { conflict, notFound, badRequest } from '../../lib/errors.js';
import { assertTransition } from '../../domain/subscription.js';
import type { SubscriptionStatus } from '../../domain/access.js';
import { auditCtx } from '../context.js';
import { audit } from '../../services/audit.js';
import { evaluateLimits, loadWorkspaceAccess } from '../../services/access.js';
import { getSetting } from '../../services/settings.js';
import { adminRoute } from './guard.js';

const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);
const product = z.enum(['association_portal', 'tournament_system']);
const limitValue = z.number().int().min(0).nullable();

export function entitlementRoutes(app: FastifyInstance): void {
  adminRoute(app, { method: 'GET', url: '/plans', access: { perm: 'entitlements.view' } }, async (req) => {
    const plans = camelAll((await pool.query(
      `select p.id, p.name, p.is_trial, p.active, p.sort_order,
              ${hasPermission(req.admin!.role, 'billing.view') ? 'p.monthly_price_minor, p.currency,' : ''}
              coalesce((select json_agg(json_build_object('product', e.product, 'limits', e.limits) order by e.product)
                          from plan_entitlements e where e.plan_id = p.id), '[]'::json) as entitlements
         from plans p order by p.sort_order`)).rows);
    return { items: plans };
  });

  // Översikt: produktlicenser över alla kunder (sidan "Produkter och licenser")
  adminRoute(app, { method: 'GET', url: '/entitlements', access: { perm: 'entitlements.view' } }, async (req) => {
    const q = z.object({
      product: product.optional(),
      status: z.enum(['Enabled', 'Disabled', 'Suspended', 'LimitExceeded']).optional(),
      q: z.string().trim().max(200).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query);
    const where: string[] = []; const p: unknown[] = [];
    const add = (v: unknown) => { p.push(v); return `$${p.length}`; };
    if (q.product) where.push(`e.product = ${add(q.product)}`);
    if (q.status) where.push(`e.status = ${add(q.status)}`);
    if (q.q) where.push(`lower(w.name) like ${add('%' + q.q.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m) + '%')}`);
    const limit = add(q.pageSize); const offset = add((q.page - 1) * q.pageSize);
    const { rows } = await pool.query(
      `select e.id, e.workspace_id, w.name as workspace_name, w.status as workspace_status, e.product, e.status, e.source, e.expires_at,
              e.limits_override, s.plan_id, s.status as subscription_status, count(*) over()::int as total
         from product_entitlements e join workspaces w on w.id = e.workspace_id left join subscriptions s on s.workspace_id = w.id
        ${where.length ? 'where ' + where.join(' and ') : ''} order by w.name, e.product limit ${limit} offset ${offset}`, p);
    const total = (rows[0] as { total?: number } | undefined)?.total ?? 0;
    return { items: camelAll<Record<string, unknown>>(rows).map(({ total: _t, ...r }) => r), total, page: q.page, pageSize: q.pageSize };
  });

  // Aktivera, inaktivera, pausa eller ändra gränser för en produktlicens
  adminRoute(app, { method: 'POST', url: '/workspaces/:id/entitlements/:product', access: { perm: 'entitlements.manage' } }, async (req) => {
    const params = z.object({ id: uuid, product }).parse(req.params);
    const b = z.object({
      reason,
      action: z.enum(['enable', 'disable', 'suspend', 'set_limits']),
      limits: z.record(z.string(), limitValue).optional(),
      expiresAt: z.coerce.date().nullable().optional(),
    }).parse(req.body);
    req.errCtx.workspaceId = params.id;
    return tx(async (c) => {
      const ws = (await c.query('select id from workspaces where id = $1 for update', [params.id])).rows[0];
      if (!ws) throw notFound('Arbetsytan hittades inte.');
      const cur = (await c.query('select * from product_entitlements where workspace_id = $1 and product = $2 for update', [params.id, params.product])).rows[0];
      if (b.action === 'set_limits') {
        if (!cur) throw conflict('NO_ENTITLEMENT', 'Produkten är inte aktiverad för arbetsytan.');
        if (!b.limits) throw badRequest('LIMITS_REQUIRED', 'Ange gränser.');
        const next = { ...(cur.limits_override as Record<string, number | null>), ...b.limits };
        await c.query('update product_entitlements set limits_override = $3, updated_at = now() where workspace_id = $1 and product = $2', [params.id, params.product, JSON.stringify(next)]);
        await audit(c, auditCtx(req), { action: 'entitlement.limits_changed', severity: 'warning', workspaceId: params.id, targetType: 'product_entitlement', targetId: cur.id, reason: b.reason, before: { limits: cur.limits_override }, after: { limits: next }, meta: { product: params.product } });
      } else {
        const target = b.action === 'enable' ? 'Enabled' : b.action === 'disable' ? 'Disabled' : 'Suspended';
        const source = b.expiresAt ? 'admin_grant' : cur?.source ?? 'admin_grant';
        if (cur) {
          if (cur.status === target && !b.expiresAt) throw conflict('NO_CHANGE', `Licensen har redan status ${target}.`);
          await c.query('update product_entitlements set status = $3, expires_at = $4, source = $5, updated_at = now() where workspace_id = $1 and product = $2',
            [params.id, params.product, target, b.expiresAt ?? null, source]);
        } else {
          if (target !== 'Enabled') throw conflict('NO_ENTITLEMENT', 'Produkten är inte aktiverad för arbetsytan.');
          await c.query(`insert into product_entitlements (workspace_id, product, status, source, expires_at) values ($1,$2,'Enabled',$3,$4)`,
            [params.id, params.product, source, b.expiresAt ?? null]);
        }
        // Ingen data raderas vid inaktivering (KRAV-S1): endast licensstatusen ändras
        await audit(c, auditCtx(req), {
          action: `entitlement.${b.action}`, severity: b.action === 'enable' ? 'info' : 'warning', workspaceId: params.id,
          targetType: 'product_entitlement', targetId: cur?.id ?? params.product, reason: b.reason,
          before: { status: cur?.status ?? null }, after: { status: target, expiresAt: b.expiresAt ?? null }, meta: { product: params.product },
        });
      }
      await evaluateLimits(c, params.id);
      return { ok: true, access: await loadWorkspaceAccess(c, params.id) };
    });
  });

  // Abonnemangsåtgärder styrs av statusmaskinen i avsnitt 4.2
  adminRoute(app, { method: 'POST', url: '/workspaces/:id/subscription', access: { perm: 'subscriptions.manage' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      reason,
      action: z.enum(['change_plan', 'activate', 'extend_trial', 'pause', 'resume', 'cancel_at_period_end', 'undo_cancel', 'expire', 'mark_past_due']),
      planId: z.string().max(40).optional(),
      days: z.number().int().min(1).max(30).optional(),
    }).parse(req.body);
    req.errCtx.workspaceId = id;
    return tx(async (c) => {
      const s = (await c.query('select * from subscriptions where workspace_id = $1 for update', [id])).rows[0];
      if (!s) throw notFound('Arbetsytan saknar abonnemang.');
      const from = s.status as SubscriptionStatus;
      const set: Record<string, unknown> = {};
      let to: SubscriptionStatus = from;

      const checkPlan = async (planId: string, allowTrial: boolean) => {
        const p = (await c.query('select id, is_trial from plans where id = $1 and active', [planId])).rows[0];
        if (!p) throw badRequest('UNKNOWN_PLAN', 'Planen finns inte.');
        if (p.is_trial && !allowTrial) throw badRequest('TRIAL_PLAN_NOT_ALLOWED', 'Provplanen kan inte väljas som betalplan.');
      };

      switch (b.action) {
        case 'change_plan': {
          if (!b.planId) throw badRequest('PLAN_REQUIRED', 'Ange plan.');
          await checkPlan(b.planId, from === 'Trialing');
          set.plan_id = b.planId;
          break;
        }
        case 'activate': {
          to = 'Active';
          assertTransition(from, to);
          const planId = b.planId ?? (s.plan_id === 'trial' ? undefined : s.plan_id);
          if (!planId) throw badRequest('PLAN_REQUIRED', 'Ange betalplan för aktiveringen.');
          await checkPlan(planId, false);
          set.plan_id = planId; set.current_period_start = new Date(); set.current_period_end = new Date(Date.now() + 30 * 86_400_000);
          set.past_due_since = null; set.paused_at = null;
          break;
        }
        case 'extend_trial': {
          if (from !== 'Trialing' && !(from === 'Expired' && s.trial_ends_at)) throw conflict('NOT_A_TRIAL', 'Endast provperioder kan förlängas.');
          const days = b.days ?? (await getSetting<number>(c, 'trial.default_days'));
          if (from === 'Expired') assertTransition(from, 'Trialing');
          to = 'Trialing';
          const base = Math.max(Date.now(), new Date(s.trial_ends_at ?? Date.now()).getTime());
          set.trial_ends_at = new Date(base + days * 86_400_000);
          set.plan_id = 'trial';
          break;
        }
        case 'pause': to = 'Paused'; assertTransition(from, to); set.paused_at = new Date(); break;
        case 'resume': to = 'Active'; assertTransition(from, to); if (from !== 'Paused') throw conflict('NOT_PAUSED', 'Abonnemanget är inte pausat.'); set.paused_at = null; break;
        case 'cancel_at_period_end': to = 'CanceledAtPeriodEnd'; assertTransition(from, to); break;
        case 'undo_cancel': to = 'Active'; assertTransition(from, to); if (from !== 'CanceledAtPeriodEnd') throw conflict('NOT_CANCELED', 'Abonnemanget är inte uppsagt.'); break;
        case 'expire': to = 'Expired'; assertTransition(from, to); break;
        case 'mark_past_due': to = 'PastDue'; assertTransition(from, to); set.past_due_since = new Date(); break;
      }
      set.status = to; set.updated_at = new Date();
      const cols = Object.keys(set);
      await c.query(`update subscriptions set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} where workspace_id = $1`, [id, ...cols.map((k) => set[k])]);
      await audit(c, auditCtx(req), {
        action: `subscription.${b.action}`, severity: to === 'Expired' ? 'warning' : 'info', workspaceId: id, targetType: 'subscription', targetId: s.id, reason: b.reason,
        before: { status: from, planId: s.plan_id, trialEndsAt: s.trial_ends_at }, after: { status: to, planId: set.plan_id ?? s.plan_id, trialEndsAt: set.trial_ends_at ?? s.trial_ends_at },
      });
      await evaluateLimits(c, id);
      return { ok: true, status: to, access: await loadWorkspaceAccess(c, id) };
    });
  });
}
