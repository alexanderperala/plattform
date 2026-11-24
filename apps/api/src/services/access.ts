import pg from 'pg';
import type { Db } from '../db/pool.js';
import { effectiveLimits, isOverLimit, PRODUCTS, type Limits, type Product } from '../domain/entitlements.js';
import {
  resolveAccess, effectiveSubscriptionStatus, graceEndsAt,
  type AccessMode, type EntitlementStatus, type SubscriptionFacts, type SubscriptionStatus, type WorkspaceStatus,
} from '../domain/access.js';
import { getSetting } from './settings.js';

export interface ProductAccess {
  product: Product;
  entitlementStatus: EntitlementStatus | null;
  expiresAt: Date | null;
  limits: Limits;
  usage: Record<string, number>;
  mode: AccessMode;
}
export interface WorkspaceAccess {
  workspaceId: string;
  workspaceStatus: WorkspaceStatus;
  subscription: null | {
    planId: string;
    status: SubscriptionStatus;
    effectiveStatus: SubscriptionStatus;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    pastDueSince: Date | null;
    graceEndsAt: Date | null;
  };
  products: ProductAccess[];
}

/** RLS: räkningen sker alltid med just den arbetsytans kontext, i en egen transaktion när vi inte redan är i en. */
async function countWithContext(db: Db, workspaceId: string, sql: string): Promise<number> {
  const run = async (c: Db): Promise<number> => {
    await c.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return (await c.query<{ n: number }>(sql, [workspaceId])).rows[0]?.n ?? 0;
  };
  if (db instanceof pg.Pool) {
    const c = await db.connect();
    try { await c.query('begin'); const n = await run(c); await c.query('commit'); return n; }
    catch (e) { await c.query('rollback').catch(() => undefined); throw e; }
    finally { c.release(); }
  }
  return run(db);
}

const countAssociationMembers = (db: Db, wid: string) => countWithContext(db, wid, 'select count(*)::int as n from association_members where workspace_id = $1');
/** "Aktiva turneringar" = ej avslutade (avsnitt 4.2). */
const countActiveTournaments = (db: Db, wid: string) => countWithContext(db, wid, `select count(*)::int as n from tournaments where workspace_id = $1 and status <> 'finished'`);

/** Användning per gräns-nyckel. Produktspecifika räknare tillkommer när produkterna byggs. */
export async function workspaceUsage(db: Db, workspaceId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ n: number }>('select count(*)::int as n from workspace_members where workspace_id = $1', [workspaceId]);
  return { max_users: rows[0]?.n ?? 0, max_members: await countAssociationMembers(db, workspaceId), max_tournaments: await countActiveTournaments(db, workspaceId), storage_mb: 0 };
}

export async function loadWorkspaceAccess(db: Db, workspaceId: string, now = new Date()): Promise<WorkspaceAccess | null> {
  const ws = await db.query<{ status: WorkspaceStatus }>('select status from workspaces where id = $1', [workspaceId]);
  if (!ws.rows[0]) return null;
  const sub = await db.query<{
    plan_id: string; status: SubscriptionStatus; trial_ends_at: Date | null; current_period_end: Date | null;
    past_due_since: Date | null; grace_period_days: number | null;
  }>('select plan_id, status, trial_ends_at, current_period_end, past_due_since, grace_period_days from subscriptions where workspace_id = $1', [workspaceId]);
  const s = sub.rows[0];
  const defaultGrace = await getSetting<number>(db, 'billing.grace_period_days');
  const facts: SubscriptionFacts | null = s
    ? { status: s.status, trialEndsAt: s.trial_ends_at, currentPeriodEnd: s.current_period_end, pastDueSince: s.past_due_since, graceDays: s.grace_period_days ?? defaultGrace }
    : null;

  const ents = await db.query<{ product: Product; status: EntitlementStatus; limits_override: Limits; expires_at: Date | null }>(
    'select product, status, limits_override, expires_at from product_entitlements where workspace_id = $1', [workspaceId]);
  const planLimits = s
    ? (await db.query<{ product: Product; limits: Limits }>('select product, limits from plan_entitlements where plan_id = $1', [s.plan_id])).rows
    : [];
  const usage = await workspaceUsage(db, workspaceId);

  const products: ProductAccess[] = PRODUCTS.map((product) => {
    const e = ents.rows.find((x) => x.product === product) ?? null;
    const limits = effectiveLimits(planLimits.find((p) => p.product === product)?.limits ?? {}, e?.limits_override ?? {});
    return {
      product,
      entitlementStatus: e?.status ?? null,
      expiresAt: e?.expires_at ?? null,
      limits,
      usage,
      mode: resolveAccess({
        workspaceStatus: ws.rows[0]!.status,
        subscription: facts,
        entitlement: e ? { status: e.status, expiresAt: e.expires_at } : null,
        now,
      }),
    };
  });

  return {
    workspaceId,
    workspaceStatus: ws.rows[0].status,
    subscription: s && facts
      ? {
          planId: s.plan_id, status: s.status, effectiveStatus: effectiveSubscriptionStatus(facts, now),
          trialEndsAt: s.trial_ends_at, currentPeriodEnd: s.current_period_end, pastDueSince: s.past_due_since,
          graceEndsAt: graceEndsAt(facts),
        }
      : null,
    products,
  };
}

/**
 * Sätter LimitExceeded när någon gräns överskrids och återgår till Enabled när användningen åter är inom gränsen (ENT-2, ENT-3).
 * Rör aldrig Disabled eller Suspended.
 */
export async function evaluateLimits(db: Db, workspaceId: string): Promise<void> {
  const a = await loadWorkspaceAccess(db, workspaceId);
  if (!a) return;
  for (const p of a.products) {
    if (p.entitlementStatus !== 'Enabled' && p.entitlementStatus !== 'LimitExceeded') continue;
    const exceeded = Object.entries(p.limits).some(([k, lim]) => isOverLimit(lim, p.usage[k] ?? 0));
    const next: EntitlementStatus = exceeded ? 'LimitExceeded' : 'Enabled';
    if (next !== p.entitlementStatus) {
      await db.query('update product_entitlements set status = $1, updated_at = now() where workspace_id = $2 and product = $3', [
        next, workspaceId, p.product,
      ]);
    }
  }
}

/** Minsta max_users bland arbetsytans aktiverade produkter (null = obegränsat). */
export function workspaceMaxUsers(a: WorkspaceAccess): number | null {
  const lims = a.products.filter((p) => p.entitlementStatus && p.mode !== 'none').map((p) => p.limits.max_users ?? null);
  const finite = lims.filter((l): l is number => l !== null);
  return finite.length ? Math.min(...finite) : null;
}
