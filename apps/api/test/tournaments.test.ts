import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withWorkspace } from '../src/db/pool.js';
import { knockout, nextSlot, qualifierSeeds, roundRobin, seedOrder, snakeGroups, standings } from '../src/domain/tournament.js';
import { auditRows, custCall, makeApp, registerCustomer, resetDb, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

type M = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const reg = () => registerCustomer(app, { products: ['tournament_system'] });
const call = (c: TestCustomer, method: M, extra = '', payload?: unknown, who = c) => custCall(app, { method, url: `/workspaces/${c.workspaceId}/tournaments${extra}`, cookie: who.cookie, payload });
async function started(c: TestCustomer, names: string[], double = false) {
  const t = (await call(c, 'POST', '', { name: 'Serien', doubleRound: double })).json();
  for (const n of names) expect((await call(c, 'POST', `/${t.id}/teams`, { name: n })).statusCode).toBe(201);
  expect((await call(c, 'POST', `/${t.id}/start`)).statusCode).toBe(200);
  return t.id as string;
}

describe('Turneringslogik (ren)', () => {
  it('alla möter alla exakt en gång, inget lag två gånger per omgång, frilag vid udda antal', () => {
    for (const n of [2, 3, 4, 5, 8]) {
      const ids = Array.from({ length: n }, (_, i) => `t${i}`); const fx = roundRobin(ids);
      expect(fx.length).toBe((n * (n - 1)) / 2);
      expect(new Set(fx.map((f) => [f.home, f.away].sort().join('-'))).size).toBe(fx.length);
      for (const r of new Set(fx.map((f) => f.round))) { const t = fx.filter((f) => f.round === r).flatMap((f) => [f.home, f.away]); expect(new Set(t).size).toBe(t.length); }
    }
    expect(roundRobin(['a', 'b', 'c'], true)).toHaveLength(6);
    expect(roundRobin(['a'])).toEqual([]);
  });
  it('tabell: poäng, målskillnad, delad placering vid helt lika', () => {
    const t = standings(['a', 'b', 'c'], [{ home: 'a', away: 'b', homeScore: 2, awayScore: 0 }, { home: 'b', away: 'c', homeScore: 1, awayScore: 1 }, { home: 'c', away: 'a', homeScore: 0, awayScore: 0 }]);
    expect(t.map((r) => [r.teamId, r.points, r.goalDiff, r.rank])).toEqual([['a', 4, 2, 1], ['c', 2, 0, 2], ['b', 1, -2, 3]]);
    expect(standings(['x', 'y'], [{ home: 'x', away: 'y', homeScore: 1, awayScore: 1 }]).map((r) => r.rank)).toEqual([1, 1]);
  });
});

describe('Turneringssystem: serie', () => {
  it('skapar, lägger till lag, startar, rapporterar, rättar och avslutar med tabell', async () => {
    const c = await reg();
    const id = await started(c, ['Röda', 'Blå', 'Gröna']);
    const d = (await call(c, 'GET', `/${id}`)).json();
    expect(d).toMatchObject({ status: 'running', canManage: true }); expect(d.matches).toHaveLength(3);
    expect((await call(c, 'POST', `/${id}/finish`)).json().error.code).toBe('TOURNAMENT_INCOMPLETE');
    for (const m of d.matches) expect((await call(c, 'PUT', `/${id}/matches/${m.id}`, { homeScore: 2, awayScore: 1 })).statusCode).toBe(200);
    const m0 = d.matches[0];
    expect((await call(c, 'PUT', `/${id}/matches/${m0.id}`, { homeScore: null, awayScore: null })).statusCode).toBe(200); // rättning/rensning
    expect((await call(c, 'PUT', `/${id}/matches/${m0.id}`, { homeScore: 1, awayScore: null })).statusCode).toBe(400);
    expect((await call(c, 'PUT', `/${id}/matches/${m0.id}`, { homeScore: -1, awayScore: 0 })).statusCode).toBe(400);
    await call(c, 'PUT', `/${id}/matches/${m0.id}`, { homeScore: 3, awayScore: 3 });
    expect((await call(c, 'POST', `/${id}/finish`)).statusCode).toBe(200);
    const done = (await call(c, 'GET', `/${id}`)).json();
    expect(done.status).toBe('finished'); expect(done.standings.reduce((s: number, r: any) => s + r.played, 0)).toBe(6);
    expect((await call(c, 'PUT', `/${id}/matches/${m0.id}`, { homeScore: 0, awayScore: 0 })).json().error.code).toBe('TOURNAMENT_NOT_RUNNING');
    const acts = (await auditRows(`target_type = 'tournament'`)).map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(['tournament.created', 'tournament.started', 'tournament.result_reported', 'tournament.finished']));
  });

  it('validerar lag: dubbletter (skiftlägesokänsligt), för få, låst efter start, dubbelserie', async () => {
    const c = await reg();
    const t = (await call(c, 'POST', '', { name: 'Cup' })).json();
    await call(c, 'POST', `/${t.id}/teams`, { name: 'Alfa' });
    expect((await call(c, 'POST', `/${t.id}/teams`, { name: 'alfa' })).json().error.code).toBe('TEAM_EXISTS');
    expect((await call(c, 'POST', `/${t.id}/start`)).json().error.code).toBe('TOO_FEW_TEAMS');
    await call(c, 'POST', `/${t.id}/teams`, { name: 'Beta' });
    expect((await call(c, 'PATCH', `/${t.id}`, { doubleRound: true })).statusCode).toBe(200);
    await call(c, 'POST', `/${t.id}/start`);
    expect((await call(c, 'GET', `/${t.id}`)).json().matches).toHaveLength(2);
    expect((await call(c, 'POST', `/${t.id}/teams`, { name: 'Gamma' })).json().error.code).toBe('TOURNAMENT_LOCKED');
    expect((await call(c, 'POST', `/${t.id}/start`)).json().error.code).toBe('TOURNAMENT_LOCKED');
    expect((await call(c, 'PATCH', `/${t.id}`, { doubleRound: false })).json().error.code).toBe('TOURNAMENT_LOCKED');
    expect((await call(c, 'PATCH', `/${t.id}`, { name: 'Nytt namn' })).json().name).toBe('Nytt namn');
  });

  it('vanlig medlem kan läsa men inte skriva', async () => {
    const admin = await reg(); const staff = await reg();
    await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [admin.workspaceId, staff.userId]);
    const id = await started(admin, ['A', 'B']);
    const view = (await call(admin, 'GET', `/${id}`, undefined, staff)).json();
    expect(view).toMatchObject({ canManage: false }); expect(view.standings).toHaveLength(2);
    expect((await call(admin, 'POST', '', { name: 'X' }, staff)).statusCode).toBe(403);
    expect((await call(admin, 'PUT', `/${id}/matches/${view.matches[0].id}`, { homeScore: 1, awayScore: 0 }, staff)).statusCode).toBe(403);
    expect((await call(admin, 'DELETE', `/${id}`, undefined, staff)).statusCode).toBe(403);
  });

  it('tenant-isolering: annan arbetsyta ser och rör ingenting, RLS stänger även rå SQL', async () => {
    const a = await reg(); const b = await reg();
    const id = await started(a, ['A', 'B']); const m = (await call(a, 'GET', `/${id}`)).json().matches[0].id;
    expect((await call(a, 'GET', `/${id}`, undefined, b)).statusCode).toBe(404); // icke-medlem får samma svar som "finns inte"
    expect((await call(b, 'GET', `/${id}`)).statusCode).toBe(404);
    expect((await call(b, 'PUT', `/${id}/matches/${m}`, { homeScore: 1, awayScore: 1 })).statusCode).toBe(404);
    expect((await call(b, 'DELETE', `/${id}`)).statusCode).toBe(404);
    expect((await call(b, 'GET')).json().items).toHaveLength(0);
    expect((await pool.query('select count(*)::int as n from tournaments')).rows[0].n).toBe(0); // ingen kontext = 0 rader
    await withWorkspace(b.workspaceId, async (cl) => {
      expect((await cl.query('select count(*)::int as n from tournament_matches')).rows[0].n).toBe(0);
      await expect(cl.query(`insert into tournament_teams (workspace_id, tournament_id, name) values ($1,$2,'Smugglat')`, [b.workspaceId, id])).rejects.toThrow(); // FK mot annan arbetsyta
    });
    expect((await call(a, 'GET', `/${id}`)).json().teams).toHaveLength(2);
  });

  it('åtkomstlägen: ej aktiverad produkt, skrivskyddad och avslutad arbetsyta', async () => {
    const noProd = await registerCustomer(app); // bara föreningsportal
    expect((await call(noProd, 'GET')).json().error.code).toBe('PRODUCT_NOT_AVAILABLE');
    expect((await call(noProd, 'POST', '', { name: 'X' })).statusCode).toBe(403);
    const c = await reg(); const id = await started(c, ['A', 'B']);
    await pool.query(`update workspaces set status = 'Suspended' where id = $1`, [c.workspaceId]);
    expect((await call(c, 'GET', `/${id}`)).statusCode).toBe(200);
    expect((await call(c, 'POST', '', { name: 'Ny' })).json().error.code).toBe('WORKSPACE_READ_ONLY');
    await pool.query(`update workspaces set status = 'Closed' where id = $1`, [c.workspaceId]);
    expect((await call(c, 'GET', `/${id}`)).statusCode).toBe(403);
  });

  it('gräns för aktiva turneringar: nås, blockerar skapande, återhämtar när en avslutas (ENT-3)', async () => {
    const c = await reg();
    await pool.query(`update product_entitlements set limits_override = '{"max_tournaments":1}' where workspace_id = $1 and product = 'tournament_system'`, [c.workspaceId]);
    const id = await started(c, ['A', 'B']);
    expect((await call(c, 'POST', '', { name: 'Två' })).json().error.code).toBe('LIMIT_EXCEEDED');
    for (const m of (await call(c, 'GET', `/${id}`)).json().matches) await call(c, 'PUT', `/${id}/matches/${m.id}`, { homeScore: 1, awayScore: 0 });
    await call(c, 'POST', `/${id}/finish`);
    expect((await call(c, 'POST', '', { name: 'Två' })).statusCode).toBe(201);
  });

  it('radering tar med lag och matcher; parallella skapanden respekterar gränsen', async () => {
    const c = await reg();
    const id = await started(c, ['A', 'B', 'C']);
    expect((await call(c, 'DELETE', `/${id}`)).statusCode).toBe(204);
    await withWorkspace(c.workspaceId, async (cl) => {
      for (const t of ['tournaments', 'tournament_teams', 'tournament_matches']) expect((await cl.query(`select count(*)::int as n from ${t}`)).rows[0].n).toBe(0);
    });
    await pool.query(`update product_entitlements set limits_override = '{"max_tournaments":2}' where workspace_id = $1 and product = 'tournament_system'`, [c.workspaceId]);
    const rs = await Promise.all([1, 2, 3, 4].map((i) => call(c, 'POST', '', { name: `P${i}` })));
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(2);
  });
});

