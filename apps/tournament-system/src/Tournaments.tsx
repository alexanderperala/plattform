import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from './api';
import { Alert, ErrorBox, Field, Modal, useLoad } from './ui';

const STATUS: Record<string, string> = { draft: 'Utkast', running: 'Pågår', finished: 'Avslutad' };
const FORMAT: Record<string, string> = { round_robin: 'Serie', single_elimination: 'Utslagning', groups_knockout: 'Gruppspel + slutspel' };
const roundName = (r: number, total: number) => (total - r === 0 ? 'Final' : total - r === 1 ? 'Semifinal' : total - r === 2 ? 'Kvartsfinal' : total - r === 3 ? 'Åttondelsfinal' : `Omgång ${r}`);
const num = (v: string) => (v.trim() === '' ? null : Number(v));

export function Tournaments({ wid }: { wid: string }) {
  const { data, error, loading, reload } = useLoad(() => api<any>('GET', `/workspaces/${wid}/tournaments`), [wid]);
  const [adding, setAdding] = useState(false); const nav = useNavigate();
  return (
    <>
      <div className="row between"><h1>Turneringar</h1><div className="row">{data?.canManage && <a className="btn" href={`/api/v1/workspaces/${wid}/tournaments/export?format=csv`}>Exportera CSV</a>}{data?.canManage && <button className="btn primary" onClick={() => setAdding(true)}>Ny turnering</button>}</div></div>
      {error != null && <ErrorBox error={error} />}
      {loading && !data ? <div className="loading">Laddar…</div> : data && (data.items.length === 0
        ? <div className="muted">Inga turneringar ännu.{data.canManage ? ' Skapa den första med knappen ovan.' : ''}</div>
        : <ul className="timeline">{data.items.map((t: any) => (
            <li key={t.id}><article>
              <div className="row between"><Link to={`/tournaments/${t.id}`}><strong>{t.name}</strong></Link><span className={`badge ${t.status === 'running' ? 'good' : t.status === 'finished' ? '' : 'warn'}`}>{STATUS[t.status]}</span></div>
              <div className="muted small">{FORMAT[t.format]} · {t.teamCount} lag · {t.playedCount} av {t.matchCount} matcher spelade{t.doubleRound ? ' · dubbelserie' : ''}</div>
            </article></li>))}</ul>)}
      {adding && <Create wid={wid} onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); reload(); nav(`/tournaments/${id}`); }} />}
    </>
  );
}

function Create({ wid, onClose, onDone }: { wid: string; onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState(''); const [dbl, setDbl] = useState(false); const [format, setFormat] = useState('round_robin'); const [groups, setGroups] = useState('2'); const [adv, setAdv] = useState('2'); const [error, setError] = useState<unknown>(null);
  async function save(e: React.FormEvent) { e.preventDefault(); setError(null); try { const r = await api<any>('POST', `/workspaces/${wid}/tournaments`, { name, format, doubleRound: format === 'round_robin' && dbl, ...(format === 'groups_knockout' ? { groupCount: Number(groups), advancePerGroup: Number(adv) } : {}) }); onDone(r.id); } catch (x) { setError(x); } }
  return (
    <Modal title="Ny turnering" onClose={onClose}>
      <form onSubmit={save}>
        <Field label="Namn"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus /></Field>
        <Field label="Format"><select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value)}><option value="round_robin">Serie (alla möter alla)</option><option value="single_elimination">Utslagning (cup)</option><option value="groups_knockout">Gruppspel + slutspel</option></select></Field>
        {format === 'groups_knockout' && <div className="row"><Field label="Antal grupper"><select aria-label="Antal grupper" value={groups} onChange={(e) => setGroups(e.target.value)}><option>2</option><option>4</option><option>8</option></select></Field><Field label="Vidare per grupp"><select aria-label="Vidare per grupp" value={adv} onChange={(e) => setAdv(e.target.value)}><option>1</option><option>2</option></select></Field></div>}
        {format === 'round_robin' && <label className="row"><input type="checkbox" checked={dbl} onChange={(e) => setDbl(e.target.checked)} /> Dubbelserie (hemma och borta)</label>}
        {error != null && <ErrorBox error={error} />}
        <div className="row"><button className="btn primary">Skapa</button><button type="button" className="btn" onClick={onClose}>Avbryt</button></div>
      </form>
    </Modal>
  );
}

