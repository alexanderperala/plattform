import { useState } from 'react';
import { api } from './api';
import { Alert, ErrorBox, Field, Modal, fmtDateTime, useLoad } from './ui';

interface E { id: string; title: string; description: string; location: string | null; startsAt: string; endsAt: string | null; capacity: number | null; status: 'draft' | 'published'; attendeeCount: number }
const pad = (n: number) => String(n).padStart(2, '0');
const toLocalInput = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const toIso = (v: string) => new Date(v).toISOString();

function Editor({ wid, item, onClose, onDone }: { wid: string; item: E | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ title: item?.title ?? '', description: item?.description ?? '', location: item?.location ?? '', startsAt: toLocalInput(item?.startsAt ?? null), endsAt: toLocalInput(item?.endsAt ?? null), capacity: item?.capacity ? String(item.capacity) : '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const body = { title: f.title, description: f.description, location: f.location, startsAt: toIso(f.startsAt), endsAt: f.endsAt ? toIso(f.endsAt) : null, capacity: f.capacity ? Number(f.capacity) : null };
    try { if (item) await api('PATCH', `/workspaces/${wid}/association/events/${item.id}`, body); else await api('POST', `/workspaces/${wid}/association/events`, body); onDone(); }
    catch (x) { setError(x); } finally { setBusy(false); }
  }
  return (
    <Modal title={item ? 'Redigera aktivitet' : 'Ny aktivitet'} onClose={onClose}>
      <form onSubmit={save} className="stack" style={{ gap: '.8rem' }}>
        <Field label="Rubrik"><input value={f.title} onChange={set('title')} required maxLength={200} autoFocus /></Field>
        <div className="grid cols-2">
          <Field label="Start"><input type="datetime-local" value={f.startsAt} onChange={set('startsAt')} required /></Field>
          <Field label="Slut (valfritt)"><input type="datetime-local" value={f.endsAt} onChange={set('endsAt')} min={f.startsAt} /></Field>
          <Field label="Plats"><input value={f.location} onChange={set('location')} maxLength={200} /></Field>
          <Field label="Antal platser (tomt = obegränsat)"><input type="number" min={1} value={f.capacity} onChange={set('capacity')} /></Field>
        </div>
        <Field label="Beskrivning"><textarea value={f.description} onChange={set('description')} maxLength={10000} rows={5} /></Field>
        {!item && <p className="muted small" style={{ margin: 0 }}>Aktiviteten sparas som utkast. Publicera den när den är klar.</p>}
        {error != null && <ErrorBox error={error} />}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Avbryt</button><button className="btn primary" disabled={busy}>{busy ? 'Sparar…' : 'Spara'}</button></div>
      </form>
    </Modal>
  );
}

function Detail({ wid, id, onClose, onChanged }: { wid: string; id: string; onClose: () => void; onChanged: () => void }) {
  const { data: e, error, reload } = useLoad(() => api<any>('GET', `/workspaces/${wid}/association/events/${id}`), [wid, id]);
  const [q, setQ] = useState(''); const [err, setErr] = useState<unknown>(null);
  const found = useLoad(() => q.trim().length >= 1 && e?.attendees ? api<any>('GET', `/workspaces/${wid}/association/members?status=active&pageSize=8&q=${encodeURIComponent(q.trim())}`) : Promise.resolve({ items: [] }), [q, e?.attendees ? 1 : 0]);
  async function add(memberId: string) { setErr(null); try { await api('POST', `/workspaces/${wid}/association/events/${id}/attendees`, { memberId }); setQ(''); reload(); onChanged(); } catch (x) { setErr(x); } }
  async function remove(memberId: string) { setErr(null); try { await api('DELETE', `/workspaces/${wid}/association/events/${id}/attendees/${memberId}`); reload(); onChanged(); } catch (x) { setErr(x); } }
  const taken = new Set<string>((e?.attendees ?? []).map((a: any) => a.memberId));
  const full = e?.capacity != null && e.attendeeCount >= e.capacity;
  return (
    <Modal title={e?.title ?? 'Aktivitet'} onClose={onClose}>
      {error != null && <ErrorBox error={error} />}
      {e && (<div className="stack" style={{ gap: '.8rem' }}>
        <div className="muted small">{fmtDateTime(e.startsAt)}{e.endsAt ? ` – ${fmtDateTime(e.endsAt)}` : ''}{e.location ? ` · ${e.location}` : ''}</div>
        {e.description && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{e.description}</p>}
        <div><strong>{e.attendeeCount}</strong>{e.capacity != null ? ` av ${e.capacity}` : ''} anmälda {full && <span className="badge warn">Fullsatt</span>}</div>
        {err != null && <ErrorBox error={err} />}
        {e.attendees && (<>
          {e.canManage && <Field label="Anmäl medlem"><input type="search" placeholder="Sök i medlemsregistret" value={q} onChange={(ev) => setQ(ev.target.value)} disabled={full} /></Field>}
          {e.canManage && q.trim() && <ul className="timeline">{found.data?.items.filter((m: any) => !taken.has(m.id)).map((m: any) => <li key={m.id} className="row between"><span>{m.name}{m.memberNumber ? ` (${m.memberNumber})` : ''}</span><button className="btn small primary" onClick={() => void add(m.id)}>Anmäl</button></li>)}</ul>}
          {e.attendees.length === 0 ? <div className="muted small">Inga anmälda ännu.</div> : <ul className="timeline" aria-label="Anmälda">{e.attendees.map((a: any) => <li key={a.memberId} className="row between"><span>{a.name}{a.memberNumber ? ` (${a.memberNumber})` : ''}</span>{e.canManage && <button className="btn small danger" onClick={() => void remove(a.memberId)}>Avanmäl</button>}</li>)}</ul>}
        </>)}
        {!e.attendees && <Alert kind="info">Deltagarlistan visas bara för administratörer.</Alert>}
        <div className="actions"><button className="btn" onClick={onClose}>Stäng</button></div>
      </div>)}
    </Modal>
  );
}

