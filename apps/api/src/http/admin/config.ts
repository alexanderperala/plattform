import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { camelAll } from '../../lib/camel.js';
import { notFound } from '../../lib/errors.js';
import { auditCtx } from '../context.js';
import { audit } from '../../services/audit.js';
import { getSetting } from '../../services/settings.js';
import { adminRoute } from './guard.js';

const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);

/** Inställningar som kan ändras i UI. Allt valideras i backend med gränser; okända nycklar nekas. */
export const SETTINGS: Record<string, { label: string; description: string; type: 'int' | 'bool'; min?: number; max?: number; unit?: string; critical?: boolean }> = {
  'billing.grace_period_days': { label: 'Respitperiod vid förfallen betalning', description: 'Antal dagar en arbetsyta behåller åtkomst efter förfallen betalning (PastDue). Ingen data raderas automatiskt.', type: 'int', min: 0, max: 90, unit: 'dagar' },
  'trial.default_days': { label: 'Standardlängd för provperiod', description: 'Gäller nya provabonnemang. Påverkar inte befintliga.', type: 'int', min: 0, max: 365, unit: 'dagar' },
  'retention.closed_workspace_days': { label: 'Bevarande efter avslutad arbetsyta', description: 'Efter denna tid blir kunddata gallringskandidat. Radering kräver fortfarande four-eyes.', type: 'int', min: 30, max: 3650, unit: 'dagar' },
  'retention.product_data_months': { label: 'Bevarande efter inaktiverad produktlicens', description: 'Efter denna tid blir produktdata gallringskandidat. Radering kräver fortfarande four-eyes.', type: 'int', min: 1, max: 120, unit: 'månader' },
  'security.allow_sole_owner_self_approval': { label: 'Tillåt ensam ägare att godkänna egen begäran', description: 'Gäller bara när färre än två administratörer kan godkänna. Stäng av när fler administratörer finns.', type: 'bool', critical: true },
};

export function configRoutes(app: FastifyInstance): void {
  // ---------- Funktionsflaggor ----------
  adminRoute(app, { method: 'GET', url: '/flags', access: { perm: 'entitlements.view' } }, async () => {
    const flags = (await pool.query('select key, description, default_enabled from feature_flags order by key')).rows;
    const overrides = (await pool.query(
      `select o.flag_key, o.workspace_id, w.name as workspace_name, o.enabled from feature_flag_overrides o join workspaces w on w.id = o.workspace_id order by lower(w.name)`)).rows;
    return { items: flags.map((f) => ({
      key: f.key, description: f.description, defaultEnabled: f.default_enabled,
      overrides: camelAll(overrides.filter((o) => o.flag_key === f.key).map(({ flag_key: _k, ...r }) => r)),
    })) };
  });

  adminRoute(app, { method: 'PATCH', url: '/flags/:key', access: { perm: 'flags.manage' } }, async (req) => {
    const { key } = z.object({ key: z.string().min(1).max(100) }).parse(req.params);
    const b = z.object({ defaultEnabled: z.boolean(), reason }).parse(req.body);
    return tx(async (c) => {
      const cur = (await c.query('select default_enabled from feature_flags where key = $1 for update', [key])).rows[0];
      if (!cur) throw notFound('Funktionsflaggan finns inte.');
      await c.query('update feature_flags set default_enabled = $2 where key = $1', [key, b.defaultEnabled]);
      await audit(c, auditCtx(req), { action: 'flag.default_changed', severity: 'warning', targetType: 'feature_flag', targetId: key, reason: b.reason,
        before: { defaultEnabled: cur.default_enabled }, after: { defaultEnabled: b.defaultEnabled } });
      return { ok: true };
    });
  });

  // enabled = null tar bort överstyrningen så att standardvärdet gäller
  adminRoute(app, { method: 'PUT', url: '/workspaces/:id/flags/:key', access: { perm: 'flags.manage' } }, async (req) => {
    const p = z.object({ id: uuid, key: z.string().min(1).max(100) }).parse(req.params);
    const b = z.object({ enabled: z.boolean().nullable(), reason }).parse(req.body);
    req.errCtx.workspaceId = p.id;
    return tx(async (c) => {
      if (!(await c.query('select 1 from workspaces where id = $1', [p.id])).rowCount) throw notFound('Arbetsytan hittades inte.');
      if (!(await c.query('select 1 from feature_flags where key = $1', [p.key])).rowCount) throw notFound('Funktionsflaggan finns inte.');
      const prev = (await c.query('select enabled from feature_flag_overrides where workspace_id = $1 and flag_key = $2', [p.id, p.key])).rows[0];
      if (b.enabled === null) await c.query('delete from feature_flag_overrides where workspace_id = $1 and flag_key = $2', [p.id, p.key]);
      else await c.query(`insert into feature_flag_overrides (workspace_id, flag_key, enabled) values ($1,$2,$3) on conflict (workspace_id, flag_key) do update set enabled = excluded.enabled`, [p.id, p.key, b.enabled]);
      await audit(c, auditCtx(req), { action: 'flag.override_changed', workspaceId: p.id, targetType: 'feature_flag', targetId: p.key, reason: b.reason,
        before: { enabled: prev?.enabled ?? null }, after: { enabled: b.enabled } });
      return { ok: true };
    });
  });

  // ---------- Systeminställningar ----------
  adminRoute(app, { method: 'GET', url: '/settings', access: { perm: 'settings.manage' } }, async () => {
    const rows = (await pool.query('select s.key, s.updated_at, a.name as updated_by_name from platform_settings s left join platform_admins a on a.id = s.updated_by')).rows;
    const items = [];
    for (const [key, meta] of Object.entries(SETTINGS)) {
      const r = rows.find((x) => x.key === key);
      items.push({ key, ...meta, value: await getSetting(pool, key), updatedAt: r?.updated_at ?? null, updatedByName: r?.updated_by_name ?? null });
    }
    return { items };
  });

  adminRoute(app, { method: 'PATCH', url: '/settings/:key', access: { perm: 'settings.manage' } }, async (req) => {
    const { key } = z.object({ key: z.string().max(100) }).parse(req.params);
    const meta = SETTINGS[key];
    if (!meta) throw notFound('Inställningen finns inte eller kan inte ändras här.');
    const valueSchema = meta.type === 'bool' ? z.boolean() : z.number().int().min(meta.min ?? 0).max(meta.max ?? 1_000_000);
    const b = z.object({ value: valueSchema, reason }).parse(req.body);
    return tx(async (c) => {
      const before = await getSetting(c, key);
      await c.query(
        `insert into platform_settings (key, value, updated_by, updated_at) values ($1,$2::jsonb,$3,now())
         on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [key, JSON.stringify(b.value), req.admin!.adminId]);
      await audit(c, auditCtx(req), { action: 'settings.updated', severity: meta.critical ? 'warning' : 'info', targetType: 'platform_setting', targetId: key, reason: b.reason, before: { value: before }, after: { value: b.value } });
      return { ok: true };
    });
  });
}
