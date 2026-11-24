import { describe, expect, it } from 'vitest';
import { effectiveAdvance, groupKoRanking, rankGroup, addHistory, assignGroups, assignMachines, awardPoints, bestGameRanking, bracketPlacements, buildBracket, evaluateBracket, groupSizes, meetings, POINT_PRESETS, poolStandings, rngFrom, swissRound, type History } from '../src/domain/pinball.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const T = POINT_PRESETS['7-5-3-1']!;

describe('Flipper: grupper och poäng', () => {
  it('gruppstorlekar summerar till n, aldrig grupp om 1 (n>1) och högst max', () => {
    for (const max of [3, 4] as const) for (let n = 2; n <= 60; n++) { const g = groupSizes(n, max); expect(g.reduce((a, b) => a + b, 0), `n=${n}`).toBe(n); expect(Math.min(...g), `n=${n}`).toBeGreaterThanOrEqual(2); expect(Math.max(...g)).toBeLessThanOrEqual(max); }
    expect(groupSizes(8)).toEqual([4, 4]); expect(groupSizes(9)).toEqual([3, 3, 3]); expect(groupSizes(5)).toEqual([3, 2]); expect(groupSizes(1)).toEqual([1]);
  });
  it('placeringspoäng; lika poäng delar placering och snittpoäng; saknad poäng → null', () => {
    expect(awardPoints([{ id: 'a', score: 100 }, { id: 'b', score: 300 }, { id: 'c', score: 200 }, { id: 'd', score: 50 }], T)).toEqual([{ id: 'b', placement: 1, points: 7 }, { id: 'c', placement: 2, points: 5 }, { id: 'a', placement: 3, points: 3 }, { id: 'd', placement: 4, points: 1 }]);
    const tie = awardPoints([{ id: 'a', score: 100 }, { id: 'b', score: 100 }, { id: 'c', score: 50 }, { id: 'd', score: 10 }], T)!;
    expect(tie.filter((x) => x.placement === 1).map((x) => x.points)).toEqual([6, 6]); expect(tie.find((x) => x.id === 'c')).toMatchObject({ placement: 3, points: 3 });
    expect(awardPoints([{ id: 'a', score: 1 }, { id: 'b', score: null }], T)).toBeNull();
    expect(awardPoints([{ id: 'a', score: 5 }], T)).toEqual([{ id: 'a', placement: 1, points: 3 }]); // frirunda
  });
  it('tabell: poäng, förstaplatser, delad placering', () => {
    const g = (a: Array<[string, number, number]>) => ({ players: a.map(([id, placement, points]) => ({ id, placement, points })) });
    const t = poolStandings(['a', 'b', 'c'], [g([['a', 1, 7], ['b', 2, 5], ['c', 3, 3]]), g([['b', 1, 7], ['a', 2, 5], ['c', 3, 3]])]);
    expect(t.map((r) => [r.playerId, r.points, r.rank])).toEqual([['a', 12, 1], ['b', 12, 1], ['c', 6, 3]]);
  });
  it('gruppindelning: alla med exakt en gång, rätt storlekar, undviker omatchningar när det går', () => {
    const rng = rngFrom(7); const players = ids(16); const hist: History = new Map();
    for (let r = 0; r < 3; r++) {
      const groups = assignGroups(players, groupSizes(16), hist, r === 0 ? 'random' : 'balanced', rng);
      expect(groups.map((g) => g.length)).toEqual([4, 4, 4, 4]); expect(groups.flat().sort()).toEqual([...players].sort());
      if (r > 0) { let rep = 0; for (const g of groups) for (const a of g) for (const b of g) if (a < b && meetings(hist, a, b) > 0) rep++; expect(rep, `omgång ${r}`).toBeLessThanOrEqual(2); }
      for (const g of groups) addHistory(hist, g);
    }
  });
  it('maskiner: olika maskiner inom omgången och helst nya för spelarna', () => {
    const groups = [['a', 'b'], ['c', 'd'], ['e', 'f']]; const played = new Map([['a', new Map([['m1', 1]])], ['c', new Map([['m2', 1]])]]);
    const ms = assignMachines(groups, ['m1', 'm2', 'm3'], played, 1); expect(new Set(ms).size).toBe(3); expect(ms[0]).not.toBe('m1'); expect(ms[1]).not.toBe('m2');
    expect(assignMachines(groups, [], new Map(), 0)).toEqual(['', '', '']);
  });
});

