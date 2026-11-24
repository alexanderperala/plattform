import { useState } from 'react';
import { api } from './api';
import { Alert, ErrorBox, Field, Modal, fmtDateTime, useLoad } from './ui';

export function Mailings({ wid }: { wid: string }) {
  const base = `/workspaces/${wid}/association/mailings`;
  const { data, error, loading, reload } = useLoad(() => api<any>('GET', base), [wid]);
  const [open, setOpen] = useState<string | 'new' | null>(null);
  return (
    <>
      <div className="row between"><h1>Utskick</h1><button className="btn primary" onClick={() => setOpen('new')}>Nytt utskick</button></div>
      <p className="muted small">Utskick skickas som e-post till aktiva medlemmar med e-postadress som inte avanmält sig. Varje meddelande får en egen avanmälningslänk. Högst {data?.maxPerDay ?? 5} utskick per dygn.</p>
      {error != null && <ErrorBox error={error} />}
      {loading && !data ? <div className="loading">Laddar…</div> : data && (data.items.length === 0 ? <div className="muted">Inga utskick ännu.</div>
        : <table><thead><tr><th>Ämne</th><th>Status</th><th>Mottagare</th><th>Skickat</th></tr></thead><tbody>{data.items.map((m: any) => (
          <tr key={m.id} onClick={() => setOpen(m.id)} style={{ cursor: 'pointer' }}><td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(m.id); }}>{m.subject}</a></td>
            <td><span className={`badge ${m.status === 'sent' ? 'good' : 'warn'}`}>{m.status === 'sent' ? 'Skickat' : 'Utkast'}</span></td><td>{m.recipientCount ?? '–'}</td><td>{fmtDateTime(m.sentAt)}</td></tr>))}</tbody></table>)}
      {open && <Editor wid={wid} id={open === 'new' ? null : open} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

function Editor({ wid, id, onClose, onChanged }: { wid: string; id: string | null; onClose: () => void; onChanged: () => void }) {
  const base = `/workspaces/${wid}/association/mailings`;
  const { data: m, error, reload } = useLoad(() => (id ? api<any>('GET', `${base}/${id}`) : Promise.resolve(null)), [wid, id]);
  const [subject, setSubject] = useState<string | null>(null); const [text, setText] = useState<string | null>(null); const [err, setErr] = useState<unknown>(null); const [done, setDone] = useState<string | null>(null);
  if (error != null) return <Modal title="Utskick" onClose={onClose}><ErrorBox error={error} /></Modal>;
  if (id && !m) return <Modal title="Utskick" onClose={onClose}><div className="loading">Laddar…</div></Modal>;
  const sent = m?.status === 'sent'; const s = subject ?? m?.subject ?? ''; const t = text ?? m?.body ?? '';
  const run = async (fn: () => Promise<unknown>, msg?: string) => { setErr(null); try { await fn(); onChanged(); if (msg) setDone(msg); reload(); } catch (x) { setErr(x); } };
  const saveNew = async () => { setErr(null); try { const r = await api<any>('POST', base, { subject: s, body: t }); onChanged(); onClose(); void r; } catch (x) { setErr(x); } };
  const a = m?.audience;
  return (
    <Modal title={sent ? 'Skickat utskick' : id ? 'Redigera utskick' : 'Nytt utskick'} onClose={onClose}>
      <Field label="Ämne"><input value={s} onChange={(e) => setSubject(e.target.value)} disabled={sent} maxLength={200} required /></Field>
      <Field label="Meddelande"><textarea value={t} onChange={(e) => setText(e.target.value)} disabled={sent} rows={10} maxLength={20000} /></Field>
      {err != null && <ErrorBox error={err} />}
      {done && <Alert kind="good">{done}</Alert>}
      {!sent && a && <Alert kind="info">Skickas till <strong>{a.recipients}</strong> medlemmar. Hoppas över: {a.noEmail} utan e-postadress, {a.optedOut} som avanmält sig, {a.inactive} inaktiva.</Alert>}
      {sent && <div><div className="muted small">Skickat {fmtDateTime(m.sentAt)} till {m.recipientCount} mottagare.</div>
        <details><summary>Mottagare ({m.recipients.length})</summary><ul className="timeline">{m.recipients.map((r: any) => <li key={r.memberId}>{r.name} <span className="muted small">{r.email}</span></li>)}</ul></details></div>}
      <div className="row">
        {!id && <button className="btn primary" onClick={() => void saveNew()}>Spara som utkast</button>}
        {id && !sent && <button className="btn" onClick={() => void run(() => api('PATCH', `${base}/${id}`, { subject: s, body: t }), 'Utkastet är sparat.')}>Spara utkast</button>}
        {id && !sent && <button className="btn primary" disabled={!a?.recipients} onClick={() => { if (confirm(`Skicka till ${a?.recipients} medlemmar? Det går inte att ångra.`)) void run(async () => { await api('PATCH', `${base}/${id}`, { subject: s, body: t }); await api('POST', `${base}/${id}/send`); }, 'Utskicket är skickat.'); }}>Skicka</button>}
        {id && !sent && <button className="btn danger" onClick={() => { if (confirm('Radera utkastet?')) void run(async () => { await api('DELETE', `${base}/${id}`); onClose(); }); }}>Radera</button>}
        <button className="btn" onClick={onClose}>Stäng</button>
      </div>
    </Modal>
  );
}

/** Publik sida (ingen inloggning). Avanmälan sker först när medlemmen bekräftar, så att e-postskannrar inte avanmäler av misstag. */
export function Unsubscribe() {
  const token = new URLSearchParams(window.location.search).get('t') ?? '';
  const { data, error } = useLoad(() => api<{ associationName: string }>('GET', `/public/unsubscribe?t=${encodeURIComponent(token)}`), [token]);
  const [state, setState] = useState<'idle' | 'done'>('idle'); const [err, setErr] = useState<unknown>(null);
  async function confirmIt() { setErr(null); try { await api('POST', `/public/unsubscribe?t=${encodeURIComponent(token)}`, {}); setState('done'); } catch (x) { setErr(x); } }
  return (
    <div className="auth-wrap"><div className="auth-card"><h1>Avsluta utskick</h1>
      {error != null ? <ErrorBox error={error} /> : !data ? <div className="loading">Laddar…</div>
        : state === 'done' ? <Alert kind="good">Klart. Du får inte fler utskick från {data.associationName}. Viktig information kopplad till ditt medlemskap kan ändå skickas på annat sätt.</Alert>
        : <><p>Vill du sluta få e-postutskick från <strong>{data.associationName}</strong>?</p>{err != null && <ErrorBox error={err} />}<button className="btn primary" onClick={() => void confirmIt()}>Ja, avsluta utskick</button></>}
    </div></div>
  );
}
