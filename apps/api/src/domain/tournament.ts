// Turneringslogik utan I/O: serie (alla möter alla) och tabell.
export interface Fixture { round: number; home: string; away: string }

/** Cirkelmetoden. Udda antal lag ger ett "frilag" per omgång (matchen utelämnas). Dubbelserie ger returmatcher med byte av hemmalag. */
export function roundRobin(teamIds: string[], doubleRound = false): Fixture[] {
  const ids = [...teamIds];
  if (ids.length < 2) return [];
  if (ids.length % 2 === 1) ids.push('\0bye');
  const n = ids.length; const rounds = n - 1; const out: Fixture[] = [];
  let arr = ids;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i]!; const b = arr[n - 1 - i]!;
      if (a === '\0bye' || b === '\0bye') continue;
      // Växla hemma/borta för första bordet varje omgång så att inget lag alltid spelar hemma
      out.push(i === 0 && r % 2 === 1 ? { round: r + 1, home: b, away: a } : { round: r + 1, home: a, away: b });
    }
    arr = [arr[0]!, arr[n - 1]!, ...arr.slice(1, n - 1)];
  }
  if (doubleRound) out.push(...out.slice().map((f) => ({ round: f.round + rounds, home: f.away, away: f.home })));
  return out;
}

export interface Played { home: string; away: string; homeScore: number; awayScore: number }
export interface Row { teamId: string; played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number; goalDiff: number; points: number; rank: number }

/** 3 poäng för vinst, 1 för oavgjort. Sortering: poäng, målskillnad, gjorda mål, inbördes möte (poäng) – annars delad placering. */
export function standings(teamIds: string[], matches: Played[]): Row[] {
  const rows = new Map<string, Row>(teamIds.map((t) => [t, { teamId: t, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0, rank: 0 }]));
  for (const m of matches) {
    const h = rows.get(m.home); const a = rows.get(m.away);
    if (!h || !a) continue;
    h.played++; a.played++; h.goalsFor += m.homeScore; h.goalsAgainst += m.awayScore; a.goalsFor += m.awayScore; a.goalsAgainst += m.homeScore;
    if (m.homeScore > m.awayScore) { h.won++; a.lost++; h.points += 3; } else if (m.homeScore < m.awayScore) { a.won++; h.lost++; a.points += 3; } else { h.drawn++; a.drawn++; h.points++; a.points++; }
  }
  for (const r of rows.values()) r.goalDiff = r.goalsFor - r.goalsAgainst;
  const h2h = (x: string, y: string) => { // inbördes poäng x mot y
    let p = 0;
    for (const m of matches) {
      if (m.home === x && m.away === y) p += m.homeScore > m.awayScore ? 3 : m.homeScore === m.awayScore ? 1 : 0;
      if (m.home === y && m.away === x) p += m.awayScore > m.homeScore ? 3 : m.homeScore === m.awayScore ? 1 : 0;
    }
    return p;
  };
  const list = [...rows.values()].sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goalsFor - a.goalsFor || h2h(b.teamId, a.teamId) - h2h(a.teamId, b.teamId) || a.teamId.localeCompare(b.teamId));
  const same = (a: Row, b: Row) => a.points === b.points && a.goalDiff === b.goalDiff && a.goalsFor === b.goalsFor && h2h(a.teamId, b.teamId) === h2h(b.teamId, a.teamId);
  list.forEach((r, i) => { r.rank = i > 0 && same(list[i - 1]!, r) ? list[i - 1]!.rank : i + 1; });
  return list;
}

// ---- Utslagning (single elimination) ----
export interface KoMatch { round: number; position: number; home: string | null; away: string | null }

/** Standardseedning: ettan och tvåan möts först i finalen. Returnerar seed-ordning för första omgången (1-baserat). */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) { const n = order.length * 2; order = order.flatMap((s) => [s, n + 1 - s]); }
  return order;
}

/** Bygger hela bracketen. Lagen seedas i given ordning; saknade platser blir frilotter (bye: away = null) för de högst seedade. */
export function knockout(teamIds: string[]): KoMatch[] {
  const n = teamIds.length;
  if (n < 2) return [];
  let size = 2; while (size < n) size *= 2;
  const order = seedOrder(size); const out: KoMatch[] = [];
  for (let i = 0; i < size / 2; i++) {
    const a = order[2 * i]!; const b = order[2 * i + 1]!;
    out.push({ round: 1, position: i, home: teamIds[a - 1] ?? null, away: teamIds[b - 1] ?? null });
  }
  for (let r = 2, cnt = size / 4; cnt >= 1; r++, cnt /= 2) for (let i = 0; i < cnt; i++) out.push({ round: r, position: i, home: null, away: null });
  return out;
}

/** Nästa match och plats (home/away) som vinnaren flyttas till; null för finalen. */
export function nextSlot(round: number, position: number, totalRounds: number): { round: number; position: number; slot: 'home' | 'away' } | null {
  return round >= totalRounds ? null : { round: round + 1, position: Math.floor(position / 2), slot: position % 2 === 0 ? 'home' : 'away' };
}
export const roundName = (round: number, totalRounds: number): string => {
  const left = totalRounds - round;
  return left === 0 ? 'Final' : left === 1 ? 'Semifinal' : left === 2 ? 'Kvartsfinal' : left === 3 ? 'Åttondelsfinal' : `Omgång ${round}`;
};

// ---- Gruppspel + slutspel ----
/** Snake-fördelning i seedordning (1:an till A, 2:an till B … sedan tillbaka), så att grupperna blir jämnstarka. */
export function snakeGroups(teamIds: string[], groups: number): string[][] {
  const out: string[][] = Array.from({ length: groups }, () => []);
  teamIds.forEach((id, i) => { const row = Math.floor(i / groups); const col = i % groups; out[row % 2 === 0 ? col : groups - 1 - col]!.push(id); });
  return out;
}

/**
 * Seedning till slutspelet från rankade grupper. Gruppsegrare först (A, B, C …); grupptvåor placeras så att
 * 1A möter tvåan från grupp B, 1C tvåan från D osv. – lag från samma grupp möts alltså inte i första slutspelsomgången.
 * Kräver jämnt antal grupper (2, 4, 8) om två går vidare.
 */
export function qualifierSeeds(ranked: string[][], advance: 1 | 2): string[] {
  const g = ranked.length; const S = g * advance; const seeds: string[] = new Array(S);
  for (let i = 0; i < g; i++) seeds[i] = ranked[i]![0]!;
  if (advance === 2) for (let i = 0; i < g; i++) seeds[S - 1 - i] = ranked[i ^ 1]![1]!;
  return seeds;
}
