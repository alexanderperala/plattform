import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { openBreakGlass, sealBreakGlass } from '../services/breakglass.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const cmd = process.argv[2];

try {
  if (cmd === 'status') {
    const r = await pool.query(`select email, breakglass_open_until from platform_admins where is_break_glass`);
    console.log(r.rows.length ? r.rows.map((x) => `${x.email}: ${x.breakglass_open_until && x.breakglass_open_until > new Date() ? 'ÖPPET till ' + x.breakglass_open_until.toISOString() : 'förseglat'}`).join('\n') : 'Inget break-glass-konto finns.');
  } else if (cmd === 'enable') {
    if (!config.breakglassUnsealKey) throw new Error('BREAKGLASS_UNSEAL_KEY är inte satt i serverns miljö.');
    const key = arg('key') ?? '';
    if (!safeEqual(key, config.breakglassUnsealKey)) throw new Error('Fel nyckel.');
    const r = await openBreakGlass(pool, { reason: arg('reason') ?? '', minutes: Number(arg('minutes') ?? 60), operator: process.env.USER ?? 'server-cli' });
    console.log(`Break-glass (${r.email}) öppet till ${r.openUntil.toISOString()}. Alla Platform Owners har notifierats.`);
  } else if (cmd === 'disable') {
    const n = await sealBreakGlass(pool, 'manual');
    console.log(n ? 'Break-glass förseglat.' : 'Ingenting att försegla.');
  } else {
    console.log('Användning: npm run breakglass -- status | enable --key <nyckel> --reason "<orsak>" --minutes 60 | disable');
  }
} catch (e) {
  console.error('Fel:', (e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
