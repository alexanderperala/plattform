import { useState } from 'react';
import { api } from './api';
import { Alert, ErrorBox, Field, Modal, fmtDateTime, useLoad } from './ui';

interface N { id: string; title: string; body: string; status: 'draft' | 'published'; pinned: boolean; publishedAt: string | null; updatedAt: string }

function Editor({ wid, item, onClose, onDone }: { wid: string; item: N | null; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(item?.title ?? ''); const [body, setBody] = useState(item?.body ?? ''); const [pinned, setPinned] = useState(item?.pinned ?? false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { if (item) await api('PATCH', `/workspaces/${wid}/association/news/${item.id}`, { title, body, pinned }); else await api('POST', `/workspaces/${wid}/association/news`, { title, body, pinned }); onDone(); }
    catch (x) { setError(x); } finally { setBusy(false); }
  }
  return (
    <Modal title={item ? 'Redigera nyhet' : 'Ny nyhet'} onClose={onClose}>
      <form onSubmit={save} className="stack" style={{ gap: '.8rem' }}>
        <Field label="Rubrik"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} autoFocus /></Field>
        <Field label="Text" hint="Ren text. Radbrytningar bevaras."><textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} rows={10} /></Field>
        <label className="row small"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Fäst överst</label>
        {!item && <p className="muted small" style={{ margin: 0 }}>Nyheten sparas som utkast. Publicera den när den är klar.</p>}
        {error != null && <ErrorBox error={error} />}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Avbryt</button><button className="btn primary" disabled={busy}>{busy ? 'Sparar…' : 'Spara'}</button></div>
      </form>
    </Modal>
  );
}

export function News({ wid }: { wid: string }) {
  const [page, setPage] = useState(1); const [status, setStatus] = useState('');
  const [edit, setEdit] = useState<N | 'new' | null>(null); const [del, setDel] = useState<N | null>(null); const [err, setErr] = useState<unknown>(null);
  const qs = new URLSearchParams({ page: String(page), pageSize: '10', ...(status ? { status } : {}) }).toString();
  const { data, error, loading, reload } = useLoad(() => api<any>('GET', `/workspaces/${wid}/association/news?${qs}`), [wid, qs]);
  const manage: boolean = data?.canManage ?? false;
  async function act(n: N, what: 'publish' | 'unpublish') { setErr(null); try { await api('POST', `/workspaces/${wid}/association/news/${n.id}/${what}`); reload(); } catch (e) { setErr(e); } }
  async function remove(n: N) { setErr(null); try { await api('DELETE', `/workspaces/${wid}/association/news/${n.id}`); setDel(null); reload(); } catch (e) { setErr(e); setDel(null); } }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Nyheter</h1><p>{manage ? 'Utkast syns bara för administratörer. Publicerade nyheter syns för alla i arbetsytan.' : 'Senaste nytt från föreningen.'}</p></div>
        <div className="row">{manage && <select aria-label="Visa" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: 'auto' }}><option value="">Alla</option><option value="published">Publicerade</option><option value="draft">Utkast</option></select>}
          {manage && <button className="btn primary" onClick={() => setEdit('new')}>Ny nyhet</button>}</div></div>
      {(error != null || err != null) && <ErrorBox error={error ?? err} />}
      {loading && !data && <div className="loading">Laddar…</div>}
      {data && data.items.length === 0 && <div className="card"><div className="empty">{manage ? 'Inga nyheter ännu. Skapa den första med “Ny nyhet”.' : 'Inga nyheter har publicerats ännu.'}</div></div>}
      {data?.items.map((n: N) => (
        <article className="card" key={n.id} aria-label={n.title}>
          <div className="row between">
            <h2 style={{ margin: 0 }}>{n.pinned && <span title="Fäst" aria-label="Fäst">📌 </span>}{n.title}</h2>
            <span className="row">{n.status === 'draft' && <span className="badge warn">Utkast</span>}</span>
          </div>
          <div className="muted small">{n.status === 'published' ? `Publicerad ${fmtDateTime(n.publishedAt)}` : `Senast ändrad ${fmtDateTime(n.updatedAt)}`}</div>
          <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{n.body}</p>
          {manage && <div className="row">
            {n.status === 'draft' ? <button className="btn small primary" onClick={() => void act(n, 'publish')}>Publicera</button> : <button className="btn small" onClick={() => void act(n, 'unpublish')}>Avpublicera</button>}
            <button className="btn small" onClick={() => setEdit(n)}>Redigera</button><button className="btn small danger" onClick={() => setDel(n)}>Ta bort</button></div>}
        </article>))}
      {data && data.total > data.pageSize && <div className="row between"><span className="small muted">Sida {page} av {pages}</span>
        <span className="row"><button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Föregående</button><button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Nästa</button></span></div>}
      {!manage && data && <Alert kind="info">Du har läsbehörighet. Kontakta en administratör om du vill publicera nyheter.</Alert>}
      {edit && <Editor wid={wid} item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {del && <Modal title="Ta bort nyhet" onClose={() => setDel(null)}><p style={{ marginTop: 0 }}>Vill du ta bort <strong>{del.title}</strong>? Det går inte att ångra.</p>
        <div className="actions"><button className="btn" onClick={() => setDel(null)}>Avbryt</button><button className="btn danger" onClick={() => void remove(del)}>Ta bort</button></div></Modal>}
    </div>
  );
}