export function Events({ wid }: { wid: string }) {
  const [scope, setScope] = useState<'upcoming' | 'past'>('upcoming'); const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<E | 'new' | null>(null); const [open, setOpen] = useState<string | null>(null); const [del, setDel] = useState<E | null>(null); const [err, setErr] = useState<unknown>(null);
  const { data, error, loading, reload } = useLoad(() => api<any>('GET', `/workspaces/${wid}/association/events?scope=${scope}&page=${page}&pageSize=20`), [wid, scope, page]);
  const manage: boolean = data?.canManage ?? false;
  async function act(e: E, what: 'publish' | 'unpublish') { setErr(null); try { await api('POST', `/workspaces/${wid}/association/events/${e.id}/${what}`); reload(); } catch (x) { setErr(x); } }
  async function remove(e: E) { setErr(null); try { await api('DELETE', `/workspaces/${wid}/association/events/${e.id}`); setDel(null); reload(); } catch (x) { setErr(x); setDel(null); } }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Kalender</h1><p>{manage ? 'Utkast syns bara för administratörer.' : 'Föreningens aktiviteter.'}</p></div>
        <div className="row"><select aria-label="Visa" value={scope} onChange={(e) => { setScope(e.target.value as 'upcoming' | 'past'); setPage(1); }} style={{ width: 'auto' }}><option value="upcoming">Kommande</option><option value="past">Tidigare</option></select>
          {manage && <button className="btn primary" onClick={() => setEdit('new')}>Ny aktivitet</button>}</div></div>
      {(error != null || err != null) && <ErrorBox error={error ?? err} />}
      {loading && !data && <div className="loading">Laddar…</div>}
      {data && data.items.length === 0 && <div className="card"><div className="empty">{scope === 'upcoming' ? 'Inga kommande aktiviteter.' : 'Inga tidigare aktiviteter.'}</div></div>}
      {data?.items.map((e: E) => (
        <article className="card" key={e.id} aria-label={e.title}>
          <div className="row between"><h2 style={{ margin: 0 }}>{e.title}</h2><span className="row">{e.status === 'draft' && <span className="badge warn">Utkast</span>}</span></div>
          <div className="muted small">{fmtDateTime(e.startsAt)}{e.endsAt ? ` – ${fmtDateTime(e.endsAt)}` : ''}{e.location ? ` · ${e.location}` : ''}</div>
          <div className="small">{e.attendeeCount} anmälda{e.capacity != null ? ` av ${e.capacity}` : ''}{e.capacity != null && e.attendeeCount >= e.capacity && <> <span className="badge warn">Fullsatt</span></>}</div>
          <div className="row"><button className="btn small" onClick={() => setOpen(e.id)}>Visa{manage ? ' och hantera anmälda' : ''}</button>
            {manage && <>{e.status === 'draft' ? <button className="btn small primary" onClick={() => void act(e, 'publish')}>Publicera</button> : <button className="btn small" onClick={() => void act(e, 'unpublish')}>Avpublicera</button>}
              <button className="btn small" onClick={() => setEdit(e)}>Redigera</button><button className="btn small danger" onClick={() => setDel(e)}>Ta bort</button></>}</div>
        </article>))}
      {data && data.total > data.pageSize && <div className="row between"><span className="small muted">Sida {page} av {pages}</span><span className="row"><button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Föregående</button><button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Nästa</button></span></div>}
      {edit && <Editor wid={wid} item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {open && <Detail wid={wid} id={open} onClose={() => setOpen(null)} onChanged={reload} />}
      {del && <Modal title="Ta bort aktivitet" onClose={() => setDel(null)}><p style={{ marginTop: 0 }}>Vill du ta bort <strong>{del.title}</strong> och alla anmälningar? Det går inte att ångra.</p><div className="actions"><button className="btn" onClick={() => setDel(null)}>Avbryt</button><button className="btn danger" onClick={() => void remove(del)}>Ta bort</button></div></Modal>}
    </div>
  );
}