describe('Utslagning (ren logik)', () => {
  it('seedning, frilotter till högsta seed och bracket-storlek', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    const b = knockout(['t1', 't2', 't3', 't4', 't5']); // 5 lag -> bracket om 8, tre frilotter
    expect(b).toHaveLength(7);
    expect(b.filter((m) => m.round === 1 && m.away === null).map((m) => m.home).sort()).toEqual(['t1', 't2', 't3']);
    expect(b.filter((m) => m.round === 1 && m.away).map((m) => [m.home, m.away])).toEqual([['t4', 't5']]);
    expect(knockout(['a', 'b'])).toEqual([{ round: 1, position: 0, home: 'a', away: 'b' }]);
    expect(knockout(['a'])).toEqual([]);
    expect(nextSlot(1, 3, 3)).toEqual({ round: 2, position: 1, slot: 'away' });
    expect(nextSlot(3, 0, 3)).toBeNull();
  });
});

describe('Turneringssystem: utslagning', () => {
  const ko = async (c: TestCustomer, names: string[]) => {
    const t = (await call(c, 'POST', '', { name: 'Cupen', format: 'single_elimination' })).json();
    for (const n of names) await call(c, 'POST', `/${t.id}/teams`, { name: n });
    expect((await call(c, 'POST', `/${t.id}/start`)).statusCode).toBe(200);
    return t.id as string;
  };
  const get = async (c: TestCustomer, id: string) => (await call(c, 'GET', `/${id}`)).json();
  const play = (c: TestCustomer, id: string, m: any, h: number | null, a: number | null) => call(c, 'PUT', `/${id}/matches/${m.id}`, { homeScore: h, awayScore: a });

  it('spelar en cup med 5 lag: frilotter går vidare, vinnare flyttas fram, champion utses', async () => {
    const c = await reg(); const id = await ko(c, ['A', 'B', 'C', 'D', 'E']);
    let d = await get(c, id);
    expect(d).toMatchObject({ format: 'single_elimination', totalRounds: 3, championTeamId: null });
    const id2name = (tid: string) => d.teams.find((x: any) => x.id === tid)?.name;
    // semifinalplatserna: A (frilott) möter vinnaren av D-E i ena, B/C (frilotter) möts i den andra
    const r1 = d.matches.filter((m: any) => m.round === 1);
    expect(r1.filter((m: any) => m.bye)).toHaveLength(3);
    expect((await play(c, id, r1.find((m: any) => m.bye), 1, 0)).json().error.code).toBe('MATCH_NOT_READY');
    const real = r1.find((m: any) => !m.bye);
    expect((await play(c, id, real, 1, 1)).json().error.code).toBe('DRAW_NOT_ALLOWED');
    expect((await call(c, 'POST', `/${id}/finish`)).json().error.code).toBe('TOURNAMENT_INCOMPLETE');
    await play(c, id, real, 0, 2); // E slår D
    d = await get(c, id);
    const semis = d.matches.filter((m: any) => m.round === 2);
    expect(semis.flatMap((m: any) => [m.homeTeamId, m.awayTeamId]).map(id2name).sort()).toEqual(['A', 'B', 'C', 'E']);
    for (const m of semis) expect((await play(c, id, m, 3, 1)).statusCode).toBe(200); // hemmalaget vinner
    d = await get(c, id);
    const fin = d.matches.find((m: any) => m.round === 3);
    expect(fin.homeTeamId && fin.awayTeamId).toBeTruthy();
    expect((await play(c, id, fin, 2, 1)).statusCode).toBe(200);
    expect((await call(c, 'POST', `/${id}/finish`)).statusCode).toBe(200);
    d = await get(c, id);
    expect(id2name(d.championTeamId)).toBe(id2name(fin.homeTeamId)); expect(d.status).toBe('finished');
  });

  it('rättning: ändrad vinnare byter plats i nästa omgång, men låses när nästa match spelats', async () => {
    const c = await reg(); const id = await ko(c, ['A', 'B', 'C', 'D']);
    let d = await get(c, id); const [s1, s2] = d.matches.filter((m: any) => m.round === 1);
    await play(c, id, s1, 2, 0); await play(c, id, s2, 2, 0);
    d = await get(c, id); const fin = () => d.matches.find((m: any) => m.round === 2);
    const before = fin().homeTeamId; expect(before).toBe(s1.homeTeamId);
    await play(c, id, s1, 0, 2); d = await get(c, id); expect(fin().homeTeamId).toBe(s1.awayTeamId); // rättat resultat
    await play(c, id, s1, null, null); d = await get(c, id); expect(fin().homeTeamId).toBeNull(); // rensat -> platsen töms
    await play(c, id, s1, 2, 0); d = await get(c, id);
    expect((await play(c, id, fin(), 1, 0)).statusCode).toBe(200);
    expect((await play(c, id, s1, 0, 2)).json().error.code).toBe('RESULT_LOCKED'); // finalen är spelad
    expect((await get(c, id)).matches.find((m: any) => m.round === 2).homeTeamId).toBe(s1.homeTeamId);
  });

  it('två lag ger en final; dubbelserie nekas för utslagning; medlem ser bracket men kan inte ändra', async () => {
    const admin = await reg(); const staff = await reg();
    await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [admin.workspaceId, staff.userId]);
    expect((await call(admin, 'POST', '', { name: 'X', format: 'single_elimination', doubleRound: true })).statusCode).toBe(400);
    const id = await ko(admin, ['A', 'B']);
    const d = (await call(admin, 'GET', `/${id}`, undefined, staff)).json();
    expect(d).toMatchObject({ canManage: false, totalRounds: 1 }); expect(d.matches).toHaveLength(1);
    expect((await call(admin, 'PUT', `/${id}/matches/${d.matches[0].id}`, { homeScore: 1, awayScore: 0 }, staff)).statusCode).toBe(403);
    expect((await call(admin, 'PATCH', `/${id}`, { doubleRound: true })).json().error.code).toBe('NOT_APPLICABLE');
  });

  it('listan räknar bara riktiga matcher (inte frilotter) och RLS gäller de nya kolumnerna', async () => {
    const a = await reg(); const b = await reg();
    const id = await ko(a, ['A', 'B', 'C', 'D', 'E']);
    const item = (await call(a, 'GET')).json().items.find((t: any) => t.id === id);
    expect(item).toMatchObject({ teamCount: 5, matchCount: 4, playedCount: 0 }); // 5 lag => 4 matcher
    expect((await call(b, 'GET', `/${id}`)).statusCode).toBe(404);
  });
});

