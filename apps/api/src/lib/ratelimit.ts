import { config } from '../config.js';
import { AppError } from './errors.js';

const hits = new Map<string, number[]>();

/** Enkel glidande-fönster-begränsning i minnet per nyckel (IP). Räcker för en instans; byts mot delad lagring vid skalning. */
export function rateLimit(key: string, max = config.authRateLimit.max, windowMs = config.authRateLimit.windowMs): void {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    throw new AppError(429, 'RATE_LIMITED', 'För många försök. Vänta en stund och försök igen.');
  }
  arr.push(now);
  hits.set(key, arr);
}
export const resetRateLimits = (): void => hits.clear();
