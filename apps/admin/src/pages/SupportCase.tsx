import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime, LABELS, label } from '../format';
import { Alert, Badge, ErrorBox, Field, PageHead, useLoad, useToast } from '../ui';

export function SupportCase() {
  const { id } = useParams(); const { can } = useAuth(); const toast = useToast();
  const { data: d, error, loading, reload } = useLoad(() => api<any>('GET', `/support/cases/${id}`), [id]);
  const [body, setBody] = useState(''); const [toCustomer, setToCustomer] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  if (loading && !d) return <div className="loading">Laddar ärende…</div>;
  if (error) return <ErrorBox error={error} />;
  if (!d) return null;
  const c = d.case;
  async function patch(b: object) { setErr(null); try { await api('PATCH', `/support/cases/${id}`, b); toast('Ärendet uppdaterat.', 'good'); reload(); } catch (x) { setErr(x); } }
  async function comment(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('POST', `/support/cases/${id}/comments`, { body, internal: !toCustomer }); setBody(''); setToCustomer(false); if (toCustomer) toast('Svaret är köat för utskick till kunden.', 'good'); reload(); } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  const manage = can('support.manage');
  return (
    <div className="stack">
      <PageHead title={`#${c.number} ${c.subject}`} subtitle={<><Badge group="caseStatus" value={c.status} /> <Badge group="priority" value={c.priority} /> <span className="muted">· {label('category', c.category)} · skapat {fmtDateTime(c.createdAt)}</span></>} />
      {err != null && <ErrorBox error={err} />}
      <div className="grid cols-2">
        <div className="stack">
          <div className="card"><h2>Beskrivning</h2><div style={{ whiteSpace: 'pre-wrap' }}>{c.description || <span className="muted">Ingen beskrivning.</span>}</div></div>
          <div className="card"><h2>Kommentarer</h2>
            <div className="stack">{d.comments.map((m: any) => <div key={m.id} className={`comment ${m.internal ? 'internal' : ''}`}><div className="small muted">{m.authorName ?? 'system'} · {fmtDateTime(m.createdAt)} · {m.internal ? 'intern' : 'skickat till kund'}</div><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></div>)}
              {d.comments.length === 0 && <div className="muted">Inga kommentarer.</div>}</div>
            {manage && <form onSubmit={comment} className="stack" style={{ marginTop: '1rem' }}>
              <Field label={toCustomer ? 'Svar till kund' : 'Intern kommentar'} hint={toCustomer ? 'Skickas som e-post till ärendets avsändare och loggas.' : 'Syns bara för administratörer.'}><textarea value={body} onChange={(e) => setBody(e.target.value)} required maxLength={10000} /></Field>
              <label className="row small"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={toCustomer} onChange={(e) => setToCustomer(e.target.checked)} /> Skicka som svar till kunden (e-post)</label>
              <div><button className="btn primary" disabled={busy || !body.trim()}>{toCustomer ? 'Skicka svar' : 'Lägg till kommentar'}</button></div></form>}
          </div>
        </div>
        <div className="stack">
          <div className="card"><h2>Hantering</h2>
            <dl className="kv"><dt>Kund</dt><dd>{c.workspaceId ? <Link to={`/customers/${c.workspaceId}`}>{c.workspaceName}</Link> : '–'}</dd>
              <dt>Användare</dt><dd>{c.userId ? <Link to={`/users/${c.userId}`}>{c.userName}</Link> : '–'}</dd><dt>Avsändare</dt><dd>{c.requesterEmail ?? '–'}</dd><dt>Ansvarig</dt><dd>{c.assignedAdminName ?? '–'}</dd></dl>
            {manage && <div className="stack" style={{ marginTop: '1rem' }}>
              <Field label="Status"><select value={c.status} onChange={(e) => void patch({ status: e.target.value })}><option value={c.status}>{label('caseStatus', c.status)}</option>{d.allowedTransitions.map((s: string) => <option key={s} value={s}>{label('caseStatus', s)}</option>)}</select></Field>
              <Field label="Prioritet"><select value={c.priority} onChange={(e) => void patch({ priority: e.target.value })}>{Object.entries(LABELS.priority).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Kategori"><select value={c.category} onChange={(e) => void patch({ category: e.target.value })}>{Object.entries(LABELS.category).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <button className="btn" onClick={() => void patch({ assignedAdminId: null })}>Ta bort ansvarig</button>
            </div>}
          </div>
          <div className="card"><h2>Supportsessioner</h2>
            {d.accessSessions.length === 0 && <div className="muted">Ingen åtkomst har startats för ärendet. Starta en session från kundens supportflik.</div>}
            <ul className="timeline">{d.accessSessions.map((s: any) => <li key={s.id}>{s.adminName} · {fmtDateTime(s.startedAt)}{s.endedAt ? ` → ${fmtDateTime(s.endedAt)}` : ' (aktiv till ' + fmtDateTime(s.expiresAt) + ')'}</li>)}</ul>
            {c.workspaceId && <Alert kind="info">Öppna kunden för att starta en ny skrivskyddad session.</Alert>}
          </div>
        </div>
      </div>
    </div>
  );
}
