import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { camelAll } from '../../lib/camel.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { loadWorkspaceAccess } from '../../services/access.js';
import { getPaymentProvider } from '../../services/payments.js';
import { workspaceAccess } from '../../domain/access.js';
import type { Helpers } from './association.js';

const uuid = z.string().uuid();
const BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:5174';
const profile = z.object({
  companyName: z.string().trim().min(1).max(200),
  orgNumber: z.string().trim().regex(/^\d{6}-?\d{4}$/, 'Organisationsnummer anges som 10 siffror, till exempel 556677-8899').optional(),
  vatId: z.string().trim().toUpperCase().regex(/^[A-Z]{2}[A-Z0-9]{2,12}$/, 'Momsregistreringsnummer anges med landskod, till exempel SE556677889901').optional(),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Ange landskod med två bokstäver, till exempel SE'),
  addressLine: z.string().trim().min(1).max(200), postalCode: z.string().trim().min(1).max(20), city: z.string().trim().min(1).max(100),
  billingEmail: z.string().trim().email().max(254),
}).strict().refine((p) => p.country !== 'SE' || !!p.orgNumber, { message: 'Organisationsnummer krävs för svenska kunder', path: ['orgNumber'] });
const checkout = z.object({ planId: z.string().min(1).max(40), interval: z.enum(['month', 'year']) }).strict();

/** Fakturering för ägare/admin (avsnitt 10). Kortdata hanteras uteslutande av betalleverantörens hostade sidor. */
export function billingRoutes(app: FastifyInstance, { authed, requireMember }: Helpers): void {
  const base = '/workspaces/:wid/billing';

  app.get(base, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    await requireMember(req, wid, ['owner', 'admin']);
    const a = await loadWorkspaceAccess(pool, wid);
    if (!a) throw notFound('Arbetsytan hittades inte.');
    const sub = (await pool.query('select billing_interval, provider_customer_id from subscriptions where workspace_id = $1', [wid])).rows[0];
    const plans = (await pool.query(`select p.id, p.name, p.monthly_price_minor, p.yearly_price_minor, p.currency,
        (select jsonb_object_agg(e.product, e.limits) from plan_entitlements e where e.plan_id = p.id) as limits
        from plans p where p.active and not p.is_trial order by p.sort_order`)).rows;
    const prof = (await pool.query('select company_name, org_number, vat_id, country, address_line, postal_code, city, billing_email from workspace_billing_profiles where workspace_id = $1', [wid])).rows[0];
    const invoices = (await pool.query('select id, number, status, amount_minor, tax_minor, currency, hosted_url, pdf_url, period_start, period_end, paid_at, created_at from invoices where workspace_id = $1 order by created_at desc limit 100', [wid])).rows;
    return {
      subscription: a.subscription ? { ...a.subscription, interval: sub?.billing_interval ?? null, hasPaymentMethod: !!sub?.provider_customer_id } : null,
      plans: camelAll(plans), profile: prof ? camelAll([prof])[0] : null, invoices: camelAll(invoices), pricesExcludeVat: true, provider: getPaymentProvider().name,
    };
  });

  app.put(`${base}/profile`, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = profile.parse(req.body);
    await requireMember(req, wid, ['owner', 'admin']);
    await tx(async (c) => {
      await c.query(`insert into workspace_billing_profiles (workspace_id, company_name, org_number, vat_id, country, address_line, postal_code, city, billing_email)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (workspace_id) do update set company_name = excluded.company_name, org_number = excluded.org_number, vat_id = excluded.vat_id, country = excluded.country,
          address_line = excluded.address_line, postal_code = excluded.postal_code, city = excluded.city, billing_email = excluded.billing_email, updated_at = now()`,
      [wid, b.companyName, b.orgNumber ?? null, b.vatId ?? null, b.country, b.addressLine, b.postalCode, b.city, b.billingEmail]);
      await audit(c, { requestId: req.id }, { action: 'billing.profile_updated', workspaceId: wid, userId: req.customer!.userId, targetType: 'billing_profile', meta: { by: 'customer', country: b.country, hasVatId: !!b.vatId } });
    });
    return { ok: true };
  });

  app.post(`${base}/checkout`, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = checkout.parse(req.body);
    await requireMember(req, wid, ['owner', 'admin']);
    const a = await loadWorkspaceAccess(pool, wid);
    if (!a) throw notFound('Arbetsytan hittades inte.');
    if (workspaceAccess(a.workspaceStatus) === 'export_only') throw conflict('WORKSPACE_CLOSED', 'Arbetsytan är avslutad och kan inte köpa abonnemang. Kontakta supporten.');
    const plan = (await pool.query('select id, provider_price_monthly, provider_price_yearly, yearly_price_minor from plans where id = $1 and active and not is_trial', [b.planId])).rows[0];
    if (!plan) throw notFound('Planen finns inte.');
    if (b.interval === 'year' && plan.yearly_price_minor === null) throw conflict('INTERVAL_NOT_AVAILABLE', 'Årsbetalning finns inte för den här planen.');
    const prof = (await pool.query('select country, billing_email from workspace_billing_profiles where workspace_id = $1', [wid])).rows[0];
    if (!prof) throw conflict('BILLING_PROFILE_REQUIRED', 'Fyll i faktureringsuppgifter (företag, adress, land och organisationsnummer) innan ni går vidare till betalning.');
    const customerId = (await pool.query('select provider_customer_id from subscriptions where workspace_id = $1', [wid])).rows[0]?.provider_customer_id ?? null;
    const session = await getPaymentProvider().createCheckoutSession({
      workspaceId: wid, planId: plan.id, interval: b.interval, priceId: b.interval === 'year' ? plan.provider_price_yearly : plan.provider_price_monthly, customerId,
      email: prof.billing_email, country: prof.country, successUrl: `${BASE_URL}/w/${wid}/billing?checkout=success`, cancelUrl: `${BASE_URL}/w/${wid}/billing?checkout=cancelled`,
    });
    await audit(pool, { requestId: req.id }, { action: 'billing.checkout_started', workspaceId: wid, userId: req.customer!.userId, targetType: 'plan', targetId: plan.id, meta: { by: 'customer', interval: b.interval } });
    return { url: session.url };
  });

  app.post(`${base}/portal`, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    await requireMember(req, wid, ['owner', 'admin']);
    const customerId = (await pool.query('select provider_customer_id from subscriptions where workspace_id = $1', [wid])).rows[0]?.provider_customer_id;
    if (!customerId) throw conflict('NO_PAYMENT_ACCOUNT', 'Ni har inget betalkonto ännu. Starta ett abonnemang först.');
    const s = await getPaymentProvider().createPortalSession({ customerId, returnUrl: `${BASE_URL}/w/${wid}/billing` });
    return { url: s.url };
  });
}
