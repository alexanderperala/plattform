import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { sha256Hex } from '../src/lib/crypto.js';
import { currentStep, totpAt } from '../src/lib/totp.js';
import { openBreakGlass, sealBreakGlass } from '../src/services/breakglass.js';
import { runMaintenance } from '../src/jobs/maintenance.js';
import { PASSWORD, adminCall, auditRows, cookieFrom, createAdmin, loginAdmin, makeApp, resetDb, setReauth } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

describe('inloggning', () => {
  it('lösenord + MFA ger aktiv session och audit-post', async () => {
    const a = await createAdmin('superadmin');
    const cookie = await loginAdmin(app, a);
    const me = await adminCall(app, { method: 'GET', url: '/auth/me', cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().admin.email).toBe(a.email);
    expect(me.json().permissions).toContain('workspaces.close');
    expect((await auditRows(`action = 'admin.login' and admin_id = $1`, [a.id])).length).toBe(1);
  });

  it('sessionscookien är HttpOnly och SameSite=Strict', async () => {
    const a = await createAdmin('superadmin');
    const r = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    const c = r.cookies.find((x) => x.name === 'padm_session')!;
    expect(c.httpOnly).toBe(true);
    expect(String(c.sameSite).toLowerCase()).toBe('strict');
  });

  it('samma felmeddelande för okänt konto och fel lösenord (SEC-6)', async () => {
    const a = await createAdmin('superadmin');
    const wrong = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: 'fel-lösenord-123' } });
    const unknown = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: 'finns-inte@example.test', password: 'fel-lösenord-123' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    expect(wrong.json().error.code).toBe(unknown.json().error.code);
  });

  it('kontot låses efter 5 misslyckade försök, även med rätt lösenord därefter', async () => {
    const a = await createAdmin('superadmin');
    for (let i = 0; i < 5; i++) {
      const r = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: 'fel-lösenord-123' } });
      expect(r.statusCode).toBe(401);
    }
    const afterLock = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    expect(afterLock.statusCode).toBe(401);
    expect(afterLock.json().error.code).toBe('INVALID_CREDENTIALS'); // avslöjar inte att kontot är låst
    expect((await auditRows(`action = 'admin.locked'`)).length).toBe(1);
    // låsningen går ut
    await pool.query(`update platform_admins set locked_until = now() - interval '1 minute' where id = $1`, [a.id]);
    const ok = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
  });

  it('inaktiverat konto kan inte logga in', async () => {
    const a = await createAdmin('superadmin');
    await pool.query(`update platform_admins set status = 'disabled' where id = $1`, [a.id]);
    const r = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    expect(r.statusCode).toBe(401);
  });

  it('inloggningsförsök loggas i login_history', async () => {
    const a = await createAdmin('superadmin');
    await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: 'fel-lösenord-123' } });
    const h = (await pool.query(`select success, reason from login_history where subject_type = 'admin' and subject_id = $1`, [a.id])).rows;
    expect(h).toEqual([{ success: false, reason: 'bad_password' }]);
  });
});

