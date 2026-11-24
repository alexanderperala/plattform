import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Ogiltig base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

/** RFC 6238, SHA-1, 6 siffror, 30 sekunders steg. */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const code = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

export const currentStep = (now = Date.now()): number => Math.floor(now / 1000 / 30);

/**
 * Verifierar kod med ±1 steg tolerans. Returnerar det matchande steget, eller null.
 * `lastUsedStep` förhindrar återanvändning av samma kod (replay).
 */
export function verifyTotp(secret: string, code: string, now = Date.now(), lastUsedStep?: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = currentStep(now);
  for (const step of [cur, cur - 1, cur + 1]) {
    if (lastUsedStep != null && step <= lastUsedStep) continue;
    if (totpAt(secret, step) === code) return step;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string, issuer = 'Plattform Superadmin'): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
