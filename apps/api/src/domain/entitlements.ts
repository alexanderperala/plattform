export type Product = 'association_portal' | 'tournament_system';
export const PRODUCTS: Product[] = ['association_portal', 'tournament_system'];
export type Limits = Record<string, number | null>;

/** Effektiv gräns: överstyrning om den finns (även null = obegränsat), annars planens gräns. */
export function effectiveLimits(planLimits: Limits, override: Limits): Limits {
  const out: Limits = { ...planLimits };
  for (const [k, v] of Object.entries(override)) out[k] = v;
  return out;
}

export function isOverLimit(limit: number | null | undefined, usage: number): boolean {
  return limit != null && usage > limit;
}