describe('Gruppspel + slutspel (ren logik)', () => {
  it('snake-fördelning och slutspelsseedning undviker gruppkrock i första omgången', () => {
    expect(snakeGroups(['1', '2', '3', '4', '5', '6', '7', '8'], 2)).toEqual([['1', '4', '5', '8'], ['2', '3', '6', '7']]);
    expect(snakeGroups(['1', '2', '3', '4', '5'], 4)).toEqual([['1'], ['2'], ['3'], ['4', '5']]);
    const ranked = [['A1', 'A2'], ['B1', 'B2'], ['C1', 'C2'], ['D1', 'D2']];
    const seeds = qualifierSeeds(ranked, 2);
    expect(seeds).toEqual(['A1', 'B1', 'C1', 'D1', 'C2', 'D2', 'A2', 'B2']);
    const r1 = knockout(seeds).filter((m) => m.round === 1).map((m) => [m.home, m.away]);
    for (const [h, a] of r1) expect(h![0]).not.toBe(a![0]); // aldrig samma grupp
    expect(qualifierSeeds([['A1'], ['B1']], 1)).toEqual(['A1', 'B1']);
  });
});

describe('Turneringssystem: gruppspel + slutspel', () => {
  const mk = async (c: TestCustomer, n: number, extra: Record<string, unknown>) => {
    const t = (await call(c, 'POST', '', { name: 'GS', format: 'groups_knockout', ...extra })).json();
    for (let i = 1; i <= n; i++) await call(c, 'POST', `/${t.id}/teams`, { name: `T${i}` });
    return t.id as string;
  };
  const get = async (c: TestCustomer, id: string) => (await call(c, 'GET', `/${id}`)).json();
  const nm = (d: any, tid: string) => d.teams.find((x: any) => x.id === tid)?.name as string;
  const idx = (d: any, tid: string) => Number(nm(d, tid).slice(1));

  it('validerar skapande och start', async () => {
    const c = await reg();
    expect((await call(c, 'POST', '', { name: 'X', format: 'groups_knockout' })).statusCode).toBe(400); // grupper saknas
    expect((await call(c, 'POST', '', { name: 'X', format: 'groups_knockout', groupCount: 3 })).statusCode).toBe(400);
    expect((await call(c, 'POST', '', { name: 'X', format: 'round_robin', groupCount: 2 })).statusCode).toBe(400);
    const id = await mk(c, 3, { groupCount: 2 });
    expect((await call(c, 'POST', `/${id}/start`)).json().error.code).toBe('TOO_FEW_TEAMS');
  });

  it('spelar hela vägen: grupper, kvalificering, kors-seedat slutspel, mästare', async () => {
    const c = await reg(); const id = await mk(c, 8, { groupCount: 2, advancePerGroup: 2 });
    expect((await call(c, 'POST', `/${id}/start`)).json()).toMatchObject({ status: 'running', matches: 12 });
    let d = await get(c, id);
    expect(d).toMatchObject({ phase: 'groups', format: 'groups_knockout' });
    expect(d.groups.map((g: any) => g.teamIds.map((t: string) => nm(d, t)).sort())).toEqual([['T1', 'T4', 'T5', 'T8'], ['T2', 'T3', 'T6', 'T7']]);
    expect((await call(c, 'POST', `/${id}/knockout`, {})).json().error.code).toBe('GROUPS_INCOMPLETE');
    expect((await call(c, 'POST', `/${id}/finish`)).json().error.code).toBe('TOURNAMENT_INCOMPLETE');
    const grp = d.matches.filter((m: any) => m.groupNo);
    for (const m of grp) { const homeWins = idx(d, m.homeTeamId) < idx(d, m.awayTeamId); expect((await call(c, 'PUT', `/${id}/matches/${m.id}`, homeWins ? { homeScore: 1, awayScore: 0 } : { homeScore: 0, awayScore: 1 })).statusCode).toBe(200); }
    expect((await call(c, 'POST', `/${id}/knockout`, {})).statusCode).toBe(200);
    expect((await call(c, 'POST', `/${id}/knockout`, {})).json().error.code).toBe('TOURNAMENT_LOCKED');
    expect((await call(c, 'PUT', `/${id}/matches/${grp[0].id}`, { homeScore: 5, awayScore: 5 })).json().error.code).toBe('GROUP_LOCKED');
    d = await get(c, id); expect(d.phase).toBe('knockout');
    const ko = d.matches.filter((m: any) => m.position !== null);
    const sf = ko.filter((m: any) => m.round === 1).map((m: any) => [nm(d, m.homeTeamId), nm(d, m.awayTeamId)]);
    expect(sf).toEqual([['T1', 'T3'], ['T2', 'T4']]); // 1A–2B och 1B–2A
    for (const m of ko.filter((x: any) => x.round === 1)) await call(c, 'PUT', `/${id}/matches/${m.id}`, { homeScore: 2, awayScore: 0 });
    d = await get(c, id); const fin = d.matches.find((m: any) => m.round === 2);
    await call(c, 'PUT', `/${id}/matches/${fin.id}`, { homeScore: 1, awayScore: 0 });
    expect((await call(c, 'POST', `/${id}/finish`)).statusCode).toBe(200);
    d = await get(c, id); expect(nm(d, d.championTeamId)).toBe('T1'); expect(d.groups[0].standings[0].points).toBe(9);
    const item = (await call(c, 'GET')).json().items[0]; expect(item).toMatchObject({ format: 'groups_knockout', status: 'finished' });
  });

  it('delad placering som avgör slutspelsplats kräver uttrycklig ordning', async () => {
    const c = await reg(); const id = await mk(c, 4, { groupCount: 2, advancePerGroup: 1 });
    await call(c, 'POST', `/${id}/start`); const d = await get(c, id);
    for (const m of d.matches) await call(c, 'PUT', `/${id}/matches/${m.id}`, { homeScore: 1, awayScore: 1 });
    const r = (await call(c, 'POST', `/${id}/knockout`, {})).json();
    expect(r.error.code).toBe('TIE_AT_CUTOFF'); expect(r.error.details.groups).toHaveLength(2);
    const byName = (n: string) => d.teams.find((x: any) => x.name === n).id;
    expect((await call(c, 'POST', `/${id}/knockout`, { order: [byName('T1'), byName('T4')] })).json().error.code).toBe('TIE_AT_CUTOFF'); // ofullständig
    expect((await call(c, 'POST', `/${id}/knockout`, { order: [byName('T4'), byName('T1'), byName('T3'), byName('T2')] })).statusCode).toBe(200);
    const k = (await get(c, id)).matches.find((m: any) => m.position !== null);
    expect([nm(d, k.homeTeamId), nm(d, k.awayTeamId)]).toEqual(['T4', 'T3']); // ordningen styr vem som går vidare
  });

  it('isolering och roller gäller även gruppspel', async () => {
    const a = await reg(); const b = await reg(); const id = await mk(a, 4, { groupCount: 2 });
    await call(a, 'POST', `/${id}/start`);
    expect((await call(b, 'POST', `/${id}/knockout`, {})).statusCode).toBe(404);
    expect((await call(b, 'GET', `/${id}`)).statusCode).toBe(404);
    const staff = await reg(); await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [a.workspaceId, staff.userId]);
    expect((await call(a, 'POST', `/${id}/knockout`, {}, staff)).statusCode).toBe(403);
  });
});

