// Flipperturneringar: ren logik utan I/O. Spelare (inte lag), grupper om 2–4 spelare, placeringspoäng, Swiss, serie,
// enkel/dubbel utslagning och kval med försök (best game). Slumpen är seedad så att allt går att reproducera och testa.
import { seedOrder } from './tournament.js';

export type PointsTable = Record<2 | 3 | 4, number[]>;
export const POINT_PRESETS: Record<string, PointsTable> = {
  '7-5-3-1': { 4: [7, 5, 3, 1], 3: [5, 3, 1], 2: [3, 1] },
  '4-2-1-0': { 4: [4, 2, 1, 0], 3: [2, 1, 0], 2: [1, 0] },
};

export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffle<T>(arr: T[], rng: () => number): T[] { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; }

/** Delar n spelare i grupper om högst `max` (3 eller 4), aldrig grupp om 1 (utom n=1). Så många fyrgrupper som möjligt. */
export function groupSizes(n: number, max: 3 | 4 = 4): number[] {
  if (n < 1) return []; if (n === 1) return [1];
  const rep = (k: number, v: number) => Array.from({ length: Math.max(0, k) }, () => v);
  if (max === 4) {
    if (n < 4) return [n]; if (n === 5) return [3, 2];
    const r = n % 4;
    if (r === 0) return rep(n / 4, 4);
    if (r === 1) return [...rep((n - 9) / 4, 4), 3, 3, 3];
    if (r === 2) return [...rep((n - 6) / 4, 4), 3, 3];
    return [...rep((n - 3) / 4, 4), 3];
  }
  if (n < 3) return [n];
  const r = n % 3;
  if (r === 0) return rep(n / 3, 3);
  if (r === 1) return [...rep((n - 4) / 3, 3), 2, 2];
  return [...rep((n - 2) / 3, 3), 2];
}

export interface Scored { id: string; score: number | null }
/** Placeringar och poäng ur spelade poäng. Lika poäng delar placering och får snittet av de platsernas poäng. Saknas poäng för någon returneras null. */
export function awardPoints(scores: Scored[], table: PointsTable): Array<{ id: string; placement: number; points: number }> | null {
  if (scores.length === 0 || scores.some((s) => s.score === null)) return null;
  const size = scores.length === 1 ? 2 : (Math.min(4, Math.max(2, scores.length)) as 2 | 3 | 4);
  const pts = table[size]; if (!pts || pts.length < Math.min(size, scores.length)) return null;
  const sorted = [...scores].sort((a, b) => (b.score as number) - (a.score as number));
  const out: Array<{ id: string; placement: number; points: number }> = [];
  for (let i = 0; i < sorted.length;) {
    let j = i; while (j < sorted.length && sorted[j]!.score === sorted[i]!.score) j++;
    const slice = pts.slice(i, j); const avg = scores.length === 1 ? pts[0]! : slice.reduce((a, b) => a + b, 0) / (j - i);
    for (let k = i; k < j; k++) out.push({ id: sorted[k]!.id, placement: i + 1, points: avg });
    i = j;
  }
  return out;
}

export type History = Map<string, Map<string, number>>; // spelare → motståndare → antal möten
export const meetings = (h: History, a: string, b: string) => h.get(a)?.get(b) ?? 0;
export function addHistory(h: History, ids: string[]): void { for (const a of ids) for (const b of ids) if (a !== b) { const m = h.get(a) ?? new Map<string, number>(); m.set(b, (m.get(b) ?? 0) + 1); h.set(a, m); } }