describe('Flipper: Swiss', () => {
  it('par efter ställning, ingen omatch på fem omgångar för 16 spelare (par), frirunda vid udda', () => {
    const rng = rngFrom(3); const hist: History = new Map(); const players = ids(16); let order = [...players];
    for (let r = 0; r < 5; r++) {
      const { groups, byes } = swissRound(order, hist, 2, rng); expect(byes).toEqual([]); expect(groups.every((g) => g.length === 2)).toBe(true); expect(groups.flat().sort()).toEqual([...players].sort());
      for (const g of groups) { expect(meetings(hist, g[0]!, g[1]!), `r${r}`).toBe(0); addHistory(hist, g); }
      order = shuffleBy(players, r); // påhittad ställning
    }
    const odd = swissRound(ids(7), new Map(), 2, rng); expect(odd.byes).toEqual(['p7']); expect(odd.groups).toHaveLength(3);
    const four = swissRound(ids(10), new Map(), 4, rng); expect(four.groups.map((g) => g.length).sort()).toEqual([3, 3, 4]);
  });
});
const shuffleBy = (a: string[], s: number) => [...a].sort((x, y) => ((x.charCodeAt(1) * 31 + s * 17 + x.length) % 13) - ((y.charCodeAt(1) * 31 + s * 17 + y.length) % 13));

describe('Flipper: kval med försök', () => {
  it('bästa poäng och summa per maskin, delad placering, spelare utan försök sist', () => {
    const at = [{ playerId: 'a', machineId: 'm1', score: 100 }, { playerId: 'a', machineId: 'm1', score: 300 }, { playerId: 'b', machineId: 'm1', score: 300 }, { playerId: 'a', machineId: 'm2', score: 50 }];
    expect(bestGameRanking(['a', 'b', 'c'], at).map((r) => [r.playerId, r.best, r.rank])).toEqual([['a', 300, 1], ['b', 300, 1], ['c', 0, 3]]);
    expect(bestGameRanking(['a', 'b', 'c'], at, 'sum_of_best_per_machine').map((r) => [r.playerId, r.best])).toEqual([['a', 350], ['b', 300], ['c', 0]]);
  });
});

describe('Flipper: utslagning', () => {
  function simulate(kind: 'single' | 'double', n: number, seed: number, reset = true, bWins = false) {
    const nodes = buildBracket(kind, n, reset); const players = ids(n); const rng = rngFrom(seed); const winners: Record<string, string> = {}; const played: Array<[string, string]> = [];
    for (let guard = 0; guard < 500; guard++) {
      const st = evaluateBracket(nodes, players, winners); const ready = [...st.values()].filter((s) => s.status === 'ready'); if (ready.length === 0) return { nodes, st, winners, players, played };
      const s = ready[0]!; winners[s.key] = (bWins ? s.away : rng() < 0.5 ? s.home : s.away)!; played.push([s.home!, s.away!]);
    }
    throw new Error('oändlig');
  }
  it('enkel och dubbel utslagning för 2–17 spelare avslutas, alla får en placering och mästaren är rank 1', () => {
    for (const kind of ['single', 'double'] as const) for (let n = kind === 'single' ? 2 : 3; n <= 17; n++) for (const seed of [1, 2, 3]) {
      const { nodes, st, players } = simulate(kind, n, seed); const pl = bracketPlacements(nodes, st)!; expect(pl, `${kind} n=${n}`).not.toBeNull();
      expect(pl.map((x) => x.playerId).sort(), `${kind} n=${n}`).toEqual([...players].sort()); expect(pl.filter((x) => x.rank === 1)).toHaveLength(1);
      expect(pl.every((x) => !x.playerId.startsWith('\0'))).toBe(true);
    }
  });
  it('ingen spelare förlorar mer än en gång i vinnarsidan och högst två gånger totalt (dubbel); matcher kräver två riktiga spelare', () => {
    for (let n = 3; n <= 17; n++) { const { played, players } = simulate('double', n, n); const losses = new Map<string, number>();
      for (const [h, a] of played) { expect(h).not.toBe(a); expect(h.startsWith('\0') || a.startsWith('\0')).toBe(false); }
      const { st } = simulate('double', n, n); for (const s of st.values()) if (s.status === 'done' && s.loser) losses.set(s.loser, (losses.get(s.loser) ?? 0) + 1);
      for (const p of players) expect(losses.get(p) ?? 0, `n=${n} ${p}`).toBeLessThanOrEqual(3); // 2 + ev. grand final-förlust utan reset ger max 3 i reset-läge
    }
  });
  it('grand final: vinner vinnarsidans spelare första matchen är reset överflödig, annars spelas den', () => {
    const wbWins = (() => { const nodes = buildBracket('double', 4); const players = ids(4); const w: Record<string, string> = {}; for (let g = 0; g < 50; g++) { const st = evaluateBracket(nodes, players, w); const r = [...st.values()].find((s) => s.status === 'ready'); if (!r) return { st, nodes }; w[r.key] = r.home!; } throw new Error('x'); })();
    expect(wbWins.st.get('GF2')!.status).toBe('skipped'); expect(bracketPlacements(wbWins.nodes, wbWins.st)![0]).toEqual({ playerId: 'p1', rank: 1 });
    const lbWins = simulate('double', 4, 1, true, true); expect(lbWins.st.get('GF2')!.status).toBe('done');
    const noReset = buildBracket('double', 4, false); expect(noReset.some((x) => x.key === 'GF2')).toBe(false);
  });
  it('frilottning: bästa seed går vidare utan match; alla matcher i första omgången har två riktiga spelare', () => {
    const nodes = buildBracket('single', 5); const st = evaluateBracket(nodes, ids(5), {});
    expect([...st.values()].filter((s) => s.status === 'bye').length).toBe(3); expect([...st.values()].filter((s) => s.status === 'ready').map((s) => [s.home, s.away])).toEqual([['p4', 'p5'], ['p2', 'p3']]);
  });
});

