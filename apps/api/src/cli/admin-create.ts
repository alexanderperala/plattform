import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { ROLES, type Role } from '../domain/permissions.js';
import { hashPassword } from '../lib/crypto.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const email = arg('email');
const name = arg('name');
const role = arg('role') as Role | undefined;
const breakGlass = process.argv.includes('--break-glass');

if (!email || !name || !role || !(ROLES as readonly string[]).includes(role)) {
  console.error(`Användning: npm run admin:create -- --email <e-post> --name "<namn>" --role <${ROLES.join('|')}> [--break-glass]`);
  process.exit(1);
}
const password = process.env.ADMIN_PASSWORD ?? randomBytes(18).toString('base64url');
await pool.query(
  `insert into platform_admins (email, name, role, password_hash, is_break_glass) values ($1,$2,$3,$4,$5)`,
  [email, name, role, await hashPassword(password), breakGlass],
);
console.log(`Administratör skapad: ${email} (${role}${breakGlass ? ', break-glass, förseglat' : ''})`);
if (!process.env.ADMIN_PASSWORD) console.log(`Engångslösenord (visas bara nu): ${password}`);
console.log('MFA registreras vid första inloggningen.');
await pool.end();
