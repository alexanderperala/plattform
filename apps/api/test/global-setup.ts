import pg from 'pg';
import { migrate } from '../src/db/migrate.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://plattform:plattform_dev@localhost:5432/plattform_test';

/** Skapar ett rent testschema och kör alla migrationer (testar därmed även migrationerna). */
export default async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: url });
  await pool.query('drop schema public cascade');
  await pool.query('create schema public');
  await migrate(pool);
  await pool.end();
}