describe('MFA är obligatoriskt (SEC-2)', () => {
  it('efter lösenord men före MFA nekas all annan åtkomst', async () => {
    const a = await createAdmin('platform_owner');
    const r1 = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    expect(r1.json().stage).toBe('mfa_pending');
    const cookie = cookieFrom(r1, 'padm_session')!;
    for (const url of ['/dashboard', '/workspaces', '/users', '/audit']) {
      const r = await adminCall(app, { method: 'GET', url, cookie });
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error.code).toBe('MFA_REQUIRED');
    }
  });

  it('fel MFA-kod nekas och räknas mot låsning', async () => {
    const a = await createAdmin('platform_owner');
    const r1 = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    const cookie = cookieFrom(r1, 'padm_session')!;
    const r2 = await adminCall(app, { method: 'POST', url: '/auth/mfa/verify', cookie, payload: { code: '000000' } });
    expect(r2.statusCode).toBe(401);
    expect(r2.json().error.code).toBe('INVALID_MFA');
    const { failed_count } = (await pool.query('select failed_count from platform_admins where id = $1', [a.id])).rows[0];
    expect(failed_count).toBe(1);
  });

  it('samma TOTP-kod kan inte användas två gånger (replay)', async () => {
    const a = await createAdmin('platform_owner');
    await loginAdmin(app, a); // förbrukar nuvarande steg
    const r1 = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    const cookie = cookieFrom(r1, 'padm_session')!;
    const replay = await adminCall(app, { method: 'POST', url: '/auth/mfa/verify', cookie, payload: { code: totpAt(a.secret, currentStep()) } });
    expect(replay.statusCode).toBe(401);
  });

  it('administratör utan MFA kan bara registrera MFA, sedan fås återställningskoder', async () => {
    const a = await createAdmin('superadmin', { mfa: false });
    const r1 = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    expect(r1.json().stage).toBe('mfa_enroll');
    const c1 = cookieFrom(r1, 'padm_session')!;
    expect((await adminCall(app, { method: 'GET', url: '/dashboard', cookie: c1 })).statusCode).toBe(403);
    const start = await adminCall(app, { method: 'POST', url: '/auth/mfa/enroll/start', cookie: c1 });
    expect(start.statusCode).toBe(200);
    const secret = start.json().secret as string;
    expect(start.json().otpauthUri).toContain('otpauth://totp/');
    const bad = await adminCall(app, { method: 'POST', url: '/auth/mfa/enroll/confirm', cookie: c1, payload: { code: '000000' } });
    expect(bad.statusCode).toBe(401);
    const ok = await adminCall(app, { method: 'POST', url: '/auth/mfa/enroll/confirm', cookie: c1, payload: { code: totpAt(secret, currentStep()) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodes).toHaveLength(10);
    const c2 = cookieFrom(ok, 'padm_session')!;
    expect(c2).not.toBe(c1); // ny token vid stegbyte
    expect((await adminCall(app, { method: 'GET', url: '/dashboard', cookie: c2 })).statusCode).toBe(200);
    expect((await adminCall(app, { method: 'GET', url: '/dashboard', cookie: c1 })).statusCode).toBe(401); // gamla sessionen är återkallad
    // hemligheten lagras krypterad
    const row = (await pool.query('select mfa_secret_enc from platform_admins where id = $1', [a.id])).rows[0];
    expect(row.mfa_secret_enc).not.toContain(secret);
  });

  it('återställningskod fungerar som MFA-kod en gång och varnar när få återstår', async () => {
    const a = await createAdmin('superadmin', { mfa: false });
    const r1 = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    const c1 = cookieFrom(r1, 'padm_session')!;
    const secret = (await adminCall(app, { method: 'POST', url: '/auth/mfa/enroll/start', cookie: c1 })).json().secret as string;
    const done = await adminCall(app, { method: 'POST', url: '/auth/mfa/enroll/confirm', cookie: c1, payload: { code: totpAt(secret, currentStep()) } });
    const codes = done.json().recoveryCodes as string[];
    // koderna lagras som hash
    const stored = (await pool.query('select code_hash from platform_admin_recovery_codes where admin_id = $1', [a.id])).rows.map((r) => r.code_hash);
    expect(stored).toContain(sha256Hex(codes[0]!));
    expect(stored).not.toContain(codes[0]);

    const login = async (code: string) => {
      const r = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
      return adminCall(app, { method: 'POST', url: '/auth/mfa/verify', cookie: cookieFrom(r, 'padm_session')!, payload: { recoveryCode: code } });
    };
    const first = await login(codes[0]!);
    expect(first.statusCode).toBe(200);
    expect(first.json().recoveryCodesLeft).toBe(9);
    expect((await login(codes[0]!)).statusCode).toBe(401); // förbrukad
    for (let i = 1; i <= 6; i++) await login(codes[i]!);
    const last = await login(codes[7]!);
    expect(last.json().recoveryCodesLeft).toBe(2);
    expect(last.json().lowRecoveryCodes).toBe(true);
  });
});

describe('sessioner (SEC-4, SEC-11)', () => {
  it('inaktivitetstimeout på 30 minuter', async () => {
    const a = await createAdmin('superadmin');
    const cookie = await loginAdmin(app, a);
    await pool.query(`update platform_admin_sessions set last_seen_at = now() - interval '31 minutes' where admin_id = $1`, [a.id]);
    const r = await adminCall(app, { method: 'GET', url: '/dashboard', cookie });
    expect(r.statusCode).toBe(401);
  });

  it('absolut livslängd på 8 timmar', async () => {
    const a = await createAdmin('superadmin');
    const cookie = await loginAdmin(app, a);
    await pool.query(`update platform_admin_sessions set expires_at = now() - interval '1 second' where admin_id = $1`, [a.id]);
    expect((await adminCall(app, { method: 'GET', url: '/dashboard', cookie })).statusCode).toBe(401);
    const lifetime = (await pool.query(`select extract(epoch from (expires_at - created_at))/3600 as h from platform_admin_sessions where admin_id = $1 order by created_at desc limit 1`, [a.id])).rows[0].h;
    expect(Number(lifetime)).toBeLessThanOrEqual(8.01);
  });

  it('utloggning återkallar sessionen', async () => {
    const a = await createAdmin('superadmin');
    const cookie = await loginAdmin(app, a);
    expect((await adminCall(app, { method: 'POST', url: '/auth/logout', cookie })).statusCode).toBe(200);
    expect((await adminCall(app, { method: 'GET', url: '/dashboard', cookie })).statusCode).toBe(401);
  });

  it('avregistrerad token i databasen: endast hash lagras', async () => {
    const a = await createAdmin('superadmin');
    const cookie = await loginAdmin(app, a);
    const token = cookie.split('=')[1]!;
    const rows = (await pool.query('select token_hash from platform_admin_sessions where admin_id = $1', [a.id])).rows;
    expect(rows.map((r) => r.token_hash)).toContain(sha256Hex(token));
    expect(rows.map((r) => r.token_hash)).not.toContain(token);
  });
});

describe('åter-autentisering och orsak (SEC-5)', () => {
  it('känslig åtgärd kräver nylig MFA-bekräftelse', async () => {
    const a = await createAdmin('superadmin');
    const cookie = await loginAdmin(app, a);
    const ws = (await pool.query(`insert into workspaces (name, contact_name, contact_email) values ('X','K','k@example.test') returning id`)).rows[0];
    await setReauth(cookie, 6); // äldre än 5 minuter
    const denied = await adminCall(app, { method: 'POST', url: `/workspaces/${ws.id}/suspend`, cookie, payload: { reason: 'Misstänkt missbruk av tjänsten' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('REAUTH_REQUIRED');
    // bekräfta med nästa TOTP-steg (steg ≤ senast använda avvisas)
    const re = await adminCall(app, { method: 'POST', url: '/auth/reauth', cookie, payload: { code: totpAt(a.secret, currentStep() + 1) } });
    expect(re.statusCode).toBe(200);
    const ok = await adminCall(app, { method: 'POST', url: `/workspaces/${ws.id}/suspend`, cookie, payload: { reason: 'Misstänkt missbruk av tjänsten' } });
    expect(ok.statusCode).toBe(200);
  });

  it('orsak krävs och måste vara minst 10 tecken', async () => {
    const a = await createAdmin('superadmin');
    const cookie = await loginAdmin(app, a);
    const ws = (await pool.query(`insert into workspaces (name, contact_name, contact_email) values ('X','K','k@example.test') returning id`)).rows[0];
    for (const payload of [{}, { reason: 'kort' }, { reason: '          ' }]) {
      const r = await adminCall(app, { method: 'POST', url: `/workspaces/${ws.id}/suspend`, cookie, payload });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('REASON_REQUIRED');
    }
  });
});

describe('skydd mot CSRF och felaktig värd (SEC-7, SEC-8)', () => {
  it('POST utan säkerhetsrubrik nekas', async () => {
    const a = await createAdmin('superadmin');
    const r = await app.inject({ method: 'POST', url: '/api/platform-admin/auth/login', payload: { email: a.email, password: PASSWORD } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CSRF_HEADER_MISSING');
  });

  it('främmande Origin nekas', async () => {
    const a = await createAdmin('superadmin');
    const r = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD }, headers: { origin: 'https://evil.example', host: 'admin.plattform.se' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('CSRF_ORIGIN');
  });

  it('värdnamnsbegränsning döljer adminytan på andra värdar', async () => {
    config.adminAllowedHosts.push('admin.plattform.se');
    try {
      const a = await createAdmin('superadmin');
      const wrong = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD }, headers: { host: 'www.plattform.se' } });
      expect(wrong.statusCode).toBe(404);
      const right = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD }, headers: { host: 'admin.plattform.se' } });
      expect(right.statusCode).toBe(200);
    } finally { config.adminAllowedHosts.length = 0; }
  });

  it('IP-begränsning nekar andra adresser', async () => {
    config.adminIpAllowlist.push('10.9.9.9');
    try {
      const a = await createAdmin('superadmin');
      const r = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
      expect(r.statusCode).toBe(404);
    } finally { config.adminIpAllowlist.length = 0; }
  });

  it('kundsession och adminsession är separata (ARK-5)', async () => {
    const a = await createAdmin('superadmin');
    const adminCookie = await loginAdmin(app, a);
    const asCustomer = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: adminCookie, 'x-requested-with': 'platform-customer' } });
    expect(asCustomer.statusCode).toBe(401);
    const custCookie = 'cust_session=' + 'x'.repeat(40);
    const asAdmin = await adminCall(app, { method: 'GET', url: '/dashboard', cookie: custCookie });
    expect(asAdmin.statusCode).toBe(401);
  });
});

