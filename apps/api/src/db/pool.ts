import pg from 'pg';
import { config } from '../config.js';

// Returnera numeric (count/sum) som tal och bigint som tal där det är säkert
pg.types.setTypeParser(20, (v) => Number(v)); // int8

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export type Db = pg.Pool | pg.PoolClient;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Kör en transaktion med arbetsytan satt för Row-Level Security. Alla produkttabeller nås bara härigenom,
 * så en glömd `where workspace_id` kan inte läcka data mellan kunder (SEC-14, försvar på djupet).
 */
export async function withWorkspace<T>(workspaceId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return tx(async (c) => {
    await c.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId]);
    return fn(c);
  });
}
