import { describe, expect, it } from 'vitest';
import { resolveAccess, type AccessMode, type SubscriptionFacts, type SubscriptionStatus, type EntitlementStatus, type WorkspaceStatus } from '../src/domain/access.js';
import { canTransition, assertTransition } from '../src/domain/subscription.js';
import { effectiveLimits, isOverLimit } from '../src/domain/entitlements.js';
import { base32Decode, base32Encode, currentStep, totpAt, verifyTotp } from '../src/lib/totp.js';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { maskDeep, maskString, maskPhone } from '../src/lib/mask.js';
import { assertStrongPassword } from '../src/lib/passwords.js';

const now = new Date('2026-11-24T12:00:00Z');
const day = 86_400_000;
const sub = (status: SubscriptionStatus, over: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({ status, graceDays: 14, ...over });

function access(w: WorkspaceStatus, s: SubscriptionFacts | null, e: EntitlementStatus | null, expiresAt?: Date): AccessMode {
  return resolveAccess({ workspaceStatus: w, subscription: s, entitlement: e ? { status: e, expiresAt } : null, now });
}

describe('resolveAccess (avsnitt 4.4)', () => {
  it('full åtkomst vid Active/Active/Enabled', () => expect(access('Active', sub('Active'), 'Enabled')).toBe('full'));
  it('Closed arbetsyta ger export_only oavsett övrigt', () => {
    expect(access('Closed', sub('Active'), 'Enabled')).toBe('export_only');
  });
  it('Suspended arbetsyta ger read_only', () => expect(access('Suspended', sub('Active'), 'Enabled')).toBe('read_only'));
  it('Expired abonnemang ger none', () => expect(access('Active', sub('Expired'), 'Enabled')).toBe('none'));
  it('Paused abonnemang ger read_only', () => expect(access('Active', sub('Paused'), 'Enabled')).toBe('read_only'));
  it('Trialing och CanceledAtPeriodEnd ger full', () => {
    expect(access('Active', sub('Trialing', { trialEndsAt: new Date(+now + day) }), 'Enabled')).toBe('full');
    expect(access('Active', sub('CanceledAtPeriodEnd', { currentPeriodEnd: new Date(+now + day) }), 'Enabled')).toBe('full');
  });
  it('PastDue är full inom respitperioden och read_only efter', () => {
    expect(access('Active', sub('PastDue', { pastDueSince: new Date(+now - 13 * day) }), 'Enabled')).toBe('full');
    expect(access('Active', sub('PastDue', { pastDueSince: new Date(+now - 15 * day) }), 'Enabled')).toBe('read_only');
  });
  it('respitperioden är konfigurerbar', () => {
    expect(access('Active', sub('PastDue', { pastDueSince: new Date(+now - 5 * day), graceDays: 3 }), 'Enabled')).toBe('read_only');
  });
  it('utgången provperiod behandlas som Expired även om raden inte uppdaterats (KRAV-S2)', () => {
    expect(access('Active', sub('Trialing', { trialEndsAt: new Date(+now - 1000) }), 'Enabled')).toBe('none');
  });
  it('uppsägning som passerat periodens slut behandlas som Expired', () => {
    expect(access('Active', sub('CanceledAtPeriodEnd', { currentPeriodEnd: new Date(+now - 1000) }), 'Enabled')).toBe('none');
  });
  it('produktlicens styr per produkt', () => {
    expect(access('Active', sub('Active'), 'Disabled')).toBe('none');
    expect(access('Active', sub('Active'), 'Suspended')).toBe('read_only');
    expect(access('Active', sub('Active'), 'LimitExceeded')).toBe('limited');
    expect(access('Active', sub('Active'), null)).toBe('none');
  });
  it('tillfällig licens som löpt ut ger none', () => {
    expect(access('Active', sub('Active'), 'Enabled', new Date(+now - 1000))).toBe('none');
    expect(access('Active', sub('Active'), 'Enabled', new Date(+now + day))).toBe('full');
  });
  it('mest restriktiva läget vinner', () => {
    expect(access('Suspended', sub('Expired'), 'LimitExceeded')).toBe('none');
    expect(access('Closed', sub('Paused'), 'Suspended')).toBe('export_only');
  });
  it('saknat abonnemang ger none', () => expect(access('Active', null, 'Enabled')).toBe('none'));
});

describe('abonnemangets statusmaskin (avsnitt 4.2)', () => {
  it('tillåtna övergångar', () => {
    expect(canTransition('Trialing', 'Active')).toBe(true);
    expect(canTransition('Active', 'PastDue')).toBe(true);
    expect(canTransition('PastDue', 'Active')).toBe(true);
    expect(canTransition('CanceledAtPeriodEnd', 'Active')).toBe(true);
    expect(canTransition('Expired', 'Trialing')).toBe(true);
  });
  it('otillåtna övergångar nekas', () => {
    expect(canTransition('Expired', 'Paused')).toBe(false);
    expect(canTransition('Trialing', 'PastDue')).toBe(false);
    expect(canTransition('Paused', 'CanceledAtPeriodEnd')).toBe(false);
    expect(() => assertTransition('Expired', 'PastDue')).toThrow(/kan inte gå/);
  });
});

describe('entitlement-gränser', () => {
  it('överstyrning vinner över plan, null betyder obegränsat', () => {
    expect(effectiveLimits({ max_users: 5, storage_mb: 100 }, { max_users: 50 })).toEqual({ max_users: 50, storage_mb: 100 });
    expect(effectiveLimits({ max_users: 5 }, { max_users: null }).max_users).toBeNull();
  });
  it('isOverLimit', () => {
    expect(isOverLimit(5, 6)).toBe(true);
    expect(isOverLimit(5, 5)).toBe(false);
    expect(isOverLimit(null, 1_000_000)).toBe(false);
  });
});

describe('TOTP (RFC 6238)', () => {
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
  it('matchar RFC 6238:s testvektorer (sista 6 siffrorna)', () => {
    expect(totpAt(rfcSecret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(rfcSecret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(rfcSecret, Math.floor(1234567890 / 30))).toBe('005924');
  });
  it('base32 rundresa', () => expect(base32Decode(base32Encode(Buffer.from('hej världen'))).toString()).toBe('hej världen'));
  it('tolererar ±1 steg men inte mer', () => {
    const t = 1_700_000_000_000;
    const step = currentStep(t);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step - 1), t)).toBe(step - 1);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step + 1), t)).toBe(step + 1);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step - 2), t)).toBeNull();
  });
  it('förhindrar återanvändning (replay) av samma steg', () => {
    const t = 1_700_000_000_000;
    const step = currentStep(t);
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step), t, step)).toBeNull();
    expect(verifyTotp(rfcSecret, totpAt(rfcSecret, step + 1), t, step)).toBe(step + 1);
  });
  it('avvisar felaktigt format', () => {
    expect(verifyTotp(rfcSecret, '12345')).toBeNull();
    expect(verifyTotp(rfcSecret, 'abcdef')).toBeNull();
  });
});

