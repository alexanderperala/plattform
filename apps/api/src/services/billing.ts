import type { Db } from '../db/pool.js';
import type { SubscriptionStatus } from '../domain/access.js';
import { canTransition } from '../domain/subscription.js';
import { audit } from './audit.js';
import { evaluateLimits } from './access.js';
import { notifyWorkspaceAdmins } from './outbox.js';
import type { ProviderEvent } from './payments.js';

const ts = (sec: unknown): Date | null => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000) : null);
interface Sub { id: string; workspace_id: string; status: SubscriptionStatus; past_due_since: Date | null }

async function findSub(db: Db, o: Record<string, any>): Promise<Sub | null> {
  const wid = o.client_reference_id ?? o.metadata?.workspace_id ?? o.subscription_details?.metadata?.workspace_id ?? o.lines?.data?.[0]?.metadata?.workspace_id ?? null;
  const q = `select id, workspace_id, status, past_due_since from subscriptions where `;
  if (typeof wid === 'string' && /^[0-9a-f-]{36}$/i.test(wid)) { const r = (await db.query(q + 'workspace_id = $1', [wid])).rows[0]; if (r) return r; }
  const sid = typeof o.subscription === 'string' ? o.subscription : typeof o.object === 'string' && o.object === 'subscription' ? o.id : null;
  if (sid) { const r = (await db.query(q + 'provider_subscription_id = $1', [sid])).rows[0]; if (r) return r; }
  if (typeof o.customer === 'string') { const r = (await db.query(q + 'provider_customer_id = $1', [o.customer])).rows[0]; if (r) return r; }
  return null;
}

async function setStatus(db: Db, sub: Sub, to: SubscriptionStatus, extra: Record<string, unknown> = {}): Promise<boolean> {
  if (sub.status !== to && !canTransition(sub.status, to)) return false;
  const cols = Object.keys(extra);
  await db.query(`update subscriptions set status = $2, updated_at = now()${cols.map((k, i) => `, ${k} = $${i + 3}`).join('')} where id = $1`, [sub.id, to, ...cols.map((k) => extra[k])]);
  return true;
}

const log = (db: Db, ev: ProviderEvent, wid: string, action: string, meta: Record<string, unknown> = {}) =>
  audit(db, {}, { action: `billing.${action}`, workspaceId: wid, targetType: 'subscription', meta: { by: 'payment_provider', providerEventId: ev.id, ...meta } });

/**
 * Tillämpar en verifierad leverantörshändelse (PAY-4). Idempotent: samma händelse-ID ger aldrig två effekter.
 * Anropas inuti en transaktion; ett kastat fel rullar tillbaka allt (inklusive idempotensposten) så att leverantören skickar om.
 */
