import { useState } from 'react';

// Spelplan/matris som alla utgår från: rader = omgångar/matchsteg, kolumner = maskiner. Samma komponent används live (med redigering)
// och i den publika vyn (skrivskyddad, onGame utelämnas). Texten renderas alltid som text.
export const KIND: Record<string, string> = { best_game: 'Kval (försök)', matchplay: 'Matchplay', swiss: 'Swiss', round_robin: 'Serie', single_elim: 'Utslagning', double_elim: 'Dubbel utslagning' };
const STAGE_STATUS: Record<string, string> = { pending: 'Väntar', running: 'Pågår', finished: 'Klart' };
const fmtScore = (n: number) => new Intl.NumberFormat('sv-SE').format(n);

export function PinballBoard({ t, onGame }: { t: any; onGame?: (group: any, game: any) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const stage = t.stages.find((s: any) => s.id === (sel ?? t.activeStageId)) ?? t.stages[0];
  const name = (id: string) => t.players.find((p: any) => p.id === id)?.name ?? '?';
  const mname = (id: string | null) => t.machines.find((m: any) => m.id === id)?.name ?? null;
  if (!stage) return <div className="muted">Inga steg ännu.</div>;
  const live = t.stages.flatMap((s: any) => s.groups.flatMap((g: any) => g.games.filter((x: any) => x.status === 'playing').map((x: any) => ({ g, x }))));
  return (
    <div className="pboard">
      {t.stages.length > 1 && <div className="row" role="tablist" aria-label="Steg">{t.stages.map((s: any) => <button key={s.id} role="tab" aria-selected={s.id === stage.id} className={`btn small${s.id === stage.id ? ' primary' : ''}`} onClick={() => setSel(s.id)}>{s.no}. {s.name} <span className="muted">· {STAGE_STATUS[s.status]}</span></button>)}</div>}
      <div className="pmachines" aria-label="Maskiner just nu">
        {t.machines.map((m: any) => { const cur = live.find((l: any) => l.x.machineId === m.id); return (
          <div key={m.id} className={`pmachine ${!m.active ? 'off' : cur ? 'busy' : 'free'}`}><strong>{m.name}</strong><span className="small">{!m.active ? 'Ur bruk' : cur ? cur.g.playerIds.map(name).join(' · ') : 'Ledig'}</span></div>); })}
      </div>
      {stage.kind === 'best_game' ? <Qualifying stage={stage} name={name} mname={mname} /> : <Matrix stage={stage} t={t} name={name} onGame={onGame} />}
      <Standings stage={stage} name={name} />
    </div>
  );
}

function Matrix({ stage, t, name, onGame }: { stage: any; t: any; name: (id: string) => string; onGame?: (g: any, game: any) => void }) {
  if (stage.status === 'pending') return <div className="muted">Steget har inte startat. Spelplanen visas när det startar.</div>;
  const visible = stage.groups.filter((g: any) => !['bye', 'skipped'].includes(g.status) && (g.playerIds.length > 0 || g.status === 'pending'));
  const rows = [...new Map(visible.map((g: any) => [`${g.round}|${g.rowLabel}`, { round: g.round, label: g.rowLabel }])).values()].sort((a: any, b: any) => a.round - b.round);
  const cols: Array<{ id: string | null; label: string }> = [...t.machines.map((m: any) => ({ id: m.id, label: m.name })), { id: null, label: 'Ej tilldelad / väntar' }];
  const cards = (round: number, colId: string | null) => visible.filter((g: any) => g.round === round).flatMap((g: any) => {
    if (g.status === 'pending') return colId === null ? [{ g, game: null as any }] : [];
    const decided = g.winnerId !== null;
    return g.games.filter((x: any) => (x.machineId ?? null) === colId && !(decided && x.status === 'pending')).map((x: any) => ({ g, game: x }));
  });
  if (rows.length === 0) return <div className="muted">Inga matcher ännu.</div>;
  return (
    <div className="table-wrap"><table className="pmatrix" aria-label="Spelplan">
      <thead><tr><th>Omgång</th>{cols.map((c) => <th key={c.id ?? 'x'}>{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r: any) => <tr key={`${r.round}|${r.label}`}><th scope="row">{r.label}</th>{cols.map((c) => (
        <td key={c.id ?? 'x'}>{cards(r.round, c.id).map(({ g, game }: any) => <Cell key={game?.id ?? g.id} g={g} game={game} name={name} onGame={onGame} nGames={g.games.length} />)}</td>))}</tr>)}</tbody>
    </table></div>
  );
}

function Cell({ g, game, name, onGame, nGames }: { g: any; game: any; name: (id: string) => string; onGame?: (g: any, game: any) => void; nGames: number }) {
  const status = !game ? 'wait' : game.status === 'done' ? 'done' : game.status === 'playing' ? 'playing' : 'ready';
  const score = (pid: string) => game?.scores.find((s: any) => s.playerId === pid);
  const body = (<>
    <div className="small muted">{g.label}{nGames > 1 && game ? ` · spel ${game.gameNo}` : ''}</div>
    {g.playerIds.length === 0 ? <div className="small muted">Väntar på tidigare match</div> : (game?.status === 'done' ? [...g.playerIds].sort((a: string, b: string) => (score(a)?.placement ?? 9) - (score(b)?.placement ?? 9)) : g.playerIds).map((pid: string) => (
      <div className="prow" key={pid}><span>{name(pid)}</span><strong>{score(pid) ? `${fmtScore(score(pid).score)}${score(pid).points ? ` · ${score(pid).points}p` : ''}` : ''}</strong></div>))}
  </>);
  const clickable = onGame && game && g.playerIds.length > 0;
  return clickable ? <button className={`pcell ${status}`} onClick={() => onGame(g, game)}>{body}</button> : <div className={`pcell ${status}`}>{body}</div>;
}

function Standings({ stage, name }: { stage: any; name: (id: string) => string }) {
  const rows: Array<{ rank: number; playerId: string; cols: Array<string | number> }> | null =
    stage.standings ? stage.standings.map((r: any) => ({ rank: r.rank, playerId: r.playerId, cols: [r.games, r.points, r.firsts] })) :
    stage.placements ? stage.placements.map((r: any) => ({ rank: r.rank, playerId: r.playerId, cols: [] })) : null;
  if (stage.kind === 'best_game') return null;
  if (!rows || rows.length === 0) return null;
  const heads = stage.standings ? ['Spel', 'Poäng', 'Segrar'] : [];
  return (
    <section><h3>{stage.standings ? 'Ställning' : 'Slutplacering'}</h3><div className="table-wrap"><table className="table" aria-label="Ställning"><thead><tr><th>#</th><th>Spelare</th>{heads.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.playerId}><td>{r.rank}</td><td>{name(r.playerId)}</td>{r.cols.map((c, i) => <td key={i}>{i === 1 ? <strong>{c}</strong> : c}</td>)}</tr>)}</tbody></table></div></section>
  );
}

function Qualifying({ stage, name, mname }: { stage: any; name: (id: string) => string; mname: (id: string | null) => string | null }) {
  return (
    <section><h3>Kvalresultat</h3>
      <div className="table-wrap"><table className="table" aria-label="Kvalresultat"><thead><tr><th>#</th><th>Spelare</th><th>{stage.config.mode === 'best' ? 'Bästa poäng' : 'Summa bästa per maskin'}</th><th>Försök</th></tr></thead>
        <tbody>{stage.ranking.map((r: any) => <tr key={r.playerId} className={stage.config.advance && r.rank <= stage.config.advance ? 'advances' : ''}><td>{r.rank}</td><td>{name(r.playerId)}</td><td><strong>{fmtScore(r.best)}</strong></td><td>{r.attempts}{stage.config.maxAttempts ? ` / ${stage.config.maxAttempts}` : ''}</td></tr>)}</tbody></table></div>
      {stage.config.advance && <div className="muted small">Topp {stage.config.advance} går vidare till nästa steg.</div>}
      {stage.attempts.length > 0 && <details><summary className="small">Senaste försök</summary><ul className="timeline">{stage.attempts.slice(0, 20).map((a: any) => <li key={a.id} className="small">{name(a.playerId)} · {mname(a.machineId)} · <strong>{fmtScore(a.score)}</strong></li>)}</ul></details>}
    </section>
  );
}
