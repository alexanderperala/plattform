import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { fmtDate, LABELS, relTime } from '../format';
import { Badge, ErrorBox, PageHead, Pager, useDebounced, useLoad } from '../ui';

export function Users() {
  const [sp, setSp] = useSearchParams(); const nav = useNavigate();
  const [text, setText] = useState(sp.get('q') ?? ''); const q = useDebounced(text);
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const { data, error, loading } = useLoad(() => api<any>('GET', '/users' + qs({ q, status: get('status'), workspaceId: get('workspaceId'), page: Number(get('page') || 1) })), [q, sp.toString()]);
  return (
    <div className="stack">
      <PageHead title="Användare" subtitle="Sök bland alla användare på plattformen." />
      <div className="card flush">
        <div className="filters">
          <label className="field search">Sök<input type="search" placeholder="Namn, e-post, telefon, kund eller ID" value={text} onChange={(e) => setText(e.target.value)} /></label>
          <label className="field">Status<select value={get('status')} onChange={(e) => set('status', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.userStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </div>
        {error != null && <div style={{ padding: '1rem' }}><ErrorBox error={error} /></div>}
        <div className="table-wrap"><table>
          <thead><tr><th>Användare</th><th>Status</th><th>E-post verifierad</th><th>Arbetsytor</th><th>Senast inloggad</th><th>Skapad</th></tr></thead>
          <tbody>{data?.items.map((u: any) => (
            <tr key={u.id} className="click" onClick={() => nav(`/users/${u.id}`)}>
              <td><Link to={`/users/${u.id}`} onClick={(e) => e.stopPropagation()}><strong>{u.name}</strong></Link><div className="small muted">{u.email}</div></td>
              <td><Badge group="userStatus" value={u.status} /></td><td>{u.emailVerifiedAt ? 'Ja' : 'Nej'}</td><td>{u.workspaceCount}</td><td>{relTime(u.lastLoginAt)}</td><td className="nowrap">{fmtDate(u.createdAt)}</td>
            </tr>))}</tbody>
        </table>
          {loading && !data && <div className="loading">Laddar…</div>}
          {data && data.items.length === 0 && <div className="empty">Inga användare matchar sökningen.</div>}
        </div>
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />}
      </div>
    </div>
  );
}
