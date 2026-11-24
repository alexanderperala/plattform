// Maskering av hemligheter i loggar, felmeddelanden och API-svar.
const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|card|cvc|cvv|mfa|recovery|hash|personnummer|ssn/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const PNR = /\b\d{6,8}[-+]?\d{4}\b/g;

export function maskString(s: string): string {
  return s.replace(BEARER, '$1 [REDACTED]').replace(CARD, '[REDACTED]').replace(PNR, '[REDACTED]').replace(LONG_TOKEN, '[REDACTED]');
}

export function maskDeep(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (typeof v === 'string') return maskString(v);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : maskDeep(val, depth + 1);
    }
    return out;
  }
  return v;
}

export function maskPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  return p.length <= 4 ? '****' : `${'*'.repeat(p.length - 4)}${p.slice(-4)}`;
}
