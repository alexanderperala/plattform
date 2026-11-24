import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { Alert, ErrorBox, Field, Modal } from './ui';
import { KIND, PinballBoard } from './PinballBoard';

const STATUS: Record<string, string> = { draft: 'Utkast', running: 'Pågår', finished: 'Avslutad' };
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export function PinballManage({ wid, t, reload }: { wid: string; t: any; reload: () => void }) {
  const base = `/workspaces/${wid}/tournaments/${t.id}/pinball`; const [err, setErr] = useState<unknown>(null); const [game, setGame] = useState<{ g: any; x: any } | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); reload(); return true; } catch (x) { setErr(x); return false; } };
  useEffect(() => { if (t.status !== 'running') return; const i = setInterval(() => { if (!game) reload(); }, 15000); return () => clearInterval(i); }, [t.status, game, reload]);
  const draft = t.status === 'draft'; const name = (id: string) => t.players.find((p: any) => p.id === id)?.name ?? '?';
  const allDone = t.stages.length > 0 && t.stages.every((s: any) => s.status === 'finished');
  const move = (i: number, d: number) => { const o = t.players.map((p: any) => p.id); const [x] = o.splice(i, 1); o.splice(i + d, 0, x); void act(() => api('PUT', `${base}/players/order`, { order: o })); };
  return (
    <>
      <div className="row between"><div><Link to="/tournaments" className="small">← Turneringar</Link><h1>{t.name}</h1><div className="muted small">Flipper · {t.players.length} spelare · {t.machines.length} maskiner</div></div>
        <div className="row noprint"><span className={`badge ${t.status === 'running' ? 'good' : t.status === 'finished' ? '' : 'warn'}`}>{STATUS[t.status]}</span><button className="btn" onClick={() => window.print()}>Skriv ut spelplan</button></div></div>
      {t.canManage && <label className="row small noprint"><input type="checkbox" checked={!!t.isPublic} onChange={(e) => void act(() => api('PATCH', `/workspaces/${wid}/tournaments/${t.id}`, { isPublic: e.target.checked }))} /> Visa publikt (utan inloggning: spelarnamn, spelplan och resultat – kräver att föreningens publika sida är påslagen)</label>}
      {err != null && <ErrorBox error={err} />}
      {t.stages.length > 0 && <section className="card"><h2>Spelplan</h2><PinballBoard t={t} onGame={t.canManage && t.status !== 'finished' ? (g, x) => setGame({ g, x }) : undefined} /></section>}
      {t.canManage && <div className="noprint">
        <div className="grid2">
          <PlayersCard t={t} draft={draft} act={act} base={base} move={move} />
          <MachinesCard t={t} act={act} base={base} />
        </div>
        <StagesCard t={t} act={act} base={base} name={name} />
        {allDone && t.status !== 'finished' && <section className="card"><button className="btn primary" onClick={() => void act(() => api('POST', `${base}/finish`, {}))}>Avsluta turneringen</button></section>}
      </div>}
      {game && <GameModal t={t} base={base} game={game} onClose={() => setGame(null)} onDone={() => { setGame(null); reload(); }} />}
    </>
  );
}

function PlayersCard({ t, draft, act, base, move }: any) {
  const [text, setText] = useState('');
  return (
    <section className="card"><h2>Spelare</h2>
      {t.players.length === 0 ? <div className="muted small">Inga spelare ännu.</div> : <ol className="timeline" aria-label="Spelare">{t.players.map((p: any, i: number) => (
        <li key={p.id} className="row between"><span style={p.withdrawn ? { textDecoration: 'line-through' } : undefined}>{p.name}</span>
          <span className="row">{draft ? <><button className="btn small" aria-label={`Flytta upp ${p.name}`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button><button className="btn small" aria-label={`Flytta ner ${p.name}`} disabled={i === t.players.length - 1} onClick={() => move(i, 1)}>↓</button><button className="btn small danger" onClick={() => void act(() => api('DELETE', `${base}/players/${p.id}`))}>Ta bort</button></>
            : <button className="btn small" onClick={() => void act(() => api('PATCH', `${base}/players/${p.id}`, { withdrawn: !p.withdrawn }))}>{p.withdrawn ? 'Åter in' : 'Utgången'}</button>}</span></li>))}</ol>}
      {t.status !== 'finished' && <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('POST', `${base}/players`, { names: lines(text) }); setText(''); }); }}>
        <Field label={draft ? 'Lägg till spelare' : 'Sen anmälan'} hint={draft ? 'Ett namn per rad. Ordningen är seedningen (nummer 1 = bäst).' : 'Går bara i första steget (kval, matchplay eller Swiss). Spelaren går med från nästa omgång.'}><textarea aria-label="Spelare att lägga till" rows={4} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <button className="btn primary" disabled={lines(text).length === 0}>Lägg till</button></form>}
    </section>
  );
}

