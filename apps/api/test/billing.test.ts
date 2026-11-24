import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { FakeProvider, setPaymentProvider, StripeProvider, verifyStripeSignature } from '../src/services/payments.js';
import { auditRows, custCall, makeApp, registerCustomer, resetDb, type TestCustomer } from './helpers.js';

const SECRET = 'whsec_test_secret';
let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); config.stripe.webhookSecret = SECRET; });
afterAll(async () => { setPaymentProvider(null); await app.close(); });
beforeEach(async () => { await resetDb(); setPaymentProvider(null); });

const sign = (body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
let n = 0;
const hook = async (type: string, object: Record<string, unknown>, opts: { id?: string; secret?: string; t?: number; body?: string } = {}) => {
  const body = opts.body ?? JSON.stringify({ id: opts.id ?? `evt_${++n}_${Date.now()}`, type, data: { object } });
  return app.inject({ method: 'POST', url: '/api/webhooks/stripe', payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': sign(body, opts.secret, opts.t) } });
};
const sub = async (c: TestCustomer) => (await pool.query('select * from subscriptions where workspace_id = $1', [c.workspaceId])).rows[0];
const bill = (c: TestCustomer, method: 'GET' | 'POST' | 'PUT', extra = '', payload?: unknown, who = c) => custCall(app, { method, url: `/workspaces/${c.workspaceId}/billing${extra}`, cookie: who.cookie, payload });
const checkoutDone = (c: TestCustomer, plan = 'standard', extra: Record<string, unknown> = {}) =>
  hook('checkout.session.completed', { client_reference_id: c.workspaceId, customer: `cus_${c.workspaceId.slice(0, 8)}`, subscription: `sub_${c.workspaceId.slice(0, 8)}`, metadata: { workspace_id: c.workspaceId, plan_id: plan, interval: 'month' }, ...extra });
const PROFILE = { companyName: 'Förening AB', orgNumber: '556677-8899', country: 'SE', addressLine: 'Storgatan 1', postalCode: '111 22', city: 'Stockholm', billingEmail: 'ekonomi@example.test' };

describe('Webhook-signatur (PAY-4)', () => {
  const body = '{"id":"evt_1","type":"x","data":{"object":{}}}';
  it('godkänner korrekt signatur och avvisar alla varianter av fel', () => {
    expect(verifyStripeSignature(body, sign(body), SECRET).id).toBe('evt_1');
    const t = Math.floor(Date.now() / 1000);
    expect(() => verifyStripeSignature(body, sign(body, 'annan'), SECRET)).toThrow();
    expect(() => verifyStripeSignature(body + ' ', sign(body), SECRET)).toThrow(); // ändrad kropp
    expect(() => verifyStripeSignature(body, sign(body, SECRET, t - 600), SECRET)).toThrow(); // för gammal (replay)
    expect(() => verifyStripeSignature(body, undefined, SECRET)).toThrow();
    expect(() => verifyStripeSignature(body, sign(body), '')).toThrow(); // ingen hemlighet konfigurerad = alltid nej
    expect(() => verifyStripeSignature(body, 'v1=abc', SECRET)).toThrow();
    const good = sign(body); expect(verifyStripeSignature(body, `${good},v1=deadbeef`, SECRET).id).toBe('evt_1'); // flera v1 (nyckelrotation)
  });
  it('webhook-endpointen svarar 400 på fel signatur och ändrar ingenting', async () => {
    const c = await registerCustomer(app);
    const r = await hook('checkout.session.completed', { client_reference_id: c.workspaceId, metadata: { plan_id: 'pro' } }, { secret: 'fel' });
    expect(r.statusCode).toBe(400); expect((await sub(c)).status).toBe('Trialing');
    expect((await pool.query('select count(*)::int as n from billing_events')).rows[0].n).toBe(0);
  });
});

describe('Webhook-händelser → prenumerationsstatus', () => {
  it('betalning genomförd: Trialing → Active, plan, kund- och prenumerations-ID, notis och audit', async () => {
    const c = await registerCustomer(app);
    const r = await checkoutDone(c, 'standard'); expect(r.statusCode).toBe(200); expect(r.json().outcome).toBe('applied');
    const s = await sub(c); expect(s).toMatchObject({ status: 'Active', plan_id: 'standard', billing_interval: 'month' }); expect(s.provider_customer_id).toMatch(/^cus_/); expect(s.provider_subscription_id).toMatch(/^sub_/);
    expect((await pool.query(`select count(*)::int as n from workspace_notifications where workspace_id = $1 and kind = 'billing'`, [c.workspaceId])).rows[0].n).toBe(1);
    expect((await auditRows(`action = 'billing.checkout_completed'`))[0]).toMatchObject({ workspace_id: c.workspaceId });
  });

  it('är idempotent: samma händelse-ID två gånger ger bara en effekt', async () => {
    const c = await registerCustomer(app);
    const body = JSON.stringify({ id: 'evt_dup', type: 'checkout.session.completed', data: { object: { client_reference_id: c.workspaceId, metadata: { plan_id: 'start', interval: 'year' } } } });
    const send = () => app.inject({ method: 'POST', url: '/api/webhooks/stripe', payload: body, headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) } });
    expect((await send()).json().outcome).toBe('applied'); expect((await send()).json().outcome).toBe('duplicate');
    expect((await pool.query(`select count(*)::int as n from workspace_notifications where workspace_id = $1`, [c.workspaceId])).rows[0].n).toBe(1);
    expect((await auditRows(`action = 'billing.checkout_completed'`))).toHaveLength(1);
  });

  it('misslyckad betalning → PastDue (en gång), lyckad faktura → Active igen och fakturan sparas (en gång)', async () => {
    const c = await registerCustomer(app); await checkoutDone(c);
    const cust = `cus_${c.workspaceId.slice(0, 8)}`; const s0 = `sub_${c.workspaceId.slice(0, 8)}`;
    expect((await hook('invoice.payment_failed', { customer: cust, subscription: s0 })).json().outcome).toBe('applied');
    let s = await sub(c); expect(s.status).toBe('PastDue'); const since = s.past_due_since; expect(since).not.toBeNull();
    await hook('invoice.payment_failed', { customer: cust, subscription: s0 }); // andra försöket hos leverantören
    s = await sub(c); expect(s.past_due_since).toEqual(since);
    const inv = { id: 'in_1', number: 'ABC-0001', customer: cust, subscription: s0, amount_paid: 39900, tax: 9975, currency: 'sek', hosted_invoice_url: 'https://pay.example/in_1', invoice_pdf: 'https://pay.example/in_1.pdf',
      lines: { data: [{ period: { start: 1_800_000_000, end: 1_802_592_000 } }] }, status_transitions: { paid_at: 1_800_000_100 } };
    expect((await hook('invoice.paid', inv)).json().outcome).toBe('applied');
    s = await sub(c); expect(s.status).toBe('Active'); expect(s.past_due_since).toBeNull(); expect(s.current_period_end.toISOString()).toBe(new Date(1_802_592_000_000).toISOString());
    await hook('invoice.paid', inv, { id: 'evt_other_id_same_invoice' }); // ny händelse, samma faktura
    const rows = (await pool.query('select * from invoices where workspace_id = $1', [c.workspaceId])).rows;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ number: 'ABC-0001', amount_minor: 39900, tax_minor: 9975, currency: 'SEK', status: 'paid' });
    const mail = (await pool.query(`select template from notification_outbox where workspace_id = $1 order by id`, [c.workspaceId])).rows.map((r) => r.template);
    expect(mail).toContain('billing-payment-failed');
  });

  it('uppsägning vid periodens slut, ångrad uppsägning och avslutat abonnemang', async () => {
    const c = await registerCustomer(app); await checkoutDone(c); const cust = `cus_${c.workspaceId.slice(0, 8)}`; const s0 = `sub_${c.workspaceId.slice(0, 8)}`;
    await hook('customer.subscription.updated', { object: 'subscription', id: s0, customer: cust, cancel_at_period_end: true, current_period_end: 1_900_000_000 });
    expect((await sub(c)).status).toBe('CanceledAtPeriodEnd');
    await hook('customer.subscription.updated', { object: 'subscription', id: s0, customer: cust, cancel_at_period_end: false });
    expect((await sub(c)).status).toBe('Active');
    await hook('customer.subscription.deleted', { object: 'subscription', id: s0, customer: cust });
    expect((await sub(c)).status).toBe('Expired');
    expect((await pool.query(`select status from workspaces where id = $1`, [c.workspaceId])).rows[0].status).toBe('Active'); // ingen data/arbetsyta raderas eller stängs
  });

  it('okända plan, okopplade händelser och ogiltiga övergångar ändrar inget (men registreras)', async () => {
    const c = await registerCustomer(app);
    expect((await checkoutDone(c, 'finns-inte')).json().outcome).toBe('ignored_unknown_plan'); expect((await checkoutDone(c, 'trial')).json().outcome).toBe('ignored_unknown_plan');
    expect((await sub(c)).status).toBe('Trialing');
    expect((await hook('invoice.payment_failed', { customer: 'cus_okand', subscription: 'sub_okand' })).json().outcome).toBe('unmatched');
    expect((await hook('invoice.payment_failed', { client_reference_id: c.workspaceId })).json().outcome).toBe('ignored_state'); // Trialing → PastDue är inte tillåtet
    expect((await hook('charge.refunded', { id: 'ch_1' })).json().outcome).toBe('ignored');
    expect((await pool.query('select count(*)::int as n from billing_events')).rows[0].n).toBe(5);
  });
});