describe('Turneringssystem: export', () => {
  it('exporterar CSV/JSON, skyddar mot formelinjektion, fungerar när arbetsytan är avslutad, kräver admin och stannar i arbetsytan', async () => {
    const c = await reg(); const other = await reg();
    const t = (await call(c, 'POST', '', { name: 'Cup 2026' })).json();
    for (const n of ['=HYPERLINK("x")', 'Blå']) await call(c, 'POST', `/${t.id}/teams`, { name: n });
    await call(c, 'POST', `/${t.id}/start`); const m = (await call(c, 'GET', `/${t.id}`)).json().matches[0];
    await call(c, 'PUT', `/${t.id}/matches/${m.id}`, { homeScore: 2, awayScore: 1 });
    await call(other, 'POST', '', { name: 'Annans' });
    const csv = await call(c, 'GET', '/export');
    expect(csv.statusCode).toBe(200); expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('"Cup 2026","Serie","Pågår"'); expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`); expect(csv.body).not.toContain('Annans');
    const js = (await call(c, 'GET', '/export?format=json')).json(); expect(js.items).toHaveLength(1); expect(js.items[0].teams).toHaveLength(2); expect(js.items[0].matches).toHaveLength(1);
    const staff = await reg(); await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [c.workspaceId, staff.userId]);
    expect((await call(c, 'GET', '/export', undefined, staff)).statusCode).toBe(403);
    await pool.query(`update workspaces set status = 'Closed' where id = $1`, [c.workspaceId]);
    expect((await call(c, 'GET', '/export')).statusCode).toBe(200); // export_only
    expect((await call(c, 'GET', `/${t.id}`)).statusCode).toBe(403);
    expect((await auditRows(`action = 'tournament.exported'`)).length).toBeGreaterThanOrEqual(2);
    const noProd = await registerCustomer(app); expect((await call(noProd, 'GET', '/export')).statusCode).toBe(403);
  });
});