export type Grouping = 'random' | 'balanced' | 'standing';
/** Fördelar spelare (given ordning = styrka/ställning) i grupper. standing: närliggande tillsammans (Swiss). balanced: ormfördelning. random: slump. Därefter byten som minimerar omatchningar. */
export function assignGroups(order: string[], sizes: number[], history: History, mode: Grouping, rng: () => number): string[][] {
  const base = mode === 'random' ? shuffle(order, rng) : order;
  const groups: string[][] = sizes.map(() => []);
  if (mode === 'balanced') {
    let i = 0; let dir = 1; let g = 0;
    while (i < base.length) { if (groups[g]!.length < sizes[g]!) { groups[g]!.push(base[i++]!); } if (dir === 1) { if (g === groups.length - 1) dir = -1; else g++; } else if (g === 0) dir = 1; else g--; if (groups.every((x, k) => x.length >= sizes[k]!)) break; }
    // fyll ev. luckor (vid ojämna storlekar)
    for (const p of base) if (!groups.some((x) => x.includes(p))) groups.find((x, k) => x.length < sizes[k]!)!.push(p);
  } else { let k = 0; for (let g = 0; g < sizes.length; g++) { groups[g] = base.slice(k, k + sizes[g]!); k += sizes[g]!; } }
  const target = new Map<string, number>(); groups.forEach((g, gi) => g.forEach((p) => target.set(p, gi)));
  const cost = (gs: string[][]) => { let c = 0; gs.forEach((g, gi) => { for (let a = 0; a < g.length; a++) { for (let b = a + 1; b < g.length; b++) c += meetings(history, g[a]!, g[b]!) * 1000; if (mode === 'standing') c += Math.abs(gi - target.get(g[a]!)!); } }); return c; };
  let best = cost(groups);
  for (let iter = 0; iter < 4000 && best >= 1000; iter++) {
    const g1 = Math.floor(rng() * groups.length); const g2 = Math.floor(rng() * groups.length); if (g1 === g2) continue;
    const i1 = Math.floor(rng() * groups[g1]!.length); const i2 = Math.floor(rng() * groups[g2]!.length);
    const a = groups[g1]![i1]!; const b = groups[g2]![i2]!; groups[g1]![i1] = b; groups[g2]![i2] = a;
    const c = cost(groups); if (c < best) best = c; else { groups[g1]![i1] = a; groups[g2]![i2] = b; }
  }
  return groups;
}

/** Väljer maskin per grupp: helst en som ingen i gruppen spelat på, och olika maskiner inom omgången så långt det går. */
export function assignMachines(groups: string[][], machines: string[], played: Map<string, Map<string, number>>, round: number): string[] {
  if (machines.length === 0) return groups.map(() => '');
  const used = new Map<string, number>(); const out: string[] = [];
  groups.forEach((g, gi) => {
    let bestM = machines[(gi + round) % machines.length]!; let bestC = Infinity;
    machines.forEach((m, mi) => {
      const c = (used.get(m) ?? 0) * 100 + g.reduce((s, p) => s + (played.get(p)?.get(m) ?? 0), 0) * 10 + ((mi + machines.length - ((gi + round) % machines.length)) % machines.length) * 0.01;
      if (c < bestC) { bestC = c; bestM = m; }
    });
    used.set(bestM, (used.get(bestM) ?? 0) + 1); out.push(bestM);
  });
  return out;
}

export interface GameForStanding { players: Array<{ id: string; placement: number; points: number }> }
export interface StandingRow { playerId: string; games: number; points: number; firsts: number; rank: number }
/** Poäng, därefter flest förstaplatser; helt lika ger delad placering. */
export function poolStandings(playerIds: string[], games: GameForStanding[]): StandingRow[] {
  const rows = new Map<string, StandingRow>(playerIds.map((id) => [id, { playerId: id, games: 0, points: 0, firsts: 0, rank: 0 }]));
  for (const g of games) for (const p of g.players) { const r = rows.get(p.id); if (!r) continue; r.games++; r.points += p.points; if (p.placement === 1) r.firsts++; }
  const list = [...rows.values()].sort((a, b) => b.points - a.points || b.firsts - a.firsts || playerIds.indexOf(a.playerId) - playerIds.indexOf(b.playerId));
  list.forEach((r, i) => { const prev = list[i - 1]; r.rank = prev && prev.points === r.points && prev.firsts === r.firsts ? prev.rank : i + 1; });
  return list;
}

/** Nästa Swiss-omgång: ställningsordning → grupper om högst `max`, så få omatchningar som möjligt. */
export function swissRound(standingOrder: string[], history: History, max: 2 | 3 | 4, rng: () => number): { groups: string[][]; byes: string[] } {
  const ids = [...standingOrder]; const byes: string[] = [];
  if (max === 2 && ids.length % 2 === 1) { // frirunda till den lägst placerade som inte haft det
    const cand = [...ids].reverse().find((p) => !(history.get(p)?.get('\0bye'))) ?? ids[ids.length - 1]!; ids.splice(ids.indexOf(cand), 1); byes.push(cand);
  }
  const sizes = max === 2 ? Array.from({ length: ids.length / 2 }, () => 2) : groupSizes(ids.length, max);
  return { groups: assignGroups(ids, sizes, history, 'standing', rng), byes };
}

