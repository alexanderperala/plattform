import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime, LABELS, label } from '../format';
import { ActionButton, Badge, ErrorBox, PageHead, Pager, useDebounced, useLoad } from '../ui';
import { NewCaseDialog } from './CustomerDetail';

export function Support() {
  const [sp, setSp] = useSearchParams(); const nav = useNavigate(); const { can } = useAuth();
  const [text, setText] = useState(''); const q = useDebounced(text);
  const get = (k: string) => sp.get(k) ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };
  const { data, error, loading } = useLoad(() => api<any>('GET', '/support/cases' + qs({ q, status: get('status'), open: get('open'), priority: get('priority'), category: get('category'), assignedTo: get('assignedTo'), page: Number(get('page') || 1) })), [q, sp.toString()]);
  const mine = useLoad(() => api<any>('GET', '/support/access-sessions?mine=true'), []);
  return (
    <div className="stack">
      <PageHead title="Support" subtitle="Supportärenden och pågående supportåtkomst.">
        {can('support.manage') && <ActionButton dialog={(c) => <NewCaseDialog onClose={c} onDone={(r) => { c(); nav(`/support/cases/${r.id}`); }} />}>Nytt ärende</ActionButton>}
      </PageHead>
      {mine.data?.items.length > 0 && (
        <div className="card"><h2>Dina aktiva supportsessioner</h2><ul className="timeline">{mine.data.items.map((s: any) => <li key={s.id}><Link to={`/support/access/${s.id}`}>{s.workspaceName}</Link> · slutar {fmtDateTime(s.expiresAt)}</li>)}</ul></div>
      )}
      <div className="card flush">
        <div className="filters">
          <label className="field search">Sök<input type="search" placeholder="Ämne, ärendenummer eller e-post" value={text} onChange={(e) => setText(e.target.value)} /></label>
          <label className="field">Visa<select value={get('open')} onChange={(e) => set('open', e.target.value)}><option value="">Alla</option><option value="true">Öppna</option><option value="false">Avslutade</option></select></label>
          <label className="field">Status<select value={get('status')} onChange={(e) => set('status', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.caseStatus).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Prioritet<select value={get('priority')} onChange={(e) => set('priority', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.priority).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Kategori<select value={get('category')} onChange={(e) => set('category', e.target.value)}><option value="">Alla</option>{Object.entries(LABELS.category).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="field">Ansvarig<select value={get('assignedTo')} onChange={(e) => set('assignedTo', e.target.value)}><option value="">Alla</option><option value="me">Mina</option></select></label>
        </div>
        {error != null && <div style={{ padding: '1rem' }}><ErrorBox error={error} /></div>}
        <div className="table-wrap"><table><thead><tr><th>#</th><th>Ämne</th><th>Kund</th><th>Kategori</th><th>Prioritet</th><th>Status</th><th>Ansvarig</th><th>Uppdaterad</th></tr></thead>
          <tbody>{data?.items.map((c: any) => <tr key={c.id} className="click" onClick={() => nav(`/support/cases/${c.id}`)}>
            <td className="mono">{c.number}</td><td><Link to={`/support/cases/${c.id}`} onClick={(e) => e.stopPropagation()}><strong>{c.subject}</strong></Link></td><td>{c.workspaceName ?? '–'}</td><td>{label('category', c.category)}</td>
            <td><Badge group="priority" value={c.priority} /></td><td><Badge group="caseStatus" value={c.status} /></td><td>{c.assignedAdminName ?? '–'}</td><td className="nowrap">{fmtDateTime(c.updatedAt)}</td></tr>)}</tbody></table>
          {loading && !data && <div className="loading">Laddar…</div>}{data && data.items.length === 0 && <div className="empty">Inga ärenden matchar filtret.</div>}</div>
        {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set('page', String(p))} />}
      </div>
    </div>
  );
}
