import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { auditRows, custCall, makeApp, registerCustomer, resetDb, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

type M = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const reg = () => registerCustomer(app, { products: ['association_portal', 'tournament_system'] });
const tcall = (c: TestCustomer, id: string, method: M, extra = '', payload?: unknown, who = c) => custCall(app, { method, url: `/workspaces/${c.workspaceId}/tournaments/${id}/pinball${extra}`, cookie: who.cookie, payload });
async function setup(c: TestCustomer, nPlayers: number, nMachines: number, name = 'Flipper-SM') {
  if (nMachines === 0) { const t0 = (await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/tournaments`, cookie: c.cookie, payload: { name, format: 'pinball' } })).json(); await tcall(c, t0.id, 'POST', '/players', { names: Array.from({ length: nPlayers }, (_, i) => `Spelare ${i + 1}`) }); return t0.id as string; }
  const t = (await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/tournaments`, cookie: c.cookie, payload: { name, format: 'pinball' } })).json();
  expect((await tcall(c, t.id, 'POST', '/players', { names: Array.from({ length: nPlayers }, (_, i) => `Spelare ${String(i + 1).padStart(2, '0')}`) })).statusCode).toBe(201);
  expect((await tcall(c, t.id, 'POST', '/machines', { names: Array.from({ length: nMachines }, (_, i) => `Maskin ${i + 1}`) })).statusCode).toBe(201);
  return t.id as string;
}
const view = async (c: TestCustomer, id: string) => (await tcall(c, id, 'GET')).json();
const addStage = async (c: TestCustomer, id: string, body: unknown) => { const r = await tcall(c, id, 'POST', '/stages', body); expect(r.statusCode, r.body).toBe(201); return r.json().id as string; };
const start = (c: TestCustomer, id: string, sid: string) => tcall(c, id, 'POST', `/stages/${sid}/start`, {});
const stageOf = async (c: TestCustomer, id: string, sid: string) => (await view(c, id)).stages.find((s: any) => s.id === sid);
/** Spelar alla spelbara matcher: lägre spelarnummer vinner (deterministiskt). */
async function playReady(c: TestCustomer, id: string, sid: string, rank = (pid: string, names: Map<string, string>) => 1000 - Number(names.get(pid)!.slice(-2))) {
  for (let guard = 0; guard < 400; guard++) {
    const v = await view(c, id); const names = new Map<string, string>(v.players.map((p: any) => [p.id, p.name])); const st = v.stages.find((s: any) => s.id === sid);
    const g = st.groups.find((x: any) => ['ready', 'playing'].includes(x.status)); if (!g) return;
    const game = g.games.find((x: any) => x.status !== 'done'); expect(game, JSON.stringify(g)).toBeTruthy();
    const r = await tcall(c, id, 'PUT', `/games/${game.id}/scores`, { scores: g.playerIds.map((pid: string) => ({ playerId: pid, score: rank(pid, names) })) }); expect(r.statusCode, r.body).toBe(200);
  }
  throw new Error('loop');
}