describe('Fakturering i kundgränssnittet', () => {
  it('kräver faktureringsuppgifter före checkout, validerar dem och skickar kunden till leverantören', async () => {
    const fake = new FakeProvider(); setPaymentProvider(fake);
    const c = await registerCustomer(app);
    expect((await bill(c, 'POST', '/checkout', { planId: 'standard', interval: 'month' })).json().error.code).toBe('BILLING_PROFILE_REQUIRED');
    expect((await bill(c, 'PUT', '/profile', { ...PROFILE, orgNumber: undefined })).statusCode).toBe(400); // svenskt företag utan orgnr
    expect((await bill(c, 'PUT', '/profile', { ...PROFILE, country: 'Sverige' })).statusCode).toBe(400);
    expect((await bill(c, 'PUT', '/profile', { ...PROFILE, vatId: 'x' })).statusCode).toBe(400);
    expect((await bill(c, 'PUT', '/profile', { ...PROFILE, extra: 1 })).statusCode).toBe(400);
    expect((await bill(c, 'PUT', '/profile', { ...PROFILE, country: 'DE', orgNumber: undefined, vatId: 'DE123456789' })).statusCode).toBe(200);
    expect((await bill(c, 'PUT', '/profile', PROFILE)).statusCode).toBe(200);
    expect((await bill(c, 'POST', '/checkout', { planId: 'trial', interval: 'month' })).statusCode).toBe(404);
    expect((await bill(c, 'POST', '/checkout', { planId: 'standard', interval: 'weekly' })).statusCode).toBe(400);
    const r = await bill(c, 'POST', '/checkout', { planId: 'standard', interval: 'year' });
    expect(r.statusCode).toBe(200); expect(r.json().url).toContain('fake=1');
    expect(fake.calls[0]).toMatchObject({ workspaceId: c.workspaceId, planId: 'standard', interval: 'year', country: 'SE', email: 'ekonomi@example.test' });
    expect((await bill(c, 'POST', '/portal')).json().error.code).toBe('NO_PAYMENT_ACCOUNT');
    await checkoutDone(c); expect((await bill(c, 'POST', '/portal')).statusCode).toBe(200);
    const v = (await bill(c, 'GET')).json();
    expect(v).toMatchObject({ pricesExcludeVat: true, provider: 'fake', profile: { country: 'SE', orgNumber: '556677-8899' }, subscription: { status: 'Active', planId: 'standard', hasPaymentMethod: true } });
    expect(v.plans.map((p: any) => p.id)).toEqual(['start', 'standard', 'pro']); expect(v.plans[1].limits.tournament_system.max_tournaments).toBe(25);
    expect((await auditRows(`action in ('billing.profile_updated','billing.checkout_started')`)).length).toBeGreaterThanOrEqual(3);
  });

  it('bara ägare/admin ser och ändrar fakturering; arbetsytor är isolerade; avslutad arbetsyta kan inte köpa', async () => {
    const a = await registerCustomer(app); const b = await registerCustomer(app); const staff = await registerCustomer(app);
    await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [a.workspaceId, staff.userId]);
    for (const [m, p, body] of [['GET', '', undefined], ['PUT', '/profile', PROFILE], ['POST', '/checkout', { planId: 'start', interval: 'month' }], ['POST', '/portal', undefined]] as const)
      expect((await bill(a, m, p, body, staff)).statusCode, `${m} ${p}`).toBe(403);
    await checkoutDone(a); await hook('invoice.paid', { id: 'in_a', customer: `cus_${a.workspaceId.slice(0, 8)}`, amount_paid: 100, currency: 'sek' });
    expect((await bill(a, 'GET')).json().invoices).toHaveLength(1);
    expect((await bill(b, 'GET')).json().invoices).toHaveLength(0); // annan arbetsyta ser inte fakturan
    expect((await bill(a, 'GET', '', undefined, b)).statusCode).toBe(404); // b är ingen medlem i a
    await bill(a, 'PUT', '/profile', PROFILE); setPaymentProvider(new FakeProvider());
    await pool.query(`update workspaces set status = 'Closed' where id = $1`, [a.workspaceId]);
    expect((await bill(a, 'POST', '/checkout', { planId: 'start', interval: 'month' })).json().error.code).toBe('WORKSPACE_CLOSED');
  });

  it('Stripe-adaptern skickar rätt parametrar (pris, skatt, kopplings-ID), inga kortuppgifter, och översätter fel', async () => {
    const seen: { url: string; body: URLSearchParams; auth: string }[] = [];
    const ok = (async (url: string, init: RequestInit) => { seen.push({ url, body: new URLSearchParams(String(init.body)), auth: (init.headers as Record<string, string>).authorization! }); return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/x' }), { status: 200 }); }) as unknown as typeof fetch;
    const p = new StripeProvider('sk_test_x', ok);
    const r = await p.createCheckoutSession({ workspaceId: 'w1', planId: 'pro', interval: 'year', priceId: 'price_y', customerId: null, email: 'a@b.test', country: 'SE', successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
    expect(r).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.test/x' });
    const b = seen[0]!.body; expect(seen[0]!.url).toBe('https://api.stripe.com/v1/checkout/sessions'); expect(seen[0]!.auth).toBe('Bearer sk_test_x');
    expect(b.get('mode')).toBe('subscription'); expect(b.get('line_items[0][price]')).toBe('price_y'); expect(b.get('client_reference_id')).toBe('w1'); expect(b.get('automatic_tax[enabled]')).toBe('true'); expect(b.get('customer_email')).toBe('a@b.test');
    expect([...b.keys()].some((k) => /card|cvc|number/i.test(k))).toBe(false);
    await expect(p.createCheckoutSession({ workspaceId: 'w1', planId: 'pro', interval: 'month', priceId: null, customerId: null, email: 'a@b.test', country: 'SE', successUrl: 'x', cancelUrl: 'y' })).rejects.toMatchObject({ code: 'PRICE_NOT_CONFIGURED' });
    const bad = (async () => new Response(JSON.stringify({ error: { code: 'rate_limit', message: 'hemligt' } }), { status: 429 })) as unknown as typeof fetch;
    await expect(new StripeProvider('k', bad).createPortalSession({ customerId: 'cus_1', returnUrl: 'x' })).rejects.toMatchObject({ statusCode: 502, code: 'PAYMENT_PROVIDER_ERROR' });
  });
});
