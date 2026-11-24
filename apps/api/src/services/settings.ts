import type { Db } from '../db/pool.js';

const DEFAULTS: Record<string, unknown> = {
  'billing.grace_period_days': 14,
  'trial.default_days': 30,
  'retention.closed_workspace_days': 90,
  'retention.product_data_months': 12,
  'security.allow_sole_owner_self_approval': true,
};

export async function getSetting<T>(db: Db, key: string): Promise<T> {
  const { rows } = await db.query<{ value: T }>('select value from platform_settings where key = $1', [key]);
  return (rows[0]?.value ?? DEFAULTS[key]) as T;
}
