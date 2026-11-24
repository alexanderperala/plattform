// Demodata för UTVECKLING. Körs aldrig i produktion.
import { config } from '../config.js';
import { pool } from './pool.js';
import { migrate } from './migrate.js';
import { hashPassword, encryptSecret, sha256Hex } from '../lib/crypto.js';

if (config.isProd) { console.error('Seed får inte köras i produktion.'); process.exit(1); }
await migrate(pool);

const DEV_PASSWORD = 'DevAdminPassword!2026';
const DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXP'; // endast dev: lägg in i autentiseringsappen
const hash = await hashPassword(DEV_PASSWORD);

const admins: Array<[string, string, string]> = [
  ['owner@example.test', 'Olivia Ägare', 'platform_owner'],
  ['super@example.test', 'Sven Super', 'superadmin'],
  ['support@example.test', 'Sara Support', 'support_admin'],
  ['billing@example.test', 'Bo Billing', 'billing_admin'],
  ['tech@example.test', 'Tora Tekniker', 'technical_admin'],
  ['readonly@example.test', 'Rolf Läsare', 'readonly_admin'],
];
for (const [email, name, role] of admins) {
  await pool.query(
    `insert into platform_admins (email, name, role, password_hash, mfa_secret_enc, mfa_enrolled_at)
     values ($1,$2,$3,$4,$5, now()) on conflict (lower(email)) do nothing`,
    [email, name, role, hash, encryptSecret(DEV_TOTP_SECRET)]);
}
await pool.query(
  `insert into platform_admins (email, name, role, password_hash, is_break_glass, mfa_secret_enc, mfa_enrolled_at)
   values ('breakglass@example.test','Break Glass','platform_owner',$1,true,$2,now()) on conflict (lower(email)) do nothing`, [hash, encryptSecret(DEV_TOTP_SECRET)]);

const names = ['Södra IF', 'Malmö Bordtennisklubb', 'Kvarnbyns Schackklubb', 'Lunds Flipperförening', 'Västra Hamnens BRF', 'Nordic Darts Arrangörer',
  'Skåne Pingisliga', 'Ystads Bowlingklubb', 'Helsingborgs Biljardsällskap', 'Trelleborgs Boule', 'Kristianstad Squashförening', 'Landskrona Padelklubb',
  'Eslövs Fotbollsklubb', 'Höörs Schackförening', 'Hässleholms Dartklubb', 'Båstads Tennisklubb', 'Ängelholms Flipperliga', 'Svedala Bordshockey',
  'Vellinge Curling', 'Staffanstorps Kortspelare', 'Burlövs Brädspelsförening', 'Kävlinge Padel', 'Sjöbo Skytteförening', 'Tomelilla Bowling',
  'Simrishamns Segelklubb', 'Örkelljunga Biljard', 'Perstorp Pingis', 'Bjuv Boule', 'Åstorps Arrangörsnätverk', 'Klippans Konstklubb'];
