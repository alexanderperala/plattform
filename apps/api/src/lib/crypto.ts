import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { config } from '../config.js';

function scryptAsync(pw: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pw, salt, keylen, opts, (e, k) => (e ? reject(e) : resolve(k))));
}

/** Format: scrypt$N$r$p$salt$hash (parametrar lagras så att de kan höjas utan migration). */
export async function hashPassword(password: string): Promise<string> {
  const N = config.scryptN, r = 8, p = 1;
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, N, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !N || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2,
  });
  return timingSafeEqual(key, expected);
}

/** Jämför mot en dummy-hash så att svarstiden inte avslöjar om kontot finns. */
let dummy: Promise<string> | undefined;
export async function dummyVerify(password: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummy);
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** AES-256-GCM för MFA-hemligheter i vila. Format: iv.tag.ciphertext (base64). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.mfaEncryptionKey, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}
export function decryptSecret(enc: string): string {
  const [iv, tag, ct] = enc.split('.').map((s) => Buffer.from(s, 'base64'));
  if (!iv || !tag || !ct) throw new Error('Ogiltigt krypterat värde');
  const d = createDecipheriv('aes-256-gcm', config.mfaEncryptionKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** Återställningskod i formatet XXXXX-XXXXX (utan förväxlingsbara tecken). */
export function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
export const normalizeRecoveryCode = (c: string): string => c.trim().toUpperCase().replace(/\s/g, '');