describe('Flipper: matchplay', () => {
  it('grupper om fyra, olika maskiner, placeringspoäng, omgång för omgång, låsning och slutlig ranking', async () => {
    const c = await reg(); const id = await setup(c, 8, 4);
    const sid = await addStage(c, id, { kind: 'matchplay', config: { rounds: 3, groupSize: 4, points: '7-5-3-1' } });
    expect((await start(c, id, sid)).statusCode).toBe(200);
    let st = await stageOf(c, id, sid); expect(st.groups).toHaveLength(2); expect(st.groups.every((g: any) => g.playerIds.length === 4)).toBe(true);
    expect(new Set(st.groups.map((g: any) => g.games[0].machineId)).size).toBe(2); expect(st.groups.map((g: any) => g.rowLabel)).toEqual(['Omgång 1', 'Omgång 1']);
    expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).json().error.code).toBe('ROUND_NOT_DONE');
    // felaktiga resultat avvisas
    const g0 = st.groups[0]; const game0 = g0.games[0];
    expect((await tcall(c, id, 'PUT', `/games/${game0.id}/scores`, { scores: g0.playerIds.slice(0, 3).map((p: string) => ({ playerId: p, score: 1 })) })).json().error.code).toBe('SCORES_MISMATCH');
    await playReady(c, id, sid);
    st = await stageOf(c, id, sid); const top = st.groups[0].games[0].scores; expect(top.map((x: any) => x.points)).toEqual([7, 5, 3, 1]);
    for (const r of [2, 3]) { expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).statusCode).toBe(200); await playReady(c, id, sid); st = await stageOf(c, id, sid); expect(st.currentRound).toBe(r); }
    expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).json().error.code).toBe('LAST_ROUND');
    // runda 1 är låst eftersom senare omgångar finns; sista omgången kan rättas
    expect((await tcall(c, id, 'PUT', `/games/${game0.id}/scores`, { scores: g0.playerIds.map((p: string) => ({ playerId: p, score: 5 })) })).json().error.code).toBe('RESULT_LOCKED');
    const last = st.groups.find((g: any) => g.round === 3); expect((await tcall(c, id, 'DELETE', `/games/${last.games[0].id}/scores`)).statusCode).toBe(200);
    expect((await tcall(c, id, 'POST', `/stages/${sid}/finish`, {})).json().error.code).toBe('MATCHES_OPEN');
    await playReady(c, id, sid); const fin = await tcall(c, id, 'POST', `/stages/${sid}/finish`, {}); expect(fin.statusCode).toBe(200);
    const ranking = fin.json().ranking; expect(ranking).toHaveLength(8); expect(ranking[0].rank).toBe(1);
    // ingen mötte samma motståndare mer än nödvändigt: 3 omgångar à 4 av 8 spelare ger högst ett omöte per par
    const all = (await stageOf(c, id, sid)).groups; const pairs = new Map<string, number>(); for (const g of all) for (const a of g.playerIds) for (const b of g.playerIds) if (a < b) pairs.set(a + b, (pairs.get(a + b) ?? 0) + 1);
    expect(Math.max(...pairs.values())).toBeLessThanOrEqual(2);
    expect((await tcall(c, id, 'POST', '/finish', {})).statusCode).toBe(200);
    expect((await view(c, id)).status).toBe('finished');
    expect((await tcall(c, id, 'POST', '/players', { names: ['Sen'] })).json().error.code).toBe('TOURNAMENT_FINISHED');
  });
});

describe('Flipper: Swiss och serie', () => {
  it('Swiss med udda antal ger frirunda med poäng och ingen omatch', async () => {
    const c = await reg(); const id = await setup(c, 7, 3); const sid = await addStage(c, id, { kind: 'swiss', config: { rounds: 3, groupSize: 2 } });
    await start(c, id, sid); const seen = new Set<string>(); const byeRecv: string[] = [];
    for (let r = 1; r <= 3; r++) {
      if (r > 1) expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).statusCode).toBe(200);
      const st = await stageOf(c, id, sid); const round = st.groups.filter((g: any) => g.round === r);
      expect(round.filter((g: any) => g.playerIds.length === 2)).toHaveLength(3); const bye = round.find((g: any) => g.playerIds.length === 1); expect(bye.status).toBe('done'); byeRecv.push(bye.playerIds[0]);
      for (const g of round.filter((x: any) => x.playerIds.length === 2)) { const k = [...g.playerIds].sort().join(); expect(seen.has(k), `omatch r${r}`).toBe(false); seen.add(k); }
      await playReady(c, id, sid);
    }
    expect(new Set(byeRecv).size).toBe(3); // ingen får frirunda två gånger
    const fin = await tcall(c, id, 'POST', `/stages/${sid}/finish`, {}); expect(fin.statusCode).toBe(200);
  });
  it('serie: alla möter alla på maskiner, klar när allt spelats', async () => {
    const c = await reg(); const id = await setup(c, 5, 2); const sid = await addStage(c, id, { kind: 'round_robin', config: { doubleRound: false } });
    await start(c, id, sid); const st = await stageOf(c, id, sid); expect(st.groups).toHaveLength(10); expect(st.totalRounds).toBe(5);
    await playReady(c, id, sid); expect((await tcall(c, id, 'POST', `/stages/${sid}/finish`, {})).statusCode).toBe(200);
    const fin = await stageOf(c, id, sid); expect(fin.standings[0].playerId).toBe((await view(c, id)).players[0].id); expect(fin.standings[0].points).toBe(12); // 4 vinster à 3 poäng
  });
});