const plans = ['start', 'standard', 'pro'];
let n = 0;
for (const name of names) {
  n++;
  const exists = (await pool.query('select 1 from workspaces where name = $1', [name])).rowCount;
  if (exists) continue;
  const email = `kontakt${n}@example.test`;
  const kind = n % 6 === 0 ? 'organizer' : 'association';
  const ws = (await pool.query(
    `insert into workspaces (name, kind, org_number, contact_name, contact_email, status, created_at, last_activity_at, terms_version, dpa_version, terms_accepted_at)
     values ($1,$2,$3,$4,$5,$6, now() - make_interval(days => $7), now() - make_interval(hours => $8), 'v1','v1', now()) returning id`,
    [name, kind, `8${String(10000 + n).padStart(5, '0')}-${1000 + n}`, `Kontaktperson ${n}`, email, n === 7 ? 'Suspended' : n === 12 ? 'Closed' : 'Active', n * 9, n * 5])).rows[0];
  const uid = (await pool.query(`insert into users (email, name, password_hash, email_verified_at, last_login_at, phone) values ($1,$2,$3, now(), now() - make_interval(days => $4), $5) returning id`,
    [email, `Kontaktperson ${n}`, hash, n % 5, `070123${String(1000 + n)}`])).rows[0].id;
  await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')`, [ws.id, uid]);
  for (let k = 0; k < (n % 4); k++) {
    const mu = (await pool.query(`insert into users (email, name, password_hash, last_login_at) values ($1,$2,$3, now() - make_interval(days => $4)) returning id`,
      [`medlem${n}_${k}@example.test`, `Medlem ${n}-${k}`, k === 2 ? null : hash, k * 11])).rows[0].id;
    await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,$3)`, [ws.id, mu, k === 0 ? 'admin' : 'member']);
  }
  // Abonnemang i varierande status
  const mode = n % 6;
  const plan = plans[n % 3]!;
  if (mode === 0) await pool.query(`insert into subscriptions (workspace_id, plan_id, status, trial_ends_at) values ($1,'trial','Trialing', now() + make_interval(days => $2))`, [ws.id, 3 + n % 20]);
  else if (mode === 1) await pool.query(`insert into subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end) values ($1,$2,'Active', now() - interval '10 days', now() + interval '20 days')`, [ws.id, plan]);
  else if (mode === 2) await pool.query(`insert into subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end, past_due_since) values ($1,$2,'PastDue', now() - interval '40 days', now() - interval '10 days', now() - interval '5 days')`, [ws.id, plan]);
  else if (mode === 3) await pool.query(`insert into subscriptions (workspace_id, plan_id, status, trial_ends_at) values ($1,'trial','Expired', now() - interval '20 days')`, [ws.id]);
  else if (mode === 4) await pool.query(`insert into subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end) values ($1,$2,'CanceledAtPeriodEnd', now() - interval '20 days', now() + interval '10 days')`, [ws.id, plan]);
  else await pool.query(`insert into subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end) values ($1,$2,'Active', now() - interval '5 days', now() + interval '25 days')`, [ws.id, plan]);
  const products = n % 3 === 0 ? ['association_portal', 'tournament_system'] : n % 2 === 0 ? ['tournament_system'] : ['association_portal'];
  for (const p of products) await pool.query(`insert into product_entitlements (workspace_id, product, status, source) values ($1,$2,'Enabled','plan')`, [ws.id, p]);
  if (n % 8 === 0) await pool.query(`insert into product_entitlements (workspace_id, product, status) values ($1,$2,'Disabled') on conflict do nothing`, [ws.id, products[0] === 'association_portal' ? 'tournament_system' : 'association_portal']);
}

const first = (await pool.query(`select id from workspaces order by created_at limit 1`)).rows[0];
const admin = (await pool.query(`select id from platform_admins where email = 'support@example.test'`)).rows[0];
if (first && admin && !(await pool.query('select 1 from support_cases')).rowCount) {
  const cases: Array<[string, string, string, string]> = [
    ['Kan inte logga in efter byte av e-post', 'account_login', 'high', 'New'], ['Fel poäng i serietabellen', 'results_scoring', 'normal', 'InProgress'],
    ['Fråga om uppgradering', 'subscription', 'low', 'WaitingCustomer'], ['Betalning dras två gånger', 'payments', 'critical', 'New'], ['Importera medlemmar från Excel', 'member_admin', 'normal', 'Resolved'],
  ];
  for (const [s, cat, pri, st] of cases) {
    await pool.query(`insert into support_cases (subject, description, category, priority, status, workspace_id, created_by_admin_id, assigned_admin_id) values ($1,'Exempelärende för utveckling.',$2,$3,$4,$5,$6,$6)`, [s, cat, pri, st, first.id, admin.id]);
  }
}
if (!(await pool.query('select 1 from system_errors')).rowCount && first) {
  await pool.query(`insert into system_errors (request_id, workspace_id, method, route, status_code, code, message) values
    ('demo-1',$1,'POST','/api/v1/workspaces/:wid/members',500,'INTERNAL','Exempel: tidsgräns vid anrop mot extern tjänst'),
    ('demo-2',null,'GET','/api/platform-admin/dashboard',500,'INTERNAL','Exempel: anslutning avbröts')`, [first.id]);
}
void sha256Hex;

console.log('Seed klar.');
console.log(`Administratörer (lösenord: ${DEV_PASSWORD}):`);
for (const [email, , role] of admins) console.log(`  ${email}  (${role})`);
console.log(`MFA (endast dev) – TOTP-hemlighet: ${DEV_TOTP_SECRET}`);
console.log('Break-glass: breakglass@example.test (förseglat tills det öppnas med CLI)');
await pool.end();
