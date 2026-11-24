import { useEffect, useState } from 'react';
import { api } from './api';
import { Alert, ErrorBox, Field, LABEL, Modal, useLoad } from './ui';

interface M { id: string; memberNumber: string | null; name: string; email: string | null; phone: string | null; status: 'active' | 'inactive'; joinedOn: string | null; notes: string | null; emailOptOut?: boolean }
const empty = { name: '', email: '', phone: '', memberNumber: '', status: 'active', joinedOn: '', notes: '' };

function MemberForm({ wid, member, onClose, onDone }: { wid: string; member: M | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState(member ? { name: member.name, email: member.email ?? '', phone: member.phone ?? '', memberNumber: member.memberNumber ?? '', status: member.status, joinedOn: member.joinedOn ?? '', notes: member.notes ?? '' } : empty);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const body = { name: f.name, email: f.email, phone: f.phone, memberNumber: f.memberNumber, status: f.status, joinedOn: f.joinedOn || null, notes: f.notes };
    try { if (member) await api('PATCH', `/workspaces/${wid}/association/members/${member.id}`, body); else await api('POST', `/workspaces/${wid}/association/members`, body); onDone(); }
    catch (x) { setError(x); } finally { setBusy(false); }
  }
  return (
    <Modal title={member ? 'Ändra medlem' : 'Ny medlem'} onClose={onClose}>
      <form onSubmit={save} className="stack" style={{ gap: '.8rem' }}>
        <Field label="Namn"><input value={f.name} onChange={set('name')} required maxLength={200} autoFocus /></Field>
        <div className="grid cols-2">
          <Field label="E-post"><input type="email" value={f.email} onChange={set('email')} maxLength={200} /></Field>
          <Field label="Telefon"><input value={f.phone} onChange={set('phone')} maxLength={40} /></Field>
          <Field label="Medlemsnummer"><input value={f.memberNumber} onChange={set('memberNumber')} maxLength={40} /></Field>
          <Field label="Medlem sedan"><input type="date" value={f.joinedOn} onChange={set('joinedOn')} /></Field>
        </div>
        <Field label="Status"><select value={f.status} onChange={set('status')}><option value="active">Aktiv</option><option value="inactive">Inaktiv</option></select></Field>
        <Field label="Anteckningar"><textarea value={f.notes} onChange={set('notes')} maxLength={2000} /></Field>
        {error != null && <ErrorBox error={error} />}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Avbryt</button><button className="btn primary" disabled={busy}>{busy ? 'Sparar…' : 'Spara'}</button></div>
      </form>
    </Modal>
  );
}

function downloadTemplate() {
  const csv = '\ufeffMedlemsnummer;Namn;E-post;Telefon;Status;Medlem sedan;Anteckningar\r\n1001;Anna Andersson;anna@example.com;070-1234567;Aktiv;2024-03-01;\r\n';
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'medlemmar-mall.csv'; a.click(); URL.revokeObjectURL(a.href);
}