describe('Flipper: kval → utslagning', () => {
  it('försök, maxantal, topp N går vidare i rankingordning, dubbel utslagning avgörs och ger placeringar', async () => {
    const c = await reg(); const id = await setup(c, 10, 3);
    const q = await addStage(c, id, { kind: 'best_game', config: { mode: 'best', maxAttempts: 2, advance: 5 } });
    const de = await addStage(c, id, { kind: 'double_elim', config: { bestOf: 3, grandFinalReset: true } });
    expect((await start(c, id, de)).json().error.code).toBe('PREVIOUS_STAGE_OPEN');
    expect((await start(c, id, q)).statusCode).toBe(200); const v = await view(c, id); const [m1, m2] = v.machines.map((m: any) => m.id); const pl = v.players.map((p: any) => p.id);
    const att = (p: string, m: string, s: number) => tcall(c, id, 'POST', `/stages/${q}/attempts`, { playerId: p, machineId: m, score: s });
    // spelare i omvänd ordning: p10 bäst
    for (const [i, p] of pl.entries()) expect((await att(p, m1, (i + 1) * 1000)).statusCode).toBe(201);
    expect((await att(pl[0], m2, 999_999)).statusCode).toBe(201); expect((await att(pl[0], m2, 5)).json().error.code).toBe('ATTEMPTS_EXHAUSTED');
    const st = await stageOf(c, id, q); expect(st.ranking[0]).toMatchObject({ playerId: pl[0], best: 999_999, rank: 1 }); expect(st.ranking[1].playerId).toBe(pl[9]);
    expect((await tcall(c, id, 'POST', `/stages/${q}/finish`, {})).statusCode).toBe(200);
    expect((await start(c, id, de)).statusCode).toBe(200);
    const d = await stageOf(c, id, de); expect(d.playerIds).toEqual([pl[0], pl[9], pl[8], pl[7], pl[6]]); // topp 5 i rankingordning = seedning
    await playReady(c, id, de);
    const fin = await tcall(c, id, 'POST', `/stages/${de}/finish`, {}); expect(fin.statusCode, fin.body).toBe(200);
    const r = fin.json().ranking; expect(r).toHaveLength(5); expect(r[0]).toEqual({ playerId: d.playerIds[0], rank: 1 }); // bäst seed vinner (lägre nummer vinner)… spelare 01 = pl[0]
    expect(new Set(r.map((x: any) => x.playerId))).toEqual(new Set(d.playerIds));
  });
  it('utslagning: oavgjort förbjudet, bästa-av-tre kräver två vunna, korrigering låses av nästa match, spelare utan match kan inte få resultat', async () => {
    const c = await reg(); const id = await setup(c, 4, 2); const sid = await addStage(c, id, { kind: 'single_elim', config: { bestOf: 3 } }); await start(c, id, sid);
    let st = await stageOf(c, id, sid); const semi = st.groups.filter((g: any) => g.status === 'ready'); expect(semi).toHaveLength(2); expect(semi[0].games).toHaveLength(3);
    const g = semi[0]; const [a, b] = g.playerIds; const put = (gameId: string, sa: number, sb: number) => tcall(c, id, 'PUT', `/games/${gameId}/scores`, { scores: [{ playerId: a, score: sa }, { playerId: b, score: sb }] });
    expect((await put(g.games[0].id, 10, 10)).json().error.code).toBe('TIE_NOT_ALLOWED');
    expect((await put(g.games[0].id, 10, 5)).statusCode).toBe(200); st = await stageOf(c, id, sid); expect(st.groups.find((x: any) => x.id === g.id).winnerId).toBeNull();
    expect((await put(g.games[1].id, 3, 9)).statusCode).toBe(200); expect((await put(g.games[2].id, 8, 2)).statusCode).toBe(200);
    st = await stageOf(c, id, sid); expect(st.groups.find((x: any) => x.id === g.id)).toMatchObject({ status: 'done', winnerId: a });
    const final = st.groups.find((x: any) => x.bracketKey === 'W2-0'); expect(final.status).toBe('pending'); expect(final.games).toHaveLength(0);
    const other = semi[1]; await tcall(c, id, 'PUT', `/games/${other.games[0].id}/scores`, { scores: other.playerIds.map((p: string, i: number) => ({ playerId: p, score: i ? 1 : 2 })) });
    for (const gm of other.games.slice(1)) await tcall(c, id, 'PUT', `/games/${gm.id}/scores`, { scores: other.playerIds.map((p: string, i: number) => ({ playerId: p, score: i ? 1 : 2 })) });
    st = await stageOf(c, id, sid); const f2 = st.groups.find((x: any) => x.bracketKey === 'W2-0'); expect(f2.status).toBe('ready'); expect(f2.games).toHaveLength(3);
    expect((await tcall(c, id, 'PUT', `/games/${f2.games[0].id}/scores`, { scores: [{ playerId: a, score: 1 }, { playerId: other.playerIds[0], score: 2 }] })).statusCode).toBe(200);
    expect((await put(g.games[2].id, 1, 8)).json().error.code).toBe('RESULT_LOCKED'); // semifinalen har ett resultat i finalen som beror på den
    // spelare som inte ingår i matchen
    expect((await tcall(c, id, 'PUT', `/games/${f2.games[1].id}/scores`, { scores: [{ playerId: a, score: 1 }, { playerId: b, score: 2 }] })).json().error.code).toBe('SCORES_MISMATCH');
  });
});

