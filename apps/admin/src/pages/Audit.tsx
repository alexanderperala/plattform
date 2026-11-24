import { Fragment } from 'react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { auditLabel, fmtDateTime, LABELS } from '../format';
import { Badge, ErrorBox, PageHead, Pager, useDebounced, useLoad } from '../ui';

export function Audit() {
  const [sp, setSp] = useSearchParams(); const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState(''); const q = useDebounced(text);
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const { data, error, loading } = useLoad(() => api<any>('GET', '/audit' + qs({ q, action: get('action'), severity: get('severity'), workspaceId: get('workspaceId'), userId: get('userId'), from: get('from'), to: get('to') ? get('to') + 'T23:59:59' : '', page: Number(get('page') || 1) })), [q, sp.toString()]);
  return (
    <div className="stack">
      <PageHead title="Granskningslogg" subtitle="Append-only. Poster kan varken ändras eller raderas. Hemligheter är maskerade." />
      <div className="card flush">
        <div className="filters">
          <label className="field search">Sök<input type="search" placeholder="Orsak eller administratör" value={text} onChange={(e) => setText(e.target.value)} /></label>
          <label className="field">Åtgärd (prefix)<input value={get('action')} onChange={(e) => set('action', e.target.value)} placeholder="t.ex. subscription." /></label>
          <label className="field">Allvarlighet<select value={get('severity')} onChange={(e) => set('severity', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.severity).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Från<input type="date" value={get('from')} onChange={(e) => set('from', e.target.value)} /></label>
          <label className="field">Till<input type="date" value={get('to')} onChange={(e) => set('to', e.target.value)} /></label>
        </div>
        {(get('workspaceId') || get('userId')) && <div style={{ padding: '.6rem 1.25rem' }} className="small">Filtrerat på {get('workspaceId') ? 'kund' : 'användare'}. <button className="btn small ghost" onClick={() => { set('workspaceId', ''); set('userId', ''); }}>Rensa</button></div>}
        {error != null && <div style={{ padding: '1rem' }}><ErrorBox error={error} /></div>}
        <div className="table-wrap"><table><thead><tr><th>Tid</th><th>Administratör</th><th>Åtgärd</th><th>Orsak</th><th /></tr></thead>
          <tbody>{data?.items.map((e: any) => (<Fragment key={e.id}>
            <tr><td className="nowrap">{fmtDateTime(e.at)}</td><td>{e.adminEmail ?? 'system'}<div className="small muted">{e.adminRole}</div></td>
              <td>{auditLabel(e.action)} <Badge group="severity" value={e.severity} />{e.breakGlass && <span className="badge bad">break-glass</span>}{e.selfApproved && <span className="badge warn">självgodkänd</span>}<div className="small mono muted">{e.action}</div></td>
              <td style={{ maxWidth: 320 }}>{e.reason ?? '–'}</td><td><button className="btn small ghost" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>Detaljer</button></td></tr>
            {open === e.id && <tr><td colSpan={5}>
              <div className="small muted">Referens: <span className="mono">{e.requestId ?? '–'}</span> · Mål: <span className="mono">{e.targetType ?? '–'} {e.targetId ?? ''}</span></div>
              {e.before && <><strong className="small">Före</strong><pre className="json">{JSON.stringify(e.before, null, 2)}</pre></>}
              {e.after && <><strong className="small">Efter</strong><pre className="json">{JSON.stringify(e.after, null, 2)}</pre></>}
              {e.meta && <><strong className="small">Meta</strong><pre className="json">{JSON.stringify(e.meta, null, 2)}</pre></>}</td></tr>}</Fragment>))}</tbody></table>
          {loading && !data && <div className="loading">Laddar…</div>}{data && data.items.length === 0 && <div className="empty">Inga loggposter matchar filtret.</div>}</div>
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />}
      </div>
    </div>
  );
}
