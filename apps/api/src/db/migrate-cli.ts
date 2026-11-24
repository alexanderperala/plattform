import { pool } from './pool.js';
import { migrate } from './migrate.js';

const applied = await migrate(pool, (m) => console.log(m));
console.log(applied.length ? `${applied.length} migration(er) körda.` : 'Databasen är redan uppdaterad.');
await pool.end();