describe('kryptering och lösenord', () => {
  it('scrypt-hash verifierar rätt och nekar fel lösenord', async () => {
    const h = await hashPassword('Hemligt-lösenord-1');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Hemligt-lösenord-1', h)).toBe(true);
    expect(await verifyPassword('fel', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });
  it('två hashar av samma lösenord skiljer sig (salt)', async () => {
    expect(await hashPassword('samma-lösenord-12')).not.toBe(await hashPassword('samma-lösenord-12'));
  });
  it('AES-GCM-rundresa och manipulationsskydd', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(enc).not.toContain('JBSWY');
    expect(decryptSecret(enc)).toBe('JBSWY3DPEHPK3PXP');
    const parts = enc.split('.');
    parts[2] = Buffer.from('manipulerad').toString('base64');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });
  it('lösenordsregler', () => {
    expect(() => assertStrongPassword('kort')).toThrow(/minst 12/);
    expect(() => assertStrongPassword('aaaaaaaaaaaaaa')).toThrow();
    expect(() => assertStrongPassword('password1234')).toThrow(/vanligt/);
    expect(() => assertStrongPassword('Ett-bra-lösenord-2026')).not.toThrow();
  });
});

describe('maskering av hemligheter', () => {
  it('maskar nycklar som ser ut som hemligheter, rekursivt', () => {
    const out = maskDeep({ password: 'x', nested: { apiKey: 'k', token: 't', ok: 'synlig' }, list: [{ cookie: 'c' }] }) as any;
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.apiKey).toBe('[REDACTED]');
    expect(out.nested.token).toBe('[REDACTED]');
    expect(out.nested.ok).toBe('synlig');
    expect(out.list[0].cookie).toBe('[REDACTED]');
  });
  it('maskar bearer-token, kortnummer, personnummer och långa token i fritext', () => {
    expect(maskString('Authorization: Bearer abcdefghijklmnop1234')).not.toContain('abcdefghijklmnop');
    expect(maskString('kort 4111 1111 1111 1111 betalt')).not.toContain('4111');
    expect(maskString('pnr 19900101-1234')).not.toContain('1234');
    expect(maskString('länk ' + 'a'.repeat(50))).toContain('[REDACTED]');
  });
  it('maskar telefon', () => {
    expect(maskPhone('0701231234')).toBe('******1234');
    expect(maskPhone(null)).toBeNull();
  });
});

describe('CSV-parser', () => {
  it('hanterar citat, dubbla citat, radbrytning i fält, BOM, CRLF och semikolon', async () => {
    const { parseCsv, detectDelimiter } = await import('../src/lib/csv.js');
    expect(parseCsv('﻿a,b\r\n"x, y","säger ""hej"""\r\n"rad1\nrad2",z\r\n')).toEqual([['a', 'b'], ['x, y', 'säger "hej"'], ['rad1\nrad2', 'z']]);
    expect(detectDelimiter('Namn;E-post;Telefon\nA;b;c')).toBe(';');
    expect(parseCsv('Namn;E-post\nÅsa;asa@example.test\n\n;\n')).toEqual([['Namn', 'E-post'], ['Åsa', 'asa@example.test']]);
    expect(() => parseCsv('a,b\n"oavslutat,c')).toThrow(/citattecken/);
  });
});