/** Kval med försök: bästa poäng per spelare (eller summa av bästa per maskin). Högst först, delad placering vid lika. */
export interface Attempt { playerId: string; machineId: string; score: number }
export interface BestRow { playerId: string; best: number; attempts: number; rank: number }
export function bestGameRanking(playerIds: string[], attempts: Attempt[], mode: 'best' | 'sum_of_best_per_machine' = 'best'): BestRow[] {
  const rows = playerIds.map((id) => {
    const mine = attempts.filter((a) => a.playerId === id);
    let best = 0;
    if (mode === 'best') best = mine.reduce((m, a) => Math.max(m, a.score), 0);
    else { const per = new Map<string, number>(); for (const a of mine) per.set(a.machineId, Math.max(per.get(a.machineId) ?? 0, a.score)); best = [...per.values()].reduce((s, x) => s + x, 0); }
    return { playerId: id, best, attempts: mine.length, rank: 0 };
  }).sort((a, b) => b.best - a.best || playerIds.indexOf(a.playerId) - playerIds.indexOf(b.playerId));
  rows.forEach((r, i) => { const p = rows[i - 1]; r.rank = p && p.best === r.best ? p.rank : i + 1; });
  return rows;
}

// ---------- Utslagning (enkel och dubbel) som generell grafmodell ----------
export type Src = { seed: number } | { win: string } | { lose: string };
export interface BNode { key: string; bracket: 'W' | 'L' | 'GF' | 'B'; round: number; pos: number; home: Src; away: Src }
const log2 = (n: number) => Math.round(Math.log2(n));
export const bracketSize = (n: number) => { let p = 2; while (p < n) p *= 2; return p; };

export function buildBracket(kind: 'single' | 'double', n: number, grandFinalReset = true, bronze = false): BNode[] {
  if (n < 2) return [];
  const P = bracketSize(n); const k = log2(P); const nodes: BNode[] = []; const order = seedOrder(P);
  const W = (r: number, i: number) => `W${r}-${i}`; const L = (r: number, i: number) => `L${r}-${i}`;
  for (let r = 1; r <= k; r++) for (let i = 0; i < P / 2 ** r; i++) nodes.push({ key: W(r, i), bracket: 'W', round: r, pos: i, home: r === 1 ? { seed: order[2 * i]! } : { win: W(r - 1, 2 * i) }, away: r === 1 ? { seed: order[2 * i + 1]! } : { win: W(r - 1, 2 * i + 1) } });
  if (kind === 'single') { if (bronze && k >= 2) nodes.push({ key: 'BM', bracket: 'B', round: k, pos: 0, home: { lose: W(k - 1, 0) }, away: { lose: W(k - 1, 1) } }); return nodes; }
  if (P === 2) return nodes; // två spelare: bara en match
  const lbRounds = 2 * (k - 1); const count = (j: number) => P / 2 ** (Math.floor((j + 1) / 2) + 1);
  for (let j = 1; j <= lbRounds; j++) for (let i = 0; i < count(j); i++) {
    if (j === 1) nodes.push({ key: L(1, i), bracket: 'L', round: 1, pos: i, home: { lose: W(1, 2 * i) }, away: { lose: W(1, 2 * i + 1) } });
    else if (j % 2 === 0) { const r = j / 2 + 1; const m = P / 2 ** r; nodes.push({ key: L(j, i), bracket: 'L', round: j, pos: i, home: { win: L(j - 1, i) }, away: { lose: W(r, r % 2 === 0 ? m - 1 - i : i) } }); }
    else nodes.push({ key: L(j, i), bracket: 'L', round: j, pos: i, home: { win: L(j - 1, 2 * i) }, away: { win: L(j - 1, 2 * i + 1) } });
  }
  nodes.push({ key: 'GF1', bracket: 'GF', round: 1, pos: 0, home: { win: W(k, 0) }, away: { win: L(lbRounds, 0) } });
  if (grandFinalReset) nodes.push({ key: 'GF2', bracket: 'GF', round: 2, pos: 0, home: { win: 'GF1' }, away: { lose: 'GF1' } });
  return nodes;
}

export const BYE = '\0bye';
export interface NodeState { key: string; home: string | null; away: string | null; winner: string | null; loser: string | null; status: 'pending' | 'ready' | 'done' | 'bye' | 'skipped' }
/** Räknar ut vilka som möts och vem som vidare, ur spelarordning (seed 1 först) och avgjorda matcher (nyckel → vinnare). Frilottning ger automatisk vidarekomst. */
export function evaluateBracket(nodes: BNode[], seedPlayers: string[], winners: Record<string, string>): Map<string, NodeState> {
  const byKey = new Map(nodes.map((x) => [x.key, x])); const memo = new Map<string, NodeState>();
  const side = (s: Src): string | null => {
    if ('seed' in s) return seedPlayers[s.seed - 1] ?? BYE;
    const st = node('win' in s ? s.win : s.lose); return 'win' in s ? st.winner : st.loser;
  };
  function node(key: string): NodeState {
    const m = memo.get(key); if (m) return m;
    const n = byKey.get(key)!; const home = side(n.home); const away = side(n.away);
    const st: NodeState = { key, home, away, winner: null, loser: null, status: 'pending' }; memo.set(key, st);
    if (key === 'GF2') {
      const g1 = node('GF1');
      if (g1.winner && g1.winner === g1.home) { st.status = 'skipped'; st.winner = g1.winner; st.loser = g1.loser; st.home = g1.home; st.away = g1.away; return st; }
    }
    if (home === BYE && away === BYE) { st.winner = BYE; st.loser = BYE; st.status = 'bye'; }
    else if (home === BYE && away) { st.winner = away; st.loser = BYE; st.status = 'bye'; }
    else if (away === BYE && home) { st.winner = home; st.loser = BYE; st.status = 'bye'; }
    else if (home && away) {
      const w = winners[key];
      if (w === home || w === away) { st.winner = w; st.loser = w === home ? away : home; st.status = 'done'; } else st.status = 'ready';
    }
    return st;
  }
  for (const n of nodes) node(n.key);
  return memo;
}