function ImportDialog({ wid, onClose, onDone }: { wid: string; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState<string | null>(null); const [fileName, setFileName] = useState(''); const [pv, setPv] = useState<any>(null);
  const [skip, setSkip] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState<{ imported: number; skipped: number } | null>(null);
  const base = `/workspaces/${wid}/association/members/import`;
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    setError(null); setPv(null); setFileName(f.name);
    if (f.size > 800_000) { setError(new Error('Filen är för stor (max cirka 800 kB, högst 5 000 rader). Dela upp den.')); return; }
    const text = await f.text(); setCsv(text); setBusy(true);
    try { setPv(await api('POST', `${base}/preview`, { csv: text })); } catch (x) { setError(x); } finally { setBusy(false); }
  }
  async function run() {
    if (!csv) return; setBusy(true); setError(null);
    try { setDone(await api('POST', base, { csv, skipInvalid: skip })); } catch (x) { setError(x); } finally { setBusy(false); }
  }
  const garbled = csv?.includes('\ufffd');
  const canRun = pv && !pv.fatal && pv.valid > 0 && pv.canImport && !pv.wouldExceedLimit && (pv.invalid === 0 || skip);
  return (
    <Modal title="Importera medlemmar" onClose={done ? onDone : onClose}>
      {done ? (<div className="stack"><Alert kind="good">{done.imported} medlemmar importerades{done.skipped ? `, ${done.skipped} rader hoppades över` : ''}.</Alert><div className="actions"><button className="btn primary" onClick={onDone}>Klart</button></div></div>) : (
      <div className="stack" style={{ gap: '.8rem' }}>
        <p className="muted small" style={{ margin: 0 }}>CSV-fil med rubrikrad (komma eller semikolon). Kolumner: Medlemsnummer, Namn (krävs), E-post, Telefon, Status (Aktiv/Inaktiv), Medlem sedan (ÅÅÅÅ-MM-DD), Anteckningar. Filen ska vara UTF-8. <button type="button" className="btn small" onClick={downloadTemplate}>Ladda ned mall</button></p>
        <Field label="CSV-fil"><input type="file" accept=".csv,text/csv" onChange={(e) => void pick(e)} /></Field>
        {busy && !pv && <div className="loading">Granskar filen…</div>}
        {garbled && <Alert kind="warn">Filen verkar inte vara UTF-8 (konstiga tecken hittades). Spara den som “CSV UTF-8” från Excel och försök igen, annars blir å, ä och ö fel.</Alert>}
        {pv?.fatal && <Alert>{pv.fatal}</Alert>}
        {pv && !pv.fatal && (<>
          <Alert kind={pv.invalid ? 'warn' : 'good'}><strong>{fileName}</strong>: {pv.total} rader, {pv.valid} giltiga{pv.invalid ? `, ${pv.invalid} med fel` : ''}.{pv.unknownColumns.length > 0 && <> Okända kolumner ignoreras: {pv.unknownColumns.join(', ')}.</>}</Alert>
          {pv.wouldExceedLimit && <Alert>Importen skulle överskrida medlemsgränsen ({pv.access.max}, nu {pv.access.used}). Minska filen eller uppgradera abonnemanget.</Alert>}
          {!pv.canImport && <Alert kind="warn">Du kan inte lägga till medlemmar just nu (gräns nådd eller skrivskyddat).</Alert>}
          {pv.errors.length > 0 && <div className="table-wrap" style={{ maxHeight: 220, overflow: 'auto' }}><table><thead><tr><th>Rad</th><th>Fel</th></tr></thead><tbody>{pv.errors.map((er: any) => <tr key={er.line}><td>{er.line}</td><td>{er.errors.join('; ')}</td></tr>)}</tbody></table></div>}
          {pv.invalid > 0 && <label className="row small"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Hoppa över raderna med fel och importera resten</label>}
        </>)}
        {error != null && <ErrorBox error={error} />}
        <div className="actions"><button className="btn" onClick={onClose}>Avbryt</button><button className="btn primary" disabled={!canRun || busy} onClick={() => void run()}>{busy && pv ? 'Importerar…' : `Importera ${pv?.valid ?? 0} medlemmar`}</button></div>
      </div>)}
    </Modal>
  );
}