describe('Flipper: bordsstatus, behörighet och isolering', () => {
  it('en maskin kan bara ha en pågående match; maskin byts före start; resultat gör matchen klar', async () => {
    const c = await reg(); const id = await setup(c, 8, 4); const sid = await addStage(c, id, { kind: 'matchplay', config: { rounds: 1, groupSize: 4 } }); await start(c, id, sid);
    const st = await stageOf(c, id, sid); const [g1, g2] = st.groups; const m1 = g1.games[0].machineId;
    expect((await tcall(c, id, 'PATCH', `/games/${g1.games[0].id}`, { status: 'playing' })).statusCode).toBe(200);
    expect((await stageOf(c, id, sid)).groups[0].status).toBe('playing');
    await tcall(c, id, 'PATCH', `/games/${g2.games[0].id}`, { machineId: m1 });
    expect((await tcall(c, id, 'PATCH', `/games/${g2.games[0].id}`, { status: 'playing' })).json().error.code).toBe('MACHINE_BUSY');
    expect((await tcall(c, id, 'PATCH', `/games/${g1.games[0].id}`, { status: 'pending' })).statusCode).toBe(200);
    expect((await tcall(c, id, 'PATCH', `/games/${g2.games[0].id}`, { status: 'playing' })).statusCode).toBe(200);
    await playReady(c, id, sid); expect((await stageOf(c, id, sid)).groups.every((g: any) => g.status === 'done')).toBe(true);
    expect((await tcall(c, id, 'PATCH', `/games/${g1.games[0].id}`, { status: 'playing' })).json().error.code).toBe('GAME_DONE');
  });
  it('validering: dubbletter, för få spelare/maskiner, ordning, ej pinball-format, annan förenings data, oinloggad', async () => {
    const c = await reg(); const other = await reg(); const id = await setup(c, 3, 1);
    expect((await tcall(c, id, 'POST', '/players', { names: ['spelare 01'] })).json().error.code).toBe('PLAYER_EXISTS');
    expect((await tcall(c, id, 'POST', '/stages', { kind: 'matchplay', config: { rounds: 0 } })).statusCode).toBe(400);
    expect((await tcall(c, id, 'POST', '/stages', { kind: 'matchplay', config: { rounds: 2, hack: 1 } })).statusCode).toBe(400);
    const de = await addStage(c, id, { kind: 'double_elim', config: {} }); expect((await start(c, id, de)).statusCode).toBe(200); // 3 spelare räcker
    const v = await view(c, id); expect((await tcall(c, id, 'PUT', '/players/order', { order: v.players.map((p: any) => p.id) })).json().error.code).toBe('TOURNAMENT_STARTED');
    const t2 = (await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/tournaments`, cookie: c.cookie, payload: { name: 'Lag', format: 'round_robin' } })).json();
    expect((await tcall(c, t2.id, 'GET')).statusCode).toBe(404);
    expect((await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/tournaments/${id}/teams`, cookie: c.cookie, payload: { name: 'X' } })).json().error.code).toBe('WRONG_FORMAT');
    expect((await tcall(c, id, 'GET', '', undefined, other)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await custCall(app, { method: 'GET', url: `/workspaces/${c.workspaceId}/tournaments/${id}/pinball` })).statusCode).toBe(401);
    const empty = await setup(c, 1, 0, 'Tom'); const s = await addStage(c, empty, { kind: 'swiss', config: { rounds: 2 } });
    expect((await start(c, empty, s)).json().error.code).toBe('NO_MACHINES');
    expect(await auditRows(`action = 'tournament.pinball.stage_started'`)).toHaveLength(1);
    // RLS: data syns bara via rätt arbetsyta
    expect((await pool.query('select count(*)::int as n from pinball_players')).rows[0].n).toBe(0);
  });
});