/** Slutplacering ur utslagning: mästare först, därefter efter när man åkte ut (senare = bättre); lika utgång delar placering. */
export function bracketPlacements(nodes: BNode[], state: Map<string, NodeState>): Array<{ playerId: string; rank: number }> | null {
  const gf = nodes.filter((x) => x.bracket === 'GF'); const double = gf.length > 0;
  const final = double ? (state.get('GF2')?.status === 'done' || state.get('GF2')?.status === 'skipped' ? state.get('GF2')! : state.get('GF1')!) : state.get(`W${Math.max(...nodes.map((x) => x.round))}-0`)!;
  if (!final.winner || final.winner === BYE || final.status === 'pending' || final.status === 'ready') return null;
  const bm = state.get('BM'); if (bm && (bm.status === 'pending' || bm.status === 'ready')) return null; // bronsmatchen måste vara avgjord
  const exit = new Map<string, number>(); const bump = (p: string | null, v: number) => { if (p && p !== BYE) exit.set(p, Math.max(exit.get(p) ?? 0, v)); };
  for (const n of nodes) { const s = state.get(n.key)!; if (s.status === 'bye' || s.status === 'skipped') continue; if (n.bracket === 'W') bump(s.loser, double ? 0 : n.round); else if (n.bracket === 'L') bump(s.loser, n.round); else if (n.bracket === 'B') { bump(s.loser, n.round - 1 + 0.25); bump(s.winner, n.round - 1 + 0.5); } else bump(s.loser, 1000 + n.round); }
  bump(final.winner, 10_000);
  const ids = [...exit.keys()].sort((a, b) => exit.get(b)! - exit.get(a)!);
  const out: Array<{ playerId: string; rank: number }> = []; ids.forEach((id, i) => { const p = out[i - 1]; out.push({ playerId: id, rank: p && exit.get(ids[i - 1]!) === exit.get(id) ? p.rank : i + 1 }); });
  return out;
}

// ---------- Gruppslutspel (fyra spelare, de två bästa går vidare) ----------
/** Placering i en grupp över ett eller flera spel: poäng, flest förstaplatser, därefter bäst seed. Alltid unik ordning (rank 1..n). */
export function rankGroup(playerIds: string[], games: GameForStanding[], seedOrder: string[]): StandingRow[] {
  const rows = poolStandings(playerIds, games).sort((a, b) => b.points - a.points || b.firsts - a.firsts || seedOrder.indexOf(a.playerId) - seedOrder.indexOf(b.playerId));
  rows.forEach((r, i) => { r.rank = i + 1; }); return rows;
}
/** Hur många som går vidare ur en grupp: aldrig alla, så att varje omgång minskar fältet. */
export const effectiveAdvance = (groupSize: number, advance: number) => Math.max(1, Math.min(advance, groupSize - 1));
/** Slutplacering: sista gruppen (final) först; därefter de som åkte ut senast. Inom samma omgång avgör poäng, förstaplatser, seed. */
export function groupKoRanking(rounds: Array<{ groups: StandingRow[][]; advance: number }>, seedOrder: string[]): Array<{ playerId: string; rank: number }> {
  if (rounds.length === 0) return [];
  const out: string[] = rounds[rounds.length - 1]!.groups.flatMap((g) => g.map((r) => r.playerId));
  for (let i = rounds.length - 2; i >= 0; i--) {
    const eliminated = rounds[i]!.groups.flatMap((g) => g.slice(effectiveAdvance(g.length, rounds[i]!.advance)));
    eliminated.sort((a, b) => b.points - a.points || b.firsts - a.firsts || seedOrder.indexOf(a.playerId) - seedOrder.indexOf(b.playerId));
    out.push(...eliminated.map((r) => r.playerId));
  }
  return out.map((playerId, i) => ({ playerId, rank: i + 1 }));
}
