import { config } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { runMaintenance } from './jobs/maintenance.js';
import { createTransport, deliverOutbox } from './services/mailer.js';

await migrate(pool, (m) => console.log(m));
const app = await buildApp();
await app.listen({ port: config.port, host: process.env.HOST ?? '127.0.0.1' });

const timer = setInterval(() => {
  runMaintenance().catch((e) => app.log.error({ err: e }, 'Underhållsjobb misslyckades'));
}, 5 * 60_000);

const transport = createTransport();
console.log(`E-posttransport: ${transport?.name ?? 'ingen (utkorgen skickas inte)'}`);
let delivering = false;
const mailTimer = setInterval(() => {
  if (delivering) return;
  delivering = true;
  deliverOutbox(pool, transport).catch((e) => app.log.error({ err: e }, 'Utkorgsleverans misslyckades')).finally(() => { delivering = false; });
}, 15_000);

const stop = async () => { clearInterval(timer); clearInterval(mailTimer); await app.close(); await pool.end(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