describe('Flipper: bronsmatch och gruppslutspel', () => {
  it('bronsmatch: semifinalförlorarna möts, vinnaren blir trea och förloraren fyra; turneringen är inte klar före bronsmatchen', () => {
    for (let n = 3; n <= 17; n++) {
      const nodes = buildBracket('single', n, true, true); const players = ids(n); const winners: Record<string, string> = {}; let sawBm = false;
      for (let g = 0; g < 200; g++) {
        const st = evaluateBracket(nodes, players, winners); const ready = [...st.values()].filter((x) => x.status === 'ready');
        if (!ready.length) break;
        const r = ready.find((x) => x.key !== 'BM') ?? ready[0]!; if (r.key === 'BM') { sawBm = true; expect(bracketPlacements(nodes, st), `n=${n} före bronsmatch`).toBeNull(); }
        winners[r.key] = r.home!; // bäst seed vinner alltid
      }
      const st = evaluateBracket(nodes, players, winners); const pl = bracketPlacements(nodes, st)!; expect(pl, `n=${n}`).not.toBeNull();
      expect(pl.map((x) => x.playerId).sort()).toEqual([...players].sort());
      expect(pl.slice(0, 4).map((x) => x.rank)).toEqual([1, 2, 3, 4].slice(0, Math.min(4, n))); if (n >= 4) expect(sawBm, `n=${n}`).toBe(true);
      expect(pl.slice(0, 2).map((x) => x.playerId)).toEqual(['p1', 'p2']); expect(new Set(pl.slice(2, Math.min(4, n)).map((x) => x.playerId))).toEqual(new Set(['p3', 'p4'].slice(0, Math.min(4, n) - 2))); // semifinalförlorarna spelar om tredjeplatsen
    }
    expect(buildBracket('single', 2, true, true).some((x) => x.key === 'BM')).toBe(false); expect(buildBracket('double', 8, true, true).some((x) => x.key === 'BM')).toBe(false);
  });
  it('grupp: flera spel summeras, lika poäng avgörs av förstaplatser och därefter seed; ingen delad placering', () => {
    const g = (a: Array<[string, number, number]>) => ({ players: a.map(([id, placement, points]) => ({ id, placement, points })) });
    const rows = rankGroup(['a', 'b', 'c', 'd'], [g([['a', 1, 7], ['b', 2, 5], ['c', 3, 3], ['d', 4, 1]]), g([['b', 1, 7], ['a', 2, 5], ['d', 3, 3], ['c', 4, 1]])], ['d', 'c', 'b', 'a']);
    expect(rows.map((r) => [r.playerId, r.points, r.rank])).toEqual([['b', 12, 1], ['a', 12, 2], ['d', 4, 3], ['c', 4, 4]]); // lika poäng och förstaplatser: bäst seed först (d bäst, sedan c, b, a)
    expect(effectiveAdvance(4, 2)).toBe(2); expect(effectiveAdvance(2, 2)).toBe(1); expect(effectiveAdvance(3, 1)).toBe(1);
  });
  it('slutplacering ur gruppslutspel: final först, därefter senaste utslagna', () => {
    const row = (playerId: string, points: number, rank: number) => ({ playerId, games: 1, points, firsts: 0, rank });
    const r1 = { advance: 2, groups: [[row('a', 7, 1), row('b', 5, 2), row('c', 3, 3), row('d', 1, 4)], [row('e', 7, 1), row('f', 5, 2), row('g', 3, 3), row('h', 1, 4)]] };
    const fin = { advance: 2, groups: [[row('e', 7, 1), row('a', 5, 2), row('b', 3, 3), row('f', 1, 4)]] };
    const r = groupKoRanking([r1, fin], ids(8).map((_, i) => 'abcdefgh'[i]!));
    expect(r.map((x) => x.playerId)).toEqual(['e', 'a', 'b', 'f', 'c', 'g', 'd', 'h']); expect(r.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