function MachinesCard({ t, act, base }: any) {
  const [text, setText] = useState('');
  return (
    <section className="card"><h2>Maskiner</h2>
      {t.machines.length === 0 ? <div className="muted small">Inga maskiner ännu.</div> : <ul className="timeline" aria-label="Maskiner">{t.machines.map((m: any) => (
        <li key={m.id} className="row between"><span className={m.active ? '' : 'muted'}>{m.name}</span>
          <span className="row"><button className="btn small" onClick={() => void act(() => api('PATCH', `${base}/machines/${m.id}`, { active: !m.active }))}>{m.active ? 'Ta ur bruk' : 'Sätt i bruk'}</button><button className="btn small danger" onClick={() => void act(() => api('DELETE', `${base}/machines/${m.id}`))}>Ta bort</button></span></li>))}</ul>}
      <form onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('POST', `${base}/machines`, { names: lines(text) }); setText(''); }); }}>
        <Field label="Lägg till maskiner" hint="Ett namn per rad."><textarea aria-label="Maskiner att lägga till" rows={3} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <button className="btn primary" disabled={lines(text).length === 0}>Lägg till</button></form>
    </section>
  );
}

const DEFAULTS: Record<string, any> = { best_game: { mode: 'best' }, matchplay: { rounds: 3, groupSize: 4, points: '7-5-3-1', grouping: 'random' }, swiss: { rounds: 4, groupSize: 2, points: '7-5-3-1' }, round_robin: { doubleRound: false, points: '7-5-3-1' }, single_elim: { bestOf: 1, bronzeMatch: false }, group_knockout: { groupSize: 4, advancePerGroup: 2, gamesPerGroup: 3, points: '7-5-3-1' }, double_elim: { bestOf: 1, grandFinalReset: true } };
function StagesCard({ t, act, base, name }: any) {
  const [kind, setKind] = useState('matchplay'); const [cfg, setCfg] = useState<any>(DEFAULTS.matchplay); const [adv, setAdv] = useState(''); const [att, setAtt] = useState('');
  const set = (k: string, v: any) => setCfg((c: any) => ({ ...c, [k]: v })); const n = (v: string) => Number(v);
  const pick = (k: string) => { setKind(k); setCfg(DEFAULTS[k]); };
  const add = () => act(() => api('POST', `${base}/stages`, { kind, config: { ...cfg, ...(adv ? { advance: Number(adv) } : {}), ...(kind === 'best_game' && att ? { maxAttempts: Number(att) } : {}) } }));
  return (
    <section className="card"><h2>Steg</h2>
      <p className="muted small">Bygg turneringen av steg som spelas i ordning, till exempel kval → matchplay → slutspel. Varje steg tar de bästa från föregående steg.</p>
      {t.stages.length > 0 && <ol className="timeline" aria-label="Steg">{t.stages.map((s: any) => (
        <li key={s.id}><div className="row between"><span><strong>{s.no}. {s.name}</strong> <span className="muted small">({KIND[s.kind]}{s.config.rounds ? ` · ${s.config.rounds} omgångar` : ''}{s.kind === 'group_knockout' ? ` · grupper om ${s.config.groupSize}, ${s.config.advancePerGroup} vidare, ${s.config.gamesPerGroup} spel` : ''}{s.config.bronzeMatch ? ' · bronsmatch' : ''}{s.config.bestOf > 1 ? ` · bäst av ${s.config.bestOf}` : ''}{s.config.advance ? ` · topp ${s.config.advance} vidare` : ''})</span> <span className={`badge ${s.status === 'running' ? 'good' : s.status === 'finished' ? '' : 'warn'}`}>{{ pending: 'Väntar', running: 'Pågår', finished: 'Klart' }[s.status as string]}</span></span>
          <span className="row">
            {s.status === 'pending' && <><button className="btn small primary" onClick={() => void act(() => api('POST', `${base}/stages/${s.id}/start`, {}))}>Starta</button><button className="btn small danger" onClick={() => void act(() => api('DELETE', `${base}/stages/${s.id}`))}>Ta bort</button></>}
            {s.status === 'running' && ((s.kind === 'matchplay' || s.kind === 'swiss') && s.currentRound < s.config.rounds || s.kind === 'group_knockout' && s.groups.length > 0 && s.groups.filter((g: any) => g.round === s.currentRound).length > 1) && <button className="btn small primary" onClick={() => void act(() => api('POST', `${base}/stages/${s.id}/next-round`, {}))}>Skapa omgång {s.currentRound + 1}</button>}
            {s.status === 'running' && <button className="btn small" onClick={() => void act(() => api('POST', `${base}/stages/${s.id}/finish`, {}))}>Avsluta steget</button>}</span></div>
          {s.status === 'running' && s.kind === 'best_game' && <AttemptForm t={t} s={s} act={act} base={base} />}</li>))}</ol>}
      <form onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <div className="row">
          <Field label="Typ av steg"><select aria-label="Typ av steg" value={kind} onChange={(e) => pick(e.target.value)}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          {(kind === 'matchplay' || kind === 'swiss') && <Field label="Omgångar"><input aria-label="Omgångar" type="number" min={1} max={12} value={cfg.rounds} onChange={(e) => set('rounds', n(e.target.value))} /></Field>}
          {kind === 'matchplay' && <Field label="Spelare per bord"><select aria-label="Spelare per bord" value={cfg.groupSize} onChange={(e) => set('groupSize', n(e.target.value))}><option value={3}>3</option><option value={4}>4</option></select></Field>}
          {kind === 'swiss' && <Field label="Spelare per bord"><select aria-label="Spelare per bord" value={cfg.groupSize} onChange={(e) => set('groupSize', n(e.target.value))}><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option></select></Field>}
          {kind === 'group_knockout' && <><Field label="Spelare per grupp"><select aria-label="Spelare per grupp" value={cfg.groupSize} onChange={(e) => set('groupSize', n(e.target.value))}><option value={3}>3</option><option value={4}>4</option></select></Field><Field label="Vidare per grupp"><select aria-label="Vidare per grupp" value={cfg.advancePerGroup} onChange={(e) => set('advancePerGroup', n(e.target.value))}><option value={1}>1</option><option value={2}>2</option></select></Field><Field label="Spel per grupp"><select aria-label="Spel per grupp" value={cfg.gamesPerGroup} onChange={(e) => set('gamesPerGroup', n(e.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></Field></>}
          {(kind === 'matchplay' || kind === 'swiss' || kind === 'round_robin' || kind === 'group_knockout') && <Field label="Poäng per placering"><select aria-label="Poäng per placering" value={cfg.points} onChange={(e) => set('points', e.target.value)}><option value="7-5-3-1">7-5-3-1</option><option value="4-2-1-0">4-2-1-0</option></select></Field>}
          {kind === 'matchplay' && <Field label="Indelning"><select aria-label="Indelning" value={cfg.grouping} onChange={(e) => set('grouping', e.target.value)}><option value="random">Slump (undviker omatch)</option><option value="balanced">Jämnt (efter ställning)</option></select></Field>}
          {(kind === 'single_elim' || kind === 'double_elim') && <Field label="Spel per match"><select aria-label="Spel per match" value={cfg.bestOf} onChange={(e) => set('bestOf', n(e.target.value))}><option value={1}>1 spel</option><option value={3}>Bäst av 3</option><option value={5}>Bäst av 5</option></select></Field>}
          {kind === 'best_game' && <><Field label="Räknas som"><select aria-label="Räknas som" value={cfg.mode} onChange={(e) => set('mode', e.target.value)}><option value="best">Bästa enskilda poäng</option><option value="sum_of_best_per_machine">Summa av bästa per maskin</option></select></Field><Field label="Max försök/spelare"><input aria-label="Max försök" type="number" min={1} max={100} value={att} onChange={(e) => setAtt(e.target.value)} placeholder="obegränsat" /></Field></>}
          {kind === 'round_robin' && <label className="row"><input type="checkbox" checked={cfg.doubleRound} onChange={(e) => set('doubleRound', e.target.checked)} /> Dubbelserie</label>}
          {kind === 'single_elim' && <label className="row"><input type="checkbox" checked={cfg.bronzeMatch} onChange={(e) => set('bronzeMatch', e.target.checked)} /> Bronsmatch</label>}
          {kind === 'double_elim' && <label className="row"><input type="checkbox" checked={cfg.grandFinalReset} onChange={(e) => set('grandFinalReset', e.target.checked)} /> Grand final-omspel</label>}
          <Field label="Antal vidare"><input aria-label="Antal vidare" type="number" min={1} value={adv} onChange={(e) => setAdv(e.target.value)} placeholder="alla" /></Field>
        </div>
        <button className="btn primary">Lägg till steg</button>
      </form>
      {t.stages.length === 0 && <Alert kind="info">Tips: lägg till spelare och maskiner, skapa ett steg och tryck Starta.</Alert>}
    </section>
  );
}

function AttemptForm({ t, s, act, base }: any) {
  const [pid, setPid] = useState(''); const [mid, setMid] = useState(''); const [score, setScore] = useState('');
  const ok = pid && mid && score !== '' && Number.isInteger(Number(score));
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('POST', `${base}/stages/${s.id}/attempts`, { playerId: pid, machineId: mid, score: Number(score) }); setScore(''); }); }}>
      <select aria-label="Spelare" value={pid} onChange={(e) => setPid(e.target.value)}><option value="">Spelare…</option>{s.playerIds.map((id: string) => <option key={id} value={id}>{t.players.find((p: any) => p.id === id)?.name}</option>)}</select>
      <select aria-label="Maskin" value={mid} onChange={(e) => setMid(e.target.value)}><option value="">Maskin…</option>{t.machines.filter((m: any) => m.active).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
      <input aria-label="Poäng" type="number" min={0} value={score} onChange={(e) => setScore(e.target.value)} placeholder="Poäng" />
      <button className="btn small primary" disabled={!ok}>Registrera försök</button>
    </form>
  );
}