describe('Flipper: gruppslutspel, bronsmatch och sena anmälningar', () => {
  it('gruppslutspel: grupper om fyra med tre spel på olika maskiner, två går vidare per omgång tills finalgrupp, unik slutranking', async () => {
    const c = await reg(); const id = await setup(c, 16, 4); const sid = await addStage(c, id, { kind: 'group_knockout', config: { groupSize: 4, advancePerGroup: 2, gamesPerGroup: 3 } });
    expect((await start(c, id, sid)).statusCode).toBe(200);
    let st = await stageOf(c, id, sid); expect(st.groups).toHaveLength(4);
    for (const g of st.groups) { expect(g.games).toHaveLength(3); expect(new Set(g.games.map((x: any) => x.machineId)).size).toBe(3); }
    const playAll = async () => { for (let i = 0; i < 100; i++) { const v = await view(c, id); const names = new Map<string, string>(v.players.map((p: any) => [p.id, p.name])); const cur = v.stages.find((x: any) => x.id === sid); const g = cur.groups.find((x: any) => x.status !== 'done'); if (!g) return;
      const game = g.games.find((x: any) => x.status !== 'done'); const r = await tcall(c, id, 'PUT', `/games/${game.id}/scores`, { scores: g.playerIds.map((pid: string) => ({ playerId: pid, score: 1000 - Number(names.get(pid)!.slice(-2)) })) }); expect(r.statusCode, r.body).toBe(200); } };
    expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).json().error.code).toBe('ROUND_NOT_DONE');
    await playAll(); st = await stageOf(c, id, sid); expect(st.groupResults[0].groups.every((g: any) => g.complete && g.rows.filter((r: any) => r.advances).length === 2)).toBe(true);
    expect((await tcall(c, id, 'POST', `/stages/${sid}/finish`, {})).json().error.code).toBe('ROUNDS_LEFT');
    expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).statusCode).toBe(200); st = await stageOf(c, id, sid); expect(st.groups.filter((g: any) => g.round === 2)).toHaveLength(2);
    const first = st.groups.find((g: any) => g.round === 1); expect((await tcall(c, id, 'DELETE', `/games/${first.games[0].id}/scores`)).json().error.code).toBe('RESULT_LOCKED'); // nästa omgång finns
    await playAll(); expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).statusCode).toBe(200); st = await stageOf(c, id, sid); const fin = st.groups.filter((g: any) => g.round === 3); expect(fin).toHaveLength(1); expect(fin[0].playerIds).toHaveLength(4);
    await playAll(); expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).json().error.code).toBe('LAST_ROUND');
    const done = await tcall(c, id, 'POST', `/stages/${sid}/finish`, {}); expect(done.statusCode, done.body).toBe(200); const r = done.json().ranking;
    expect(r.map((x: any) => x.rank)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1)); expect(new Set(r.map((x: any) => x.playerId)).size).toBe(16);
    const v = await view(c, id); expect(v.players.find((p: any) => p.id === r[0].playerId).name).toBe('Spelare 01'); expect(new Set(r.slice(0, 4).map((x: any) => x.playerId))).toEqual(new Set(fin[0].playerIds));
    const g1 = st.groups.find((g: any) => g.round === 1); expect((await tcall(c, id, 'DELETE', `/games/${g1.games[0].id}/scores`)).json().error.code).toBe('STAGE_NOT_RUNNING'); // avslutat steg kan inte ändras
  });
  it('gruppslutspel med udda antal och grupper om tre/en vidare tar slut och ger alla en placering', async () => {
    const c = await reg(); const id = await setup(c, 10, 3); const sid = await addStage(c, id, { kind: 'group_knockout', config: { groupSize: 3, advancePerGroup: 1, gamesPerGroup: 1 } }); await start(c, id, sid);
    for (let guard = 0; guard < 20; guard++) {
      const v = await view(c, id); const names = new Map<string, string>(v.players.map((p: any) => [p.id, p.name])); let st = v.stages.find((x: any) => x.id === sid);
      for (const g of st.groups.filter((x: any) => x.status !== 'done')) await tcall(c, id, 'PUT', `/games/${g.games[0].id}/scores`, { scores: g.playerIds.map((pid: string) => ({ playerId: pid, score: 1000 - Number(names.get(pid)!.slice(-2)) })) });
      st = await stageOf(c, id, sid); if (st.placements) break; expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).statusCode).toBe(200);
    }
    const fin = await tcall(c, id, 'POST', `/stages/${sid}/finish`, {}); expect(fin.statusCode, fin.body).toBe(200); expect(fin.json().ranking).toHaveLength(10);
  });
  it('bronsmatch i enkel utslagning: spelas mellan semifinalförlorarna och krävs för att steget ska kunna avslutas', async () => {
    const c = await reg(); const id = await setup(c, 8, 2); const sid = await addStage(c, id, { kind: 'single_elim', config: { bestOf: 1, bronzeMatch: true } }); await start(c, id, sid);
    for (let i = 0; i < 20; i++) { const st = await stageOf(c, id, sid); const g = st.groups.find((x: any) => x.status === 'ready' && x.bracketKey !== 'BM' && x.bracketKey !== 'W3-0'); if (!g) break; await playReady1(c, id, sid, g); }
    let st = await stageOf(c, id, sid); const bm = st.groups.find((g: any) => g.bracketKey === 'BM'); expect(bm.label).toBe('Bronsmatch'); expect(bm.rowLabel).toBe('Final'); expect(bm.status).toBe('ready'); expect(bm.playerIds).toHaveLength(2);
    const fin = st.groups.find((g: any) => g.bracketKey === 'W3-0'); await playReady1(c, id, sid, fin); expect((await tcall(c, id, 'POST', `/stages/${sid}/finish`, {})).json().error.code).toBe('MATCHES_OPEN');
    await playReady1(c, id, sid, (await stageOf(c, id, sid)).groups.find((g: any) => g.bracketKey === 'BM'));
    const done = await tcall(c, id, 'POST', `/stages/${sid}/finish`, {}); expect(done.statusCode, done.body).toBe(200); expect(done.json().ranking.slice(0, 4).map((x: any) => x.rank)).toEqual([1, 2, 3, 4]); expect(done.json().ranking).toHaveLength(8);
    const bmFinal = (await stageOf(c, id, sid)).groups.find((g: any) => g.bracketKey === 'BM'); expect(done.json().ranking[2].playerId).toBe(bmFinal.winnerId);
  });
  it('sena anmälningar: går med från nästa omgång i matchplay och kval, men inte i utslagning eller senare steg', async () => {
    const c = await reg(); const id = await setup(c, 8, 4); const sid = await addStage(c, id, { kind: 'matchplay', config: { rounds: 2, groupSize: 4 } }); await start(c, id, sid);
    const late = await tcall(c, id, 'POST', '/players', { names: ['Sen Spelare'] }); expect(late.statusCode).toBe(201);
    await playReady(c, id, sid); expect((await tcall(c, id, 'POST', `/stages/${sid}/next-round`, {})).statusCode).toBe(200);
    const st = await stageOf(c, id, sid); const r2 = st.groups.filter((g: any) => g.round === 2); expect(r2.map((g: any) => g.playerIds.length).sort()).toEqual([3, 3, 3]);
    const v = await view(c, id); const sen = v.players.find((p: any) => p.name === 'Sen Spelare'); expect(r2.flatMap((g: any) => g.playerIds)).toContain(sen.id); expect(st.playerIds).toContain(sen.id);
    expect((await tcall(c, id, 'POST', '/players', { names: ['Sen Spelare'] })).json().error.code).toBe('PLAYER_EXISTS');
    // utslagning: inga sena anmälningar
    const c2 = await reg(); const id2 = await setup(c2, 4, 2); const e = await addStage(c2, id2, { kind: 'single_elim', config: {} }); await start(c2, id2, e);
    expect((await tcall(c2, id2, 'POST', '/players', { names: ['För sent'] })).json().error.code).toBe('LATE_ENTRY_NOT_ALLOWED');
    // kval: ny spelare kan registrera försök direkt
    const c3 = await reg(); const id3 = await setup(c3, 3, 2); const q = await addStage(c3, id3, { kind: 'best_game', config: {} }); await start(c3, id3, q);
    expect((await tcall(c3, id3, 'POST', '/players', { names: ['Nykomling'] })).statusCode).toBe(201); const v3 = await view(c3, id3); const nk = v3.players.find((p: any) => p.name === 'Nykomling');
    expect((await tcall(c3, id3, 'POST', `/stages/${q}/attempts`, { playerId: nk.id, machineId: v3.machines[0].id, score: 12345 })).statusCode).toBe(201); expect(await auditRows(`action = 'tournament.pinball.players_added' and meta->>'late' = 'true'`)).toHaveLength(2);
  });
});
async function playReady1(c: TestCustomer, id: string, sid: string, g: any) {
  const v = await view(c, id); const names = new Map<string, string>(v.players.map((p: any) => [p.id, p.name])); const fresh = v.stages.find((x: any) => x.id === sid).groups.find((x: any) => x.id === g.id); const game = fresh.games.find((x: any) => x.status !== 'done');
  const r = await tcall(c, id, 'PUT', `/games/${game.id}/scores`, { scores: fresh.playerIds.map((pid: string) => ({ playerId: pid, score: 1000 - Number(names.get(pid)!.slice(-2)) })) }); expect(r.statusCode, r.body).toBe(200);
}