export function TournamentView({ wid }: { wid: string }) {
  const { id } = useParams(); const nav = useNavigate(); const base = `/workspaces/${wid}/tournaments/${id}`;
  const { data: t, error, reload } = useLoad(() => api<any>('GET', base), [wid, id]);
  const [team, setTeam] = useState(''); const [err, setErr] = useState<unknown>(null); const [tie, setTie] = useState<any[] | null>(null);
  if (error != null) return <ErrorBox error={error} />;
  if (!t) return <div className="loading">Laddar…</div>;
  const name = (tid: string) => t.teams.find((x: any) => x.id === tid)?.name ?? '?';
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); reload(); } catch (x) { setErr(x); } };
  const gk = t.format === 'groups_knockout';
  const rounds: Record<number, any[]> = {}; for (const m of t.matches.filter((x: any) => (gk ? x.position !== null : true))) (rounds[m.round] ??= []).push(m);
  const editable = (m: any) => t.canManage && t.status === 'running' && !m.bye && !!m.homeTeamId && !!m.awayTeamId && !(gk && m.groupNo && t.phase === 'knockout');
  const save = (m: any) => (h: number | null, a: number | null) => act(() => api('PUT', `${base}/matches/${m.id}`, { homeScore: h, awayScore: a }));
  const startKo = async (order?: string[]) => { setErr(null); try { await api('POST', `${base}/knockout`, order ? { order } : {}); reload(); } catch (x: any) { if (x?.code === 'TIE_AT_CUTOFF') setTie(x.details?.groups ?? []); else setErr(x); } };
  return (
    <>
      <div className="row between"><div><Link to="/tournaments" className="small">← Turneringar</Link><h1>{t.name}</h1></div><span className={`badge ${t.status === 'running' ? 'good' : t.status === 'finished' ? '' : 'warn'}`}>{STATUS[t.status]}</span></div>
      {err != null && <ErrorBox error={err} />}
      {t.canManage && <label className="row small"><input type="checkbox" checked={!!t.isPublic} onChange={(e) => void act(() => api('PATCH', base, { isPublic: e.target.checked }))} /> Visa publikt (utan inloggning, bara lagnamn och resultat – kräver att föreningens publika sida är påslagen)</label>}
      {t.status === 'draft' && (
        <section className="card"><h2>Lag</h2>
          {t.teams.length === 0 ? <div className="muted small">Inga lag ännu. Minst två krävs.</div> : <ul className="timeline" aria-label="Lag">{t.teams.map((x: any) => <li key={x.id} className="row between"><span>{x.name}</span>{t.canManage && <button className="btn small danger" onClick={() => void act(() => api('DELETE', `${base}/teams/${x.id}`))}>Ta bort</button>}</li>)}</ul>}
          {t.canManage && <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('POST', `${base}/teams`, { name: team }); setTeam(''); }); }}>
            <input aria-label="Lagnamn" placeholder="Lagnamn" value={team} onChange={(e) => setTeam(e.target.value)} maxLength={100} required /><button className="btn">Lägg till lag</button></form>}
          {t.canManage && <div className="row"><button className="btn primary" disabled={t.teams.length < 2} onClick={() => void act(() => api('POST', `${base}/start`))}>Starta turneringen</button>
            <button className="btn danger" onClick={() => { if (confirm('Radera turneringen?')) void act(async () => { await api('DELETE', base); nav('/tournaments'); }); }}>Radera</button></div>}
        </section>)}
      {t.status !== 'draft' && <>
        {t.championTeamId && <Alert kind="good">Vinnare: <strong>{name(t.championTeamId)}</strong></Alert>}
        {t.format === 'round_robin' && <section className="card"><h2>Tabell</h2><Table rows={t.standings} name={name} />
          <div className="muted small">3 poäng för vinst, 1 för oavgjort. Sortering: poäng, målskillnad, gjorda mål, inbördes möte.</div></section>}
        {gk && t.groups.map((g: any) => <section className="card" key={g.groupNo}><h2>Grupp {String.fromCharCode(64 + g.groupNo)}</h2><Table rows={g.standings} name={name} advance={t.advancePerGroup} />
          <ul className="timeline">{t.matches.filter((m: any) => m.groupNo === g.groupNo).map((m: any) => <Match key={m.id} m={m} name={name} editable={editable(m)} onSave={save(m)} />)}</ul></section>)}
        {gk && t.phase === 'groups' && t.canManage && <section className="card"><button className="btn primary" disabled={t.matches.some((m: any) => m.groupNo && m.homeScore === null)} onClick={() => void startKo()}>Starta slutspelet</button>
          <div className="muted small">Kräver att alla gruppmatcher har resultat. {t.advancePerGroup} lag per grupp går vidare.</div></section>}
        {(!gk || t.phase === 'knockout') && <section className="card"><h2>{t.format === 'round_robin' ? 'Matcher' : 'Slutspel'}</h2>
          {Object.entries(rounds).map(([r, ms]) => <div key={r}><h3>{t.format === 'round_robin' ? `Omgång ${r}` : roundName(Number(r), t.totalRounds)}</h3><ul className="timeline">{ms.map((m: any) => <Match key={m.id} m={m} name={name} editable={editable(m)} onSave={save(m)} />)}</ul></div>)}
        </section>}
        {t.canManage && t.status === 'running' && (!gk || t.phase === 'knockout') && <button className="btn primary" onClick={() => void act(() => api('POST', `${base}/finish`))}>Avsluta turneringen</button>}
        {t.status === 'finished' && <Alert kind="info">Turneringen är avslutad och kan inte ändras.</Alert>}
      </>}
      {tie && <TieModal tie={tie} name={name} onClose={() => setTie(null)} onSubmit={(order) => { setTie(null); void startKo(order); }} />}
    </>
  );
}

