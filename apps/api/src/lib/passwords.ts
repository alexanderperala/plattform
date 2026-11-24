import { badRequest } from './errors.js';

const COMMON = new Set([
  'password1234', 'lösenord1234', 'qwerty123456', '123456789012', 'administrator', 'password123!', 'welcome12345',
  'letmein12345', 'iloveyou1234', 'admin1234567', 'plattform1234', 'sommar2026!!', 'changeme1234',
]);

export function assertStrongPassword(pw: string, minLength = 12): void {
  if (pw.length < minLength) throw badRequest('WEAK_PASSWORD', `Lösenordet måste vara minst ${minLength} tecken.`);
  if (pw.length > 200) throw badRequest('WEAK_PASSWORD', 'Lösenordet är för långt.');
  if (COMMON.has(pw.toLowerCase())) throw badRequest('WEAK_PASSWORD', 'Lösenordet är för vanligt. Välj ett annat.');
  if (/^(.)\1+$/.test(pw)) throw badRequest('WEAK_PASSWORD', 'Lösenordet får inte bestå av ett upprepat tecken.');
}
