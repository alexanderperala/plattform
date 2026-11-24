import { createHash } from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function encryptionKey(): Buffer {
  const raw = env.MFA_ENCRYPTION_KEY;
  if (raw) {
    const buf = Buffer.from(raw, 'hex');
    if (buf.length !== 32) throw new Error('MFA_ENCRYPTION_KEY måste vara 64 hex-tecken (32 byte)');
    return buf;
  }
  if (isProd) throw new Error('MFA_ENCRYPTION_KEY måste anges i produktion');
  // Enbart för utveckling och test. Aldrig i produktion.
  return createHash('sha256').update('dev-only-mfa-key').digest();
}

export const config = {
  env: env.NODE_ENV ?? 'development',
  isProd,
  isTest,
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://plattform:plattform_dev@localhost:5432/plattform_dev',
  // Superadmin: värdnamn och IP-begränsning (tom lista = ingen begränsning, endast tillåtet utanför produktion)
  adminAllowedHosts: list(env.ADMIN_ALLOWED_HOSTS),
  adminIpAllowlist: list(env.ADMIN_IP_ALLOWLIST),
  adminAllowedOrigins: list(env.ADMIN_ALLOWED_ORIGINS),
  secureCookies: isProd,
  mfaEncryptionKey: encryptionKey(),
  breakglassUnsealKey: env.BREAKGLASS_UNSEAL_KEY ?? '',
  scryptN: Number(env.SCRYPT_N ?? (isTest ? 1024 : 32768)),
  admin: {
    idleMinutes: 30,
    absoluteHours: 8,
    reauthMinutes: 5,
    lockAfterFailures: 5,
    lockMinutes: 15,
    approvalValidHours: 72,
  },
  customer: {
    sessionDays: 14,
  },
  stripe: { secretKey: env.STRIPE_SECRET_KEY ?? '', webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '' },
  mail: {
    // smtp | file (skriver .eml till MAIL_FILE_DIR, för utveckling) | none (skickar inget; utkorgen växer)
    transport: (env.MAIL_TRANSPORT ?? (isTest ? 'none' : 'file')) as 'smtp' | 'file' | 'none',
    from: env.MAIL_FROM ?? 'Plattform <no-reply@example.test>',
    smtpHost: env.SMTP_HOST ?? '',
    smtpPort: Number(env.SMTP_PORT ?? 587),
    smtpUser: env.SMTP_USER ?? '',
    smtpPass: env.SMTP_PASS ?? '',
    smtpSecure: env.SMTP_SECURE === 'true',
    fileDir: env.MAIL_FILE_DIR ?? './.mail-outbox',
    maxAttempts: 6,
  },
  authRateLimit: { max: Number(env.AUTH_RATE_LIMIT_MAX ?? (isTest ? 10000 : 30)), windowMs: 5 * 60_000 },
};

if (isProd && config.adminAllowedHosts.length === 0) {
  throw new Error('ADMIN_ALLOWED_HOSTS måste anges i produktion');
}
if (isProd && config.mail.transport === 'file') {
  throw new Error('MAIL_TRANSPORT=file får inte användas i produktion (sätt smtp eller none)');
}
if (config.mail.transport === 'smtp' && !config.mail.smtpHost) {
  throw new Error('SMTP_HOST måste anges när MAIL_TRANSPORT=smtp');
}
