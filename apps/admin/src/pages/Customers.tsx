import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { fmtDate, relTime, LABELS, label } from '../format';
import { Badge, ErrorBox, PageHead, Pager, SortTh, useDebounced, useLoad } from '../ui';

export function Customers() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const [text, setText] = useState(sp.get('q') ?? '');
  const q = useDebounced(text);
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const sort = get('sort') || 'createdAt'; const dir = get('dir') || 'desc'; const page = Number(get('page') || 1);
  const onSort = (c: string) => { const n = new URLSearchParams(sp); n.set('sort', c); n.set('dir', sort === c && dir === 'asc' ? 'desc' : 'asc'); setSp(n, { replace: true }); };

  const { data, error, loading } = useLoad(() => api<any>('GET', '/workspaces' + qs({
    q, product: get('product'), workspaceStatus: get('workspaceStatus'), subscriptionStatus: get('subscriptionStatus'), plan: get('plan'), kind: get('kind'),
    from: get('from'), to: get('to') ? get('to') + 'T23:59:59' : '', sort, dir, page,
  })), [q, sp.toString()]);
  const showSub = data?.items?.[0] ? 'subscriptionStatus' in data.items[0] || data.items.length === 0 : true;

  return (
    <div className="stack">
      <PageHead title="Kunder" subtitle="Sök och filtrera arbetsytor. Klicka på en rad för kunddetaljer." />
      <div className="card flush">
        <div className="filters">
          <label className="field search">Sök<input type="search" placeholder="Namn, org.nr, kontakt, e-post eller ID" value={text} onChange={(e) => setText(e.target.value)} /></label>
          <label className="field">Produkt<select value={get('product')} onChange={(e) => set('product', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.product).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Arbetsyta<select value={get('workspaceStatus')} onChange={(e) => set('workspaceStatus', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.workspaceStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {showSub && <label className="field">Abonnemang<select value={get('subscriptionStatus')} onChange={(e) => set('subscriptionStatus', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.subscriptionStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
          <label className="field">Typ<select value={get('kind')} onChange={(e) => set('kind', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.kind).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Skapad från<input type="date" value={get('from')} onChange={(e) => set('from', e.target.value)} /></label>
          <label className="field">Skapad till<input type="date" value={get('to')} onChange={(e) => set('to', e.target.value)} /></label>
        </div>
        {error != null && <div style={{ padding: '1rem' }}><ErrorBox error={error} /></div>}
        <div className="table-wrap">
          <table>
            <thead><tr>
              <SortTh col="name" sort={sort} dir={dir} onSort={onSort}>Kund</SortTh><th>Typ</th><th>Produkter</th>
              <SortTh col="status" sort={sort} dir={dir} onSort={onSort}>Status</SortTh>
              {showSub && <><SortTh col="plan" sort={sort} dir={dir} onSort={onSort}>Plan</SortTh><th>Abonnemang</th></>}
              <SortTh col="createdAt" sort={sort} dir={dir} onSort={onSort}>Skapad</SortTh>
              <SortTh col="lastActivityAt" sort={sort} dir={dir} onSort={onSort}>Senast aktiv</SortTh>
            </tr></thead>
            <tbody>
              {data?.items.map((w: any) => (
                <tr key={w.id} className="click" onClick={() => nav(`/customers/${w.id}`)}>
                  <td><Link to={`/customers/${w.id}`} onClick={(e) => e.stopPropagation()}><strong>{w.name}</strong></Link><div className="small muted">{w.contactEmail}</div></td>
                  <td>{label('kind', w.kind)}</td>
                  <td><div className="row" style={{ gap: '.3rem' }}>{w.products.filter((p: any) => p.status !== 'Disabled').map((p: any) => <Badge key={p.product} group="entitlementStatus" value={p.status} text={label('product', p.product)} />)}{w.products.every((p: any) => p.status === 'Disabled') && <span className="muted">–</span>}</div></td>
                  <td><Badge group="workspaceStatus" value={w.status} /></td>
                  {showSub && <><td>{w.planId ?? '–'}</td><td>{w.subscriptionStatus ? <Badge group="subscriptionStatus" value={w.subscriptionStatus} /> : '–'}</td></>}
                  <td className="nowrap">{fmtDate(w.createdAt)}</td><td className="nowrap">{relTime(w.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && !data && <div className="loading">Laddar…</div>}
          {data && data.items.length === 0 && <div className="empty">Inga kunder matchar filtret.</div>}
        </div>
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />}
      </div>
    </div>
  );
}