describe('break-glass (avsnitt 7.3)', () => {
  it('förseglat konto kan inte logga in även med rätt lösenord', async () => {
    const bg = await createAdmin('platform_owner', { breakGlass: true });
    const r = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: bg.email, password: PASSWORD } });
    expect(r.statusCode).toBe(401);
    expect((await pool.query(`select reason from login_history where subject_id = $1`, [bg.id])).rows[0].reason).toBe('sealed');
  });

  it('öppning kräver orsak, begränsas till 60 minuter, loggas som critical och notifierar ägare', async () => {
    const owner = await createAdmin('platform_owner');
    await createAdmin('platform_owner', { breakGlass: true });
    await expect(openBreakGlass(pool, { reason: 'kort', minutes: 30, operator: 'test' })).rejects.toThrow();
    await expect(openBreakGlass(pool, { reason: 'Ägaren har förlorat MFA-enhet', minutes: 61, operator: 'test' })).rejects.toThrow();
    await openBreakGlass(pool, { reason: 'Ägaren har förlorat MFA-enhet', minutes: 30, operator: 'test' });
    const rows = await auditRows(`action = 'breakglass.opened'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe('critical');
    const mail = (await pool.query(`select to_email from notification_outbox where template = 'breakglass_opened'`)).rows;
    expect(mail.map((m) => m.to_email)).toEqual([owner.email]);
  });

  it('öppet konto kan logga in, åtgärder markeras break_glass och sessionen begränsas till öppettiden', async () => {
    const bg = await createAdmin('platform_owner', { breakGlass: true });
    await openBreakGlass(pool, { reason: 'Nödåtkomst vid förlorad MFA', minutes: 20, operator: 'test' });
    const cookie = await loginAdmin(app, bg);
    const s = (await pool.query(`select break_glass, extract(epoch from (expires_at - now()))/60 as min from platform_admin_sessions where admin_id = $1 and stage = 'active'`, [bg.id])).rows[0];
    expect(s.break_glass).toBe(true);
    expect(Number(s.min)).toBeLessThanOrEqual(20.1);
    const me = await adminCall(app, { method: 'GET', url: '/auth/me', cookie });
    expect(me.json().admin.breakGlass).toBe(true);
    const login = await auditRows(`action = 'admin.login' and admin_id = $1`, [bg.id]);
    expect(login[0]!.break_glass).toBe(true);
    expect(login[0]!.severity).toBe('critical');
  });

  it('förseglas automatiskt när tiden löper ut: sessionen dör och underhållsjobbet förseglar', async () => {
    const bg = await createAdmin('platform_owner', { breakGlass: true });
    await openBreakGlass(pool, { reason: 'Nödåtkomst vid förlorad MFA', minutes: 20, operator: 'test' });
    const cookie = await loginAdmin(app, bg);
    await pool.query(`update platform_admins set breakglass_open_until = now() - interval '1 second' where id = $1`, [bg.id]);
    expect((await adminCall(app, { method: 'GET', url: '/dashboard', cookie })).statusCode).toBe(401);
    const r = await runMaintenance();
    expect(r.breakGlassSealed).toBe(1);
    expect((await auditRows(`action = 'breakglass.sealed'`)).length).toBe(1);
    const again = await adminCall(app, { method: 'POST', url: '/auth/login', payload: { email: bg.email, password: PASSWORD } });
    expect(again.statusCode).toBe(401);
  });

  it('manuell förseglning avslutar sessioner', async () => {
    const bg = await createAdmin('platform_owner', { breakGlass: true });
    await openBreakGlass(pool, { reason: 'Nödåtkomst vid förlorad MFA', minutes: 20, operator: 'test' });
    const cookie = await loginAdmin(app, bg);
    await sealBreakGlass(pool, 'manual');
    expect((await adminCall(app, { method: 'GET', url: '/dashboard', cookie })).statusCode).toBe(401);
  });
});