function Table({ rows, name, advance }: { rows: any[]; name: (id: string) => string; advance?: number }) {
  return <table><thead><tr><th>#</th><th>Lag</th><th>S</th><th>V</th><th>O</th><th>F</th><th>Mål</th><th>+/−</th><th>P</th></tr></thead>
    <tbody>{rows.map((r: any, i: number) => <tr key={r.teamId} className={advance && i < advance ? 'advance' : undefined}><td>{r.rank}</td><td>{name(r.teamId)}</td><td>{r.played}</td><td>{r.won}</td><td>{r.drawn}</td><td>{r.lost}</td><td>{r.goalsFor}–{r.goalsAgainst}</td><td>{r.goalDiff}</td><td><strong>{r.points}</strong></td></tr>)}</tbody></table>;
}

function TieModal({ tie, name, onClose, onSubmit }: { tie: { groupNo: number; teamIds: string[] }[]; name: (id: string) => string; onClose: () => void; onSubmit: (order: string[]) => void }) {
  const [order, setOrder] = useState<string[]>([]); const all = tie.flatMap((g) => g.teamIds);
  const toggle = (id: string) => setOrder((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  return (
    <Modal title="Lika placering – avgör ordningen" onClose={onClose}>
      <p className="muted small">Lagen har exakt lika poäng, målskillnad, gjorda mål och inbördes möte. Klicka på lagen i den ordning de ska placeras (bästa först) i varje grupp.</p>
      {tie.map((g) => <div key={g.groupNo}><h3>Grupp {String.fromCharCode(64 + g.groupNo)}</h3><div className="row">{g.teamIds.map((id) => <button key={id} type="button" className={`btn small${order.includes(id) ? ' primary' : ''}`} onClick={() => toggle(id)}>{order.includes(id) ? `${order.indexOf(id) + 1}. ` : ''}{name(id)}</button>)}</div></div>)}
      <div className="row"><button className="btn primary" disabled={!all.every((id) => order.includes(id))} onClick={() => onSubmit(order)}>Starta slutspelet</button><button className="btn" onClick={onClose}>Avbryt</button></div>
    </Modal>
  );
}

function Match({ m, name, editable, onSave }: { m: any; name: (id: string) => string; editable: boolean; onSave: (h: number | null, a: number | null) => Promise<void> }) {
  const [h, setH] = useState(m.homeScore?.toString() ?? ''); const [a, setA] = useState(m.awayScore?.toString() ?? '');
  const played = m.homeScore !== null;
  return (
    <li className="row between" data-testid="match">
      <span>{m.homeTeamId ? name(m.homeTeamId) : 'Inväntar lag'} – {m.bye ? 'frilott' : m.awayTeamId ? name(m.awayTeamId) : 'Inväntar lag'}</span>
      {editable ? <form className="row" onSubmit={(e) => { e.preventDefault(); void onSave(num(h), num(a)); }}>
        <input type="number" min={0} max={999} aria-label={`Mål ${name(m.homeTeamId)}`} value={h} onChange={(e) => setH(e.target.value)} style={{ width: '4.5rem' }} />
        <input type="number" min={0} max={999} aria-label={`Mål ${name(m.awayTeamId)}`} value={a} onChange={(e) => setA(e.target.value)} style={{ width: '4.5rem' }} />
        <button className="btn small">Spara</button></form>
        : <strong>{m.bye ? 'går vidare' : played ? `${m.homeScore} – ${m.awayScore}` : 'ej spelad'}</strong>}
    </li>
  );
}
