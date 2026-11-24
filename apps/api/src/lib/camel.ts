const toCamel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** Konverterar nycklar på översta nivån (snake_case -> camelCase). JSON-kolumner lämnas orörda. */
export function camel<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out as T;
}
export const camelAll = <T = Record<string, unknown>>(rows: Record<string, unknown>[]): T[] => rows.map((r) => camel<T>(r));