describe('Flipper: spelare ur medlemsregistret', () => {
  const member = async (c: TestCustomer, m: Record<string, unknown>) => (await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/association/members`, cookie: c.cookie, payload: m })).json();
  it('kandidater är aktiva medlemmar som inte redan är spelare; bara namn kopieras; dubbletter och okända id nekas', async () => {
    const c = await reg(); const id = await setup(c, 1, 1);
    const a = await member(c, { name: 'Anna Medlem', email: 'anna@example.test', phone: '070-111', notes: 'privat' }); const b = await member(c, { name: 'Bo Medlem', email: 'bo@example.test' }); const d = await member(c, { name: 'Dan Inaktiv', status: 'inactive' });
    await member(c, { name: 'Spelare 01' }); // finns redan som spelare i turneringen
    const cand = (await tcall(c, id, 'GET', '/member-candidates')).json().items.map((x: any) => x.name); expect(cand).toEqual(['Anna Medlem', 'Bo Medlem']);
    const r = await tcall(c, id, 'POST', '/players/from-members', { memberIds: [a.id, b.id] }); expect(r.statusCode, r.body).toBe(201); expect(r.json().added).toBe(2);
    const v = JSON.stringify(await view(c, id)); expect(v).toContain('Anna Medlem'); for (const leak of ['anna@example.test', '070-111', 'privat', 'bo@example.test']) expect(v, leak).not.toContain(leak);
    expect((await tcall(c, id, 'POST', '/players/from-members', { memberIds: [a.id] })).json().error.code).toBe('PLAYER_EXISTS');
    expect((await tcall(c, id, 'POST', '/players/from-members', { memberIds: [d.id] })).json().error.code).toBe('MEMBER_NOT_FOUND');
    expect((await tcall(c, id, 'POST', '/players/from-members', { memberIds: ['00000000-0000-4000-8000-000000000000'] })).json().error.code).toBe('MEMBER_NOT_FOUND');
    expect((await tcall(c, id, 'GET', '/member-candidates')).json().items).toEqual([]);
    expect((await auditRows(`action = 'tournament.pinball.players_added' and meta->>'source' = 'members'`))).toHaveLength(1);
  });
  it('en annan förenings medlemmar kan inte importeras, och utan Föreningsportalen finns ingen medlemskälla', async () => {
    const c = await reg(); const other = await reg(); const id = await setup(c, 1, 1); const foreign = await member(other, { name: 'Främmande Medlem' });
    expect((await tcall(c, id, 'POST', '/players/from-members', { memberIds: [foreign.id] })).json().error.code).toBe('MEMBER_NOT_FOUND');
    const only = await registerCustomer(app, { products: ['tournament_system'] }); const t = (await custCall(app, { method: 'POST', url: `/workspaces/${only.workspaceId}/tournaments`, cookie: only.cookie, payload: { name: 'X', format: 'pinball' } })).json();
    expect((await tcall(only, t.id, 'GET', '/member-candidates')).json().error.code).toBe('MEMBERS_NOT_AVAILABLE');
    expect((await tcall(only, t.id, 'POST', '/players/from-members', { memberIds: ['00000000-0000-4000-8000-000000000000'] })).json().error.code).toBe('MEMBERS_NOT_AVAILABLE');
  });
});