function GameModal({ t, base, game, onClose, onDone }: { t: any; base: string; game: { g: any; x: any }; onClose: () => void; onDone: () => void }) {
  const { g, x } = game; const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(g.playerIds.map((p: string) => [p, String(x.scores.find((s: any) => s.playerId === p)?.score ?? '')])));
  const [machine, setMachine] = useState<string>(x.machineId ?? ''); const [err, setErr] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); onDone(); } catch (e) { setErr(e); } };
  const name = (id: string) => t.players.find((p: any) => p.id === id)?.name ?? '?'; const complete = g.playerIds.every((p: string) => vals[p] !== '' && Number.isInteger(Number(vals[p])));
  const setMachineNow = (m: string) => { setMachine(m); void run(() => api('PATCH', `${base}/games/${x.id}`, { machineId: m || null })); };
  return (
    <Modal title={`${g.label}${g.games.length > 1 ? ` · spel ${x.gameNo}` : ''}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run(() => api('PUT', `${base}/games/${x.id}/scores`, { scores: g.playerIds.map((p: string) => ({ playerId: p, score: Number(vals[p]) })) })); }}>
        {x.status !== 'done' && <Field label="Maskin"><select aria-label="Maskin för spelet" value={machine} onChange={(e) => setMachineNow(e.target.value)}><option value="">Ej vald</option>{t.machines.filter((m: any) => m.active).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>}
        {g.playerIds.map((p: string) => <Field key={p} label={name(p)}><input aria-label={`Poäng ${name(p)}`} type="number" min={0} inputMode="numeric" value={vals[p]} onChange={(e) => setVals({ ...vals, [p]: e.target.value })} /></Field>)}
        {err != null && <ErrorBox error={err} />}
        <div className="row"><button className="btn primary" disabled={!complete}>Spara resultat</button>
          {x.status !== 'done' && <button type="button" className="btn" onClick={() => void run(() => api('PATCH', `${base}/games/${x.id}`, { status: x.status === 'playing' ? 'pending' : 'playing' }))}>{x.status === 'playing' ? 'Pausa (ej igång)' : 'Starta spel'}</button>}
          {x.status === 'done' && <button type="button" className="btn danger" onClick={() => void run(() => api('DELETE', `${base}/games/${x.id}/scores`))}>Rensa resultat</button>}
          <button type="button" className="btn" onClick={onClose}>Stäng</button></div>
      </form>
    </Modal>
  );
}
