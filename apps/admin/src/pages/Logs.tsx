import { Fragment } from 'react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { fmtDateTime } from '../format';
import { ErrorBox, PageHead, Pager, useDebounced, useLoad } from '../ui';

export function Logs() {
  const [sp, setSp] = useSearchParams(); const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState(''); const q = useDebounced(text);
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const { data, error, loading } = useLoad(() => api<any>('GET', '/logs/errors' + qs({ q, requestId: get('requestId'), workspaceId: get('workspaceId'), page: Number(get('page') || 1) })), [q, sp.toString()]);
  return (
    <div className="stack">
      <PageHead title="Tekniska fel" subtitle="Felloggar kopplade till arbetsyta och användare. Lösenord, tokens och nycklar maskeras. Poster rensas efter 90 dagar." />
      <div className="card flush">
        <div className="filters">
          <label className="field search">Sök<input type="search" placeholder="Meddelande eller felkod" value={text} onChange={(e) => setText(e.target.value)} /></label>
          <label className="field">Referens-ID<input value={get('requestId')} onChange={(e) => set('requestId', e.target.value)} /></label>
        </div>
        {error != null && <div style={{ padding: '1rem' }}><ErrorBox error={error} /></div>}
        <div className="table-wrap"><table><thead><tr><th>Tid</th><th>Kod</th><th>Meddelande</th><th>Kund</th><th>Rutt</th><th /></tr></thead>
          <tbody>{data?.items.map((e: any) => (<Fragment key={e.id}>
            <tr><td className="nowrap">{fmtDateTime(e.at)}</td><td className="mono">{e.code ?? e.statusCode}</td><td>{e.message}</td><td>{e.workspaceName ?? '–'}</td><td className="mono">{e.method} {e.route}</td>
              <td><button className="btn small ghost" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>Detaljer</button></td></tr>
            {open === e.id && <tr><td colSpan={6}><div className="small muted">Referens: <span className="mono">{e.requestId}</span> · Källa: {e.source}</div>{e.details && <pre className="json">{JSON.stringify(e.details, null, 2)}</pre>}</td></tr>}</Fragment>))}</tbody></table>
          {loading && !data && <div className="loading">Laddar…</div>}{data && data.items.length === 0 && <div className="empty">Inga fel registrerade.</div>}</div>
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />}
      </div>
    </div>
  );
}