export function Members({ wid, isAdmin }: { wid: string; isAdmin: boolean }) {
  const [q, setQ] = useState(''); const [dq, setDq] = useState(''); const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const [importing, setImporting] = useState(false); const [edit, setEdit] = useState<M | 'new' | null>(null); const [del, setDel] = useState<M | null>(null); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { const t = setTimeout(() => { setDq(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const qs = new URLSearchParams({ page: String(page), pageSize: '25', ...(dq ? { q: dq } : {}), ...(status ? { status } : {}) }).toString();
  const { data, error, loading, reload } = useLoad(() => api<any>('GET', `/workspaces/${wid}/association/members?${qs}`), [wid, qs]);
  const mode: string = data?.access.mode ?? 'full';
  const canWrite = isAdmin && (mode === 'full' || mode === 'limited');
  const canAdd = isAdmin && mode === 'full' && (data?.access.max == null || data.access.used < data.access.max);
  async function remove(m: M) { setErr(null); try { await api('DELETE', `/workspaces/${wid}/association/members/${m.id}`); setDel(null); reload(); } catch (e) { setErr(e); setDel(null); } }
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Medlemsregister</h1>
        <p>{data ? `${data.access.used} medlemmar${data.access.max != null ? ` av ${data.access.max}` : ''}` : ' '}</p></div>
        <div className="row">{isAdmin && <a className="btn" href={`/api/v1/workspaces/${wid}/association/members/export?format=csv`}>Exportera CSV</a>}
          {canAdd && <button className="btn" onClick={() => setImporting(true)}>Importera CSV</button>}
          {canWrite && <button className="btn primary" onClick={() => setEdit('new')} disabled={!canAdd}>Ny medlem</button>}</div></div>
      {mode !== 'full' && data && <Alert kind="warn">{mode === 'limited' ? 'Medlemsgränsen är nådd: du kan ändra och ta bort medlemmar men inte lägga till fler. Uppgradera abonnemanget i kontoportalen.' : `Åtkomst: ${LABEL.mode[mode] ?? mode}. Du kan läsa men inte ändra medlemsregistret.`}</Alert>}
      {mode === 'full' && data?.access.max != null && data.access.used >= data.access.max && <Alert kind="warn">Medlemsgränsen ({data.access.max}) är nådd. Uppgradera abonnemanget för att lägga till fler.</Alert>}
      {(error != null || err != null) && <ErrorBox error={error ?? err} />}
      <div className="card flush">
        <div className="row" style={{ padding: '.8rem 1rem' }}>
          <input type="search" aria-label="Sök medlem" placeholder="Sök namn, e-post eller nummer" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
          <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} style={{ width: 'auto' }}><option value="">Alla</option><option value="active">Aktiva</option><option value="inactive">Inaktiva</option></select>
        </div>
        <div className="table-wrap"><table><thead><tr><th>Nr</th><th>Namn</th><th>E-post</th><th>Telefon</th><th>Status</th><th>Medlem sedan</th>{canWrite && <th />}</tr></thead>
          <tbody>{data?.items.map((m: M) => <tr key={m.id}><td>{m.memberNumber ?? '–'}</td><td><strong>{m.name}</strong></td><td>{m.email ?? '–'}</td><td>{m.phone ?? '–'}</td>
            <td><span className={`badge ${m.status === 'active' ? 'good' : ''}`}>{m.status === 'active' ? 'Aktiv' : 'Inaktiv'}</span>{m.emailOptOut && <span className="badge" title="Har avanmält sig från e-postutskick"> Avstängd för utskick</span>}</td><td>{m.joinedOn ?? '–'}</td>
            {canWrite && <td className="nowrap"><button className="btn small" onClick={() => setEdit(m)}>Ändra</button> <button className="btn small danger" onClick={() => setDel(m)}>Ta bort</button></td>}</tr>)}</tbody></table>
          {loading && !data && <div className="loading">Laddar…</div>}
          {data && data.items.length === 0 && <div className="empty">{dq || status ? 'Inga medlemmar matchar sökningen.' : 'Inga medlemmar ännu. Lägg till den första med “Ny medlem”.'}</div>}</div>
        {data && data.total > data.pageSize && <div className="row between" style={{ padding: '.8rem 1rem' }}><span className="small muted">Sida {page} av {pages} · {data.total} träffar</span>
          <span className="row"><button className="btn small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Föregående</button><button className="btn small" disabled={page >= pages} onClick={() => setPage(page + 1)}>Nästa</button></span></div>}
      </div>
      {importing && <ImportDialog wid={wid} onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload(); }} />}
      {edit && <MemberForm wid={wid} member={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {del && <Modal title="Ta bort medlem" onClose={() => setDel(null)}><p style={{ marginTop: 0 }}>Vill du ta bort <strong>{del.name}</strong> ur medlemsregistret? Uppgifterna raderas permanent och kan inte återställas.</p>
        <div className="actions"><button className="btn" onClick={() => setDel(null)}>Avbryt</button><button className="btn danger" onClick={() => void remove(del)}>Ta bort</button></div></Modal>}
    </div>
  );
}
