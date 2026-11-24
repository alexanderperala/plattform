import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { AppError, badRequest } from '../lib/errors.js';

/** Gränssnitt mot betalleverantören (PAY-1). Plattformen hanterar aldrig kortdata – kunden skickas till leverantörens hostade sidor. */
export interface PaymentProvider {
  readonly name: string;
  createCheckoutSession(i: { workspaceId: string; planId: string; interval: 'month' | 'year'; priceId: string | null; customerId: string | null; email: string; country: string; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }>;
  createPortalSession(i: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}

export interface ProviderEvent { id: string; type: string; data: { object: Record<string, any> } }

/** Stripes signaturschema: header "t=<unix>,v1=<hex hmac sha256 av `${t}.${rawBody}`>". Tillåter 5 minuters klockavvikelse. Kastar vid fel. */
export function verifyStripeSignature(rawBody: Buffer | string, header: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): ProviderEvent {
  const bad = () => badRequest('INVALID_SIGNATURE', 'Ogiltig webhook-signatur.');
  if (!secret || !header) throw bad();
  const parts = new Map<string, string[]>();
  for (const kv of header.split(',')) { const i = kv.indexOf('='); if (i > 0) { const k = kv.slice(0, i).trim(); parts.set(k, [...(parts.get(k) ?? []), kv.slice(i + 1).trim()]); } }
  const t = Number(parts.get('t')?.[0]);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) throw bad();
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const ok = (parts.get('v1') ?? []).some((sig) => { const b = Buffer.from(sig, 'hex'); return b.length === expected.length && timingSafeEqual(b, expected); });
  if (!ok) throw bad();
  try { return JSON.parse(rawBody.toString()) as ProviderEvent; } catch { throw bad(); }
}

const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  constructor(private readonly key: string, private readonly fetchImpl: typeof fetch = fetch) {}
  private async post(path: string, body: Record<string, string>): Promise<any> {
    const res = await this.fetchImpl(`https://api.stripe.com/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Betalleverantören kunde inte nå ett svar just nu. Försök igen om en stund.', { providerStatus: res.status, providerCode: json?.error?.code });
    return json;
  }
  async createCheckoutSession(i: Parameters<PaymentProvider['createCheckoutSession']>[0]) {
    if (!i.priceId) throw new AppError(409, 'PRICE_NOT_CONFIGURED', 'Planen saknar pris hos betalleverantören.');
    const body: Record<string, string> = {
      mode: 'subscription', 'line_items[0][price]': i.priceId, 'line_items[0][quantity]': '1',
      client_reference_id: i.workspaceId, success_url: i.successUrl, cancel_url: i.cancelUrl,
      'metadata[workspace_id]': i.workspaceId, 'metadata[plan_id]': i.planId, 'metadata[interval]': i.interval,
      'subscription_data[metadata][workspace_id]': i.workspaceId,
      'automatic_tax[enabled]': 'true', 'tax_id_collection[enabled]': 'true', 'billing_address_collection': 'required',
    };
    if (i.customerId) { body.customer = i.customerId; body['customer_update[address]'] = 'auto'; body['customer_update[name]'] = 'auto'; } else body.customer_email = i.email;
    const r = await this.post('/checkout/sessions', body);
    return { id: String(r.id), url: String(r.url) };
  }
  async createPortalSession(i: { customerId: string; returnUrl: string }) {
    const r = await this.post('/billing_portal/sessions', { customer: i.customerId, return_url: i.returnUrl });
    return { url: String(r.url) };
  }
}

/** Utvecklings-/testadapter när ingen Stripe-nyckel är konfigurerad. Skapar inga riktiga sessioner. */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  calls: unknown[] = [];
  async createCheckoutSession(i: Parameters<PaymentProvider['createCheckoutSession']>[0]) { this.calls.push(i); return { id: `cs_fake_${i.workspaceId}`, url: `${i.successUrl}${i.successUrl.includes('?') ? '&' : '?'}fake=1` }; }
  async createPortalSession(i: { customerId: string; returnUrl: string }) { this.calls.push(i); return { url: i.returnUrl } }
}

let override: PaymentProvider | null = null;
export const setPaymentProvider = (p: PaymentProvider | null): void => { override = p; };
export const getPaymentProvider = (): PaymentProvider => override ?? (config.stripe.secretKey ? new StripeProvider(config.stripe.secretKey) : new FakeProvider());
