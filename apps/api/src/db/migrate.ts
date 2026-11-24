import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

/** Kör alla ännu ej körda SQL-migrationer i filnamnsordning. Varje migration körs i egen transaktion. */
export async function migrate(pool: pg.Pool, log: (m: string) => void = () => undefined): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock(727272)');
    await client.query(
      `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
    );
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Migration ${f} misslyckades: ${(e as Error).message}`);
      }
      applied.push(f);
      log(`Körde ${f}`);
    }
  } finally {
    await client.query('select pg_advisory_unlock(727272)').catch(() => undefined);
    client.release();
  }
  return applied;
}
