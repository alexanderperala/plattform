import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { fmtDate, LABELS, label } from '../format';
import { Badge, ErrorBox, PageHead, Pager, useDebounced, useLoad } from '../ui';

export function Products() {
  const [sp, setSp] = useSearchParams();
  const [text, setText] = useState(''); const q = useDebounced(text);
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const plans = useLoad(() => api<any>('GET', '/plans'), []);
  const { data, error, loading } = useLoad(() => api<any>('GET', '/entitlements' + qs({ q, product: get('product'), status: get('status'), page: Number(get('page') || 1) })), [q, sp.toString()]);
  return (
    <div className="stack">
      <PageHead title="Produkter och licenser" subtitle="Produktlicenser över alla kunder. Aktivera, inaktivera eller ändra gränser på kunddetaljsidan." />
      <div className="card"><h2>Planer</h2>
        <div className="table-wrap"><table><thead><tr><th>Plan</th><th>Gränser per produkt</th>{plans.data?.items?.[0]?.monthlyPriceMinor !== undefined && <th>Pris/mån</th>}</tr></thead>
          <tbody>{plans.data?.items.map((p: any) => <tr key={p.id}><td><strong>{p.name}</strong> {!p.active && <span className="badge">Inaktiv</span>} {p.isTrial && <span className="badge info">Prov</span>}</td>
            <td>{p.entitlements.map((e: any) => <div key={e.product} className="small"><strong>{label('product', e.product)}:</strong> {Object.entries(e.limits).map(([k, v]: any) => `${(LABELS.limit as any)[k] ?? k} ${v ?? '∞'}`).join(' · ')}</div>)}</td>
            {p.monthlyPriceMinor !== undefined && <td>{(p.monthlyPriceMinor / 100).toLocaleString('sv-SE')} {p.currency} <span className="muted small">(platshållare)</span></td>}</tr>)}</tbody></table></div>
      </div>
      <div className="card flush">
        <div className="filters">
          <label className="field search">Kund<input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Sök på kundnamn" /></label>
          <label className="field">Produkt<select value={get('product')} onChange={(e) => set('product', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.product).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Licensstatus<select value={get('status')} onChange={(e) => set('status', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.entitlementStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        {error != null && <div style={{ padding: '1rem' }}><ErrorBox error={error} /></div>}
        <div className="table-wrap"><table><thead><tr><th>Kund</th><th>Produkt</th><th>Licens</th><th>Källa</th><th>Utgår</th><th>Abonnemang</th></tr></thead>
          <tbody>{data?.items.map((e: any) => <tr key={e.id}><td><Link to={`/customers/${e.workspaceId}`}>{e.workspaceName}</Link></td><td>{label('product', e.product)}</td><td><Badge group="entitlementStatus" value={e.status} /></td><td>{e.source}</td><td>{fmtDate(e.expiresAt)}</td>
            <td>{e.subscriptionStatus ? <><Badge group="subscriptionStatus" value={e.subscriptionStatus} /> <span className="muted small">{e.planId}</span></> : '–'}</td></tr>)}</tbody></table>
          {loading && !data && <div className="loading">Laddar…</div>}{data && data.items.length === 0 && <div className="empty">Inga licenser matchar filtret.</div>}</div>
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />}
      </div>
    </div>
  );
}