export async function applyProviderEvent(db: Db, ev: ProviderEvent): Promise<{ outcome: string; workspaceId: string | null }> {
  const first = await db.query(`insert into billing_events (provider_event_id, type, outcome) values ($1,$2,'processing') on conflict do nothing`, [ev.id, ev.type]);
  if (!first.rowCount) return { outcome: 'duplicate', workspaceId: null };
  const o = ev.data.object;
  const sub = await findSub(db, o);
  let outcome = 'ignored';
  if (!sub && ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(ev.type)) outcome = 'unmatched'; // kan inte knytas till en arbetsyta – syns i billing_events för utredning
  if (sub) {
    const wid = sub.workspace_id;
    switch (ev.type) {
      case 'checkout.session.completed': {
        const plan = o.metadata?.plan_id as string | undefined; const interval = o.metadata?.interval === 'year' ? 'year' : 'month';
        const known = plan ? (await db.query(`select 1 from plans where id = $1 and active and not is_trial`, [plan])).rowCount : 0;
        if (!known) { outcome = 'ignored_unknown_plan'; break; }
        const ok = await setStatus(db, sub, 'Active', { plan_id: plan, billing_interval: interval, provider_customer_id: o.customer ?? null, provider_subscription_id: o.subscription ?? null, past_due_since: null });
        outcome = ok ? 'applied' : 'ignored_state';
        if (ok) { await log(db, ev, wid, 'checkout_completed', { planId: plan, interval }); await notifyWorkspaceAdmins(db, wid, { kind: 'billing', title: 'Betalningen är genomförd', body: 'Tack! Ert abonnemang är nu aktivt.', template: 'billing-activated' }); }
        break;
      }
      case 'invoice.paid': {
        const line = o.lines?.data?.[0]; const period = line?.period ?? {};
        if (typeof o.id === 'string') await db.query(
          `insert into invoices (workspace_id, provider_invoice_id, number, status, amount_minor, tax_minor, currency, hosted_url, pdf_url, period_start, period_end, paid_at)
           values ($1,$2,$3,'paid',$4,$5,$6,$7,$8,$9,$10,$11)
           on conflict (provider_invoice_id) do update set status = 'paid', paid_at = excluded.paid_at, number = coalesce(excluded.number, invoices.number)`,
          [wid, o.id, o.number ?? null, o.amount_paid ?? o.total ?? 0, o.tax ?? 0, String(o.currency ?? 'sek').toUpperCase(), o.hosted_invoice_url ?? null, o.invoice_pdf ?? null, ts(period.start), ts(period.end), ts(o.status_transitions?.paid_at) ?? new Date()]);
        if (sub.status === 'CanceledAtPeriodEnd') { outcome = 'invoice_recorded'; break; }
        const ok = await setStatus(db, sub, 'Active', { past_due_since: null, ...(ts(period.start) ? { current_period_start: ts(period.start) } : {}), ...(ts(period.end) ? { current_period_end: ts(period.end) } : {}) });
        outcome = ok ? 'applied' : 'invoice_recorded';
        if (ok && sub.status === 'PastDue') await log(db, ev, wid, 'recovered');
        break;
      }
      case 'invoice.payment_failed': {
        const ok = await setStatus(db, sub, 'PastDue', { past_due_since: sub.past_due_since ?? new Date() });
        outcome = ok ? 'applied' : 'ignored_state';
        if (ok && sub.status !== 'PastDue') { await log(db, ev, wid, 'payment_failed'); await notifyWorkspaceAdmins(db, wid, { kind: 'billing', title: 'Betalningen misslyckades', body: 'Vi kunde inte debitera er senaste faktura. Uppdatera betalsättet under Fakturering – ingen data raderas, men åtkomsten kan begränsas efter respitperioden.', template: 'billing-payment-failed' }); }
        break;
      }
      case 'customer.subscription.updated': {
        const end = ts(o.current_period_end);
        if (o.cancel_at_period_end === true && sub.status === 'Active') { outcome = (await setStatus(db, sub, 'CanceledAtPeriodEnd', end ? { current_period_end: end } : {})) ? 'applied' : 'ignored_state'; if (outcome === 'applied') await log(db, ev, wid, 'cancel_scheduled'); }
        else if (o.cancel_at_period_end === false && sub.status === 'CanceledAtPeriodEnd') { outcome = (await setStatus(db, sub, 'Active', end ? { current_period_end: end } : {})) ? 'applied' : 'ignored_state'; if (outcome === 'applied') await log(db, ev, wid, 'cancel_reverted'); }
        else if (end) { await db.query('update subscriptions set current_period_end = $2, updated_at = now() where id = $1', [sub.id, end]); outcome = 'period_updated'; }
        break;
      }
      case 'customer.subscription.deleted': {
        outcome = (await setStatus(db, sub, 'Expired')) ? 'applied' : 'ignored_state';
        if (outcome === 'applied') { await log(db, ev, wid, 'subscription_ended'); await notifyWorkspaceAdmins(db, wid, { kind: 'billing', title: 'Abonnemanget har avslutats', body: 'Ert abonnemang har avslutats. Er data finns kvar och raderas inte automatiskt; kontakta oss eller teckna ett nytt abonnemang för att återfå full åtkomst.', template: 'billing-ended' }); }
        break;
      }
    }
    if (outcome === 'applied') await evaluateLimits(db, wid);
  }
  await db.query('update billing_events set outcome = $2, workspace_id = $3 where provider_event_id = $1', [ev.id, outcome, sub?.workspace_id ?? null]);
  return { outcome, workspaceId: sub?.workspace_id ?? null };
}
