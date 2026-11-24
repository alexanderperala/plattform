import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from './api';
import { Alert, ErrorBox, Field, LABEL, fmtDateTime, useLoad } from './ui';

const money = (minor: number, cur: string) => new Intl.NumberFormat('sv-SE', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(minor / 100);
const EMPTY = { companyName: '', orgNumber: '', vatId: '', country: 'SE', addressLine: '', postalCode: '', city: '', billingEmail: '' };

export function Billing({ wid }: { wid: string }) {
  const { data, error, reload } = useLoad(() => api<any>('GET', `/workspaces/${wid}/billing`), [wid]);
  const [params] = useSearchParams(); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<typeof EMPTY | null>(null); const [saved, setSaved] = useState(false);
  if (error != null) return <ErrorBox error={error} />;
  if (!data) return <div className="loading">Laddar…</div>;
  const f = form ?? { ...EMPTY, ...Object.fromEntries(Object.entries(data.profile ?? {}).map(([k, v]) => [k, v ?? ''])) };
  const set = (k: keyof typeof EMPTY, v: string) => { setSaved(false); setForm({ ...f, [k]: v }); };
  const go = async (path: string, body?: unknown) => { setErr(null); setBusy(true); try { const r = await api<{ url: string }>('POST', `/workspaces/${wid}/billing/${path}`, body); window.location.href = r.url; } catch (x) { setErr(x); setBusy(false); } };
  async function saveProfile(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const body = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]).filter(([k, v]) => v !== '' || ['companyName', 'addressLine', 'postalCode', 'city', 'billingEmail', 'country'].includes(k as string)));
    try { await api('PUT', `/workspaces/${wid}/billing/profile`, body); setSaved(true); setForm(null); reload(); } catch (x) { setErr(x); }
  }
  const s = data.subscription;
  return (
    <>
      <h1>Fakturering</h1>
      {params.get('checkout') === 'success' && <Alert kind="good">Tack! Betalningen behandlas hos betalleverantören – abonnemanget uppdateras inom någon minut.</Alert>}
      {params.get('checkout') === 'cancelled' && <Alert kind="info">Köpet avbröts. Inget har debiterats.</Alert>}
      {err != null && <ErrorBox error={err} />}
      <section className="card"><h2>Ert abonnemang</h2>
        {s ? <div><span className={`badge ${s.effectiveStatus === 'Active' ? 'good' : s.effectiveStatus === 'PastDue' || s.effectiveStatus === 'Expired' ? 'bad' : 'warn'}`}>{LABEL.sub[s.effectiveStatus] ?? s.effectiveStatus}</span>{' '}
          <strong>{data.plans.find((p: any) => p.id === s.planId)?.name ?? (s.planId === 'trial' ? 'Provperiod' : s.planId)}</strong>
          {s.interval && <span className="muted"> · {s.interval === 'year' ? 'årsvis' : 'månadsvis'}</span>}
          {s.status === 'Trialing' && <div className="muted small">Provperioden slutar {fmtDateTime(s.trialEndsAt)}.</div>}
          {s.currentPeriodEnd && s.status !== 'Trialing' && <div className="muted small">Nuvarande period slutar {fmtDateTime(s.currentPeriodEnd)}.</div>}
          {s.status === 'PastDue' && <Alert kind="warn">Senaste betalningen gick inte igenom. Uppdatera betalsättet{s.graceEndsAt ? ` senast ${fmtDateTime(s.graceEndsAt)}` : ''} för att behålla full åtkomst. Er data raderas inte.</Alert>}
          {s.status === 'CanceledAtPeriodEnd' && <Alert kind="info">Abonnemanget är uppsagt och upphör vid periodens slut. Er data raderas inte automatiskt.</Alert>}
          {s.hasPaymentMethod && <div style={{ marginTop: '.6rem' }}><button className="btn" disabled={busy} onClick={() => void go('portal')}>Hantera betalsätt och uppsägning</button></div>}
        </div> : <div className="muted">Inget abonnemang.</div>}
      </section>
      <section className="card"><h2>Välj plan</h2>
        <div className="muted small">Alla priser anges exklusive moms. Moms beräknas vid köpet utifrån era faktureringsuppgifter.</div>
        <div className="row" style={{ alignItems: 'stretch', flexWrap: 'wrap' }}>{data.plans.map((p: any) => (
          <article key={p.id} className="card" style={{ flex: '1 1 14rem' }} data-testid="plan">
            <h3>{p.name}</h3>
            <div><strong>{money(p.monthlyPriceMinor, p.currency)}</strong> / månad</div>
            {p.yearlyPriceMinor !== null && <div className="muted small">eller {money(p.yearlyPriceMinor, p.currency)} / år</div>}
            <ul className="small">{Object.entries(p.limits ?? {}).map(([prod, l]: [string, any]) => <li key={prod}>{LABEL.product[prod]}: {Object.entries(l).filter(([k]) => k !== 'storage_mb').map(([k, v]) => `${k === 'max_users' ? 'användare' : k === 'max_members' ? 'medlemmar' : 'turneringar'} ${v ?? 'obegränsat'}`).join(', ')}</li>)}</ul>
            <div className="row"><button className="btn primary small" disabled={busy} onClick={() => void go('checkout', { planId: p.id, interval: 'month' })}>Välj månadsvis</button>
              {p.yearlyPriceMinor !== null && <button className="btn small" disabled={busy} onClick={() => void go('checkout', { planId: p.id, interval: 'year' })}>Välj årsvis</button>}</div>
          </article>))}</div>
      </section>
      <section className="card"><h2>Faktureringsuppgifter</h2>
        <form onSubmit={saveProfile}>
          <Field label="Företag/förening"><input value={f.companyName} onChange={(e) => set('companyName', e.target.value)} required maxLength={200} /></Field>
          <div className="row"><Field label="Land (landskod)"><input aria-label="Land" value={f.country} onChange={(e) => set('country', e.target.value.toUpperCase())} required maxLength={2} style={{ width: '5rem' }} /></Field>
            <Field label="Organisationsnummer"><input value={f.orgNumber} onChange={(e) => set('orgNumber', e.target.value)} placeholder="556677-8899" /></Field>
            <Field label="Momsregistreringsnr (VAT-ID)" hint="Om ni har ett, med landskod"><input value={f.vatId} onChange={(e) => set('vatId', e.target.value)} placeholder="SE556677889901" /></Field></div>
          <Field label="Adress"><input value={f.addressLine} onChange={(e) => set('addressLine', e.target.value)} required maxLength={200} /></Field>
          <div className="row"><Field label="Postnummer"><input value={f.postalCode} onChange={(e) => set('postalCode', e.target.value)} required maxLength={20} /></Field><Field label="Ort"><input value={f.city} onChange={(e) => set('city', e.target.value)} required maxLength={100} /></Field></div>
          <Field label="Faktura-e-post"><input type="email" value={f.billingEmail} onChange={(e) => set('billingEmail', e.target.value)} required /></Field>
          <div className="row"><button className="btn primary">Spara uppgifter</button>{saved && <span className="muted small" role="status">Sparat.</span>}</div>
        </form>
      </section>
      <section className="card"><h2>Fakturor</h2>
        {data.invoices.length === 0 ? <div className="muted small">Inga fakturor ännu.</div> : <table><thead><tr><th>Datum</th><th>Nummer</th><th>Belopp</th><th>Varav moms</th><th></th></tr></thead>
          <tbody>{data.invoices.map((i: any) => <tr key={i.id}><td>{fmtDateTime(i.paidAt ?? i.createdAt)}</td><td>{i.number ?? '–'}</td><td>{money(i.amountMinor, i.currency)}</td><td>{money(i.taxMinor, i.currency)}</td>
            <td>{i.hostedUrl && <a href={i.hostedUrl} target="_blank" rel="noreferrer">Visa</a>} {i.pdfUrl && <a href={i.pdfUrl} target="_blank" rel="noreferrer">PDF</a>}</td></tr>)}</tbody></table>}
        <div className="muted small">Fakturaunderlag sparas i sju år.</div>
      </section>
    </>
  );
}
