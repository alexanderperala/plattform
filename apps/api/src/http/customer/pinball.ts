import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { withWorkspace } from '../../db/pool.js';
import { camelAll } from '../../lib/camel.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { canRead, canWrite } from '../../domain/access.js';
import { roundRobin, roundName } from '../../domain/tournament.js';
import { addHistory, assignGroups, assignMachines, awardPoints, bestGameRanking, bracketPlacements, buildBracket, evaluateBracket, groupSizes, POINT_PRESETS, poolStandings, rankGroup, effectiveAdvance, groupKoRanking, rngFrom, swissRound, BYE, type BNode, type History, type NodeState, type PointsTable } from '../../domain/pinball.js';
import { modeFor, type Helpers } from './association.js';

type Db = Parameters<typeof modeFor>[0];
const uuid = z.string().uuid();
const NOT_AVAILABLE = () => forbidden('Turneringssystemet är inte aktiverat för den här arbetsytan.', 'PRODUCT_NOT_AVAILABLE');
const READ_ONLY = () => forbidden('Arbetsytan eller produkten är skrivskyddad. Kontakta er administratör eller supporten.', 'WORKSPACE_READ_ONLY');
export const MAX_PLAYERS = 256; export const MAX_MACHINES = 64; export const MAX_STAGES = 8;

const points = z.enum(['7-5-3-1', '4-2-1-0']).default('7-5-3-1');
const advance = z.number().int().min(1).max(MAX_PLAYERS).optional();
const stageBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('best_game'), name: z.string().trim().min(1).max(100).optional(), config: z.object({ mode: z.enum(['best', 'sum_of_best_per_machine']).default('best'), maxAttempts: z.number().int().min(1).max(100).optional(), advance }).strict().default({ mode: 'best' }) }).strict(),
  z.object({ kind: z.literal('matchplay'), name: z.string().trim().min(1).max(100).optional(), config: z.object({ rounds: z.number().int().min(1).max(12), groupSize: z.union([z.literal(3), z.literal(4)]).default(4), points, grouping: z.enum(['random', 'balanced']).default('random'), advance }).strict() }).strict(),
  z.object({ kind: z.literal('swiss'), name: z.string().trim().min(1).max(100).optional(), config: z.object({ rounds: z.number().int().min(1).max(12), groupSize: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2), points, advance }).strict() }).strict(),
  z.object({ kind: z.literal('round_robin'), name: z.string().trim().min(1).max(100).optional(), config: z.object({ doubleRound: z.boolean().default(false), points, advance }).strict().default({ doubleRound: false, points: '7-5-3-1' }) }).strict(),
  z.object({ kind: z.literal('group_knockout'), name: z.string().trim().min(1).max(100).optional(), config: z.object({ groupSize: z.union([z.literal(3), z.literal(4)]).default(4), advancePerGroup: z.union([z.literal(1), z.literal(2)]).default(2), gamesPerGroup: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(3), points, advance }).strict().default({ groupSize: 4, advancePerGroup: 2, gamesPerGroup: 3, points: '7-5-3-1' }) }).strict(),
  z.object({ kind: z.literal('single_elim'), name: z.string().trim().min(1).max(100).optional(), config: z.object({ bestOf: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(1), bronzeMatch: z.boolean().default(false), advance }).strict().default({ bestOf: 1, bronzeMatch: false }) }).strict(),
  z.object({ kind: z.literal('double_elim'), name: z.string().trim().min(1).max(100).optional(), config: z.object({ bestOf: z.union([z.literal(1), z.literal(3), z.literal(5)]).default(1), grandFinalReset: z.boolean().default(true), advance }).strict().default({ bestOf: 1, grandFinalReset: true }) }).strict(),
]);
const KIND_NAME: Record<string, string> = { best_game: 'Kval (försök)', matchplay: 'Matchplay', swiss: 'Swiss', round_robin: 'Serie', single_elim: 'Utslagning', group_knockout: 'Gruppslutspel', double_elim: 'Dubbel utslagning' };
const names = z.object({ names: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_PLAYERS) }).strict();
const scoreIn = z.object({ scores: z.array(z.object({ playerId: uuid, score: z.number().int().min(0).max(9_999_999_999_999) }).strict()).min(1).max(4) }).strict();

interface Stage { id: string; no: number; kind: keyof typeof KIND_NAME; name: string; config: Record<string, any>; status: 'pending' | 'running' | 'finished'; current_round: number; final_ranking: Array<{ playerId: string; rank: number }> | null; rng_seed: number }
const table = (s: Stage): PointsTable => POINT_PRESETS[(s.config.points as string) ?? '7-5-3-1'] ?? POINT_PRESETS['7-5-3-1']!;
const nodesOf = (s: Stage): BNode[] => buildBracket(s.kind === 'double_elim' ? 'double' : 'single', (s.config._players as string[]).length, s.config.grandFinalReset !== false, s.config.bronzeMatch === true);
const bracketRound = (n: BNode) => (n.bracket === 'W' || n.bracket === 'B' ? n.round : n.bracket === 'L' ? 100 + n.round : 200 + n.round);

export async function pinballView(c: Db, t: { id: string; [k: string]: unknown }) {
  const players = (await c.query('select id, name, seed, withdrawn from pinball_players where tournament_id = $1 order by seed, id', [t.id])).rows as Array<{ id: string; name: string; seed: number; withdrawn: boolean }>;
  const machines = (await c.query('select id, name, active from pinball_machines where tournament_id = $1 order by sort, lower(name), id', [t.id])).rows;
  const stages = (await c.query('select id, no, kind, name, config, status, current_round, final_ranking, rng_seed from pinball_stages where tournament_id = $1 order by no', [t.id])).rows as Stage[];
  const sid = stages.map((s) => s.id);
  const groups = sid.length ? (await c.query('select id, stage_id, round, slot, bracket_key from pinball_groups where stage_id = any($1) order by stage_id, round, slot', [sid])).rows as Array<{ id: string; stage_id: string; round: number; slot: number; bracket_key: string | null }> : [];
  const gp = groups.length ? (await c.query('select group_id, player_id from pinball_group_players where group_id = any($1) order by group_id, seat', [groups.map((g) => g.id)])).rows as Array<{ group_id: string; player_id: string }> : [];
  const games = groups.length ? (await c.query('select id, group_id, game_no, machine_id, status from pinball_games where group_id = any($1) order by group_id, game_no', [groups.map((g) => g.id)])).rows as Array<{ id: string; group_id: string; game_no: number; machine_id: string | null; status: 'pending' | 'playing' | 'done' }> : [];
  const scores = games.length ? (await c.query('select game_id, player_id, score::float8 as score, placement, points::float8 as points from pinball_scores where game_id = any($1)', [games.map((g) => g.id)])).rows as Array<{ game_id: string; player_id: string; score: number; placement: number; points: number }> : [];
  const attempts = sid.length ? (await c.query('select id, stage_id, player_id, machine_id, score::float8 as score, created_at from pinball_attempts where stage_id = any($1) order by created_at desc, id', [sid])).rows as Array<{ id: string; stage_id: string; player_id: string; machine_id: string; score: number; created_at: string }> : [];
  const out = stages.map((s) => {
    const mine = groups.filter((g) => g.stage_id === s.id); const ids: string[] = (s.config._players as string[] | undefined) ?? [];
    const gameOf = (gid: string) => games.filter((g) => g.group_id === gid).map((g) => ({ id: g.id, gameNo: g.game_no, machineId: g.machine_id, status: g.status, scores: scores.filter((x) => x.game_id === g.id).sort((a, b) => a.placement - b.placement).map((x) => ({ playerId: x.player_id, score: x.score, placement: x.placement, points: x.points })) }));
    const base = { id: s.id, no: s.no, kind: s.kind, name: s.name, status: s.status, currentRound: s.current_round, config: Object.fromEntries(Object.entries(s.config).filter(([k]) => !k.startsWith('_'))), playerIds: ids, finalRanking: s.final_ranking };
    if (s.kind === 'best_game') {
      const at = attempts.filter((a) => a.stage_id === s.id);
      return { ...base, groups: [], ranking: bestGameRanking(ids, at.map((a) => ({ playerId: a.player_id, machineId: a.machine_id, score: a.score })), s.config.mode), attempts: camelAll(at.slice(0, 200)) };
    }
    if (s.kind === 'single_elim' || s.kind === 'double_elim') {
      if (s.status === 'pending') return { ...base, groups: [], placements: null };
      const nodes = nodesOf(s); const state = evaluateBracket(nodes, ids, winnersOf(s, mine, games, scores));
      const total = Math.max(...nodes.filter((n) => n.bracket === 'W').map((n) => n.round));
      const label = (n: BNode) => (n.bracket === 'B' ? 'Bronsmatch' : n.bracket === 'GF' ? (n.round === 1 ? 'Grand final' : 'Grand final (omspel)') : s.kind === 'single_elim' ? roundName(n.round, total) : n.bracket === 'W' ? `Vinnarsida ${n.round}` : `Förlorarsida ${n.round}`);
      const gs = nodes.map((n) => {
        const g = mine.find((x) => x.bracket_key === n.key)!; const st = state.get(n.key)!; const gm = gameOf(g.id);
        const status = st.status === 'ready' ? (gm.some((x) => x.status === 'playing') ? 'playing' : 'ready') : st.status;
        const pl = [st.home, st.away].filter((x): x is string => !!x && x !== BYE);
        return { id: g.id, round: bracketRound(n), slot: g.slot, bracketKey: n.key, label: label(n), rowLabel: n.bracket === 'B' ? (s.kind === 'single_elim' ? roundName(n.round, total) : label(n)) : label(n), status, playerIds: pl, games: gm, winnerId: st.winner && st.winner !== BYE ? st.winner : null };
      });
      return { ...base, groups: gs, placements: bracketPlacements(nodes, state) };
    }
    const gs = mine.map((g) => {
      const gm = gameOf(g.id); const pl = gp.filter((x) => x.group_id === g.id).map((x) => x.player_id);
      const status = gm.every((x) => x.status === 'done') ? 'done' : gm.some((x) => x.status === 'playing') ? 'playing' : 'ready';
      return { id: g.id, round: g.round, slot: g.slot, bracketKey: null, label: `Bord ${g.slot + 1}`, rowLabel: s.kind === 'group_knockout' ? `Omgång ${g.round}` : `Omgång ${g.round}`, status, playerIds: pl, games: gm, winnerId: null };
    });
    const doneGames = gs.flatMap((g) => g.games.filter((x) => x.status === 'done').map((x) => ({ players: x.scores.map((y) => ({ id: y.playerId, placement: y.placement, points: y.points })) })));
    if (s.kind === 'group_knockout') {
      const rounds = [...new Set(gs.map((g) => g.round))].sort((a, b) => a - b); const adv = s.config.advancePerGroup as number;
      const results = rounds.map((r) => ({ round: r, groups: gs.filter((g) => g.round === r).map((g) => {
        const rows = rankGroup(g.playerIds, g.games.filter((x) => x.status === 'done').map((x) => ({ players: x.scores.map((y) => ({ id: y.playerId, placement: y.placement, points: y.points })) })), ids); const n = effectiveAdvance(g.playerIds.length, adv);
        return { groupId: g.id, complete: g.status === 'done', rows: rows.map((x) => ({ ...x, advances: x.rank <= n })) };
      }) }));
      const last = results[results.length - 1]; const finished = !!last && last.groups.length === 1 && last.groups[0]!.complete;
      const placements = finished ? groupKoRanking(results.map((x) => ({ groups: x.groups.map((g) => g.rows), advance: adv })), ids) : null;
      return { ...base, groups: gs, groupResults: results, placements, totalRounds: rounds.length };
    }
    return { ...base, groups: gs, standings: poolStandings(ids, doneGames), totalRounds: s.kind === 'round_robin' ? Math.max(0, ...gs.map((g) => g.round)) : (s.config.rounds as number) };
  });
  const active = stages.find((s) => s.status === 'running') ?? [...stages].reverse().find((s) => s.status === 'finished') ?? stages[0];
  return { ...camelAll([t])[0], players: camelAll(players), machines: camelAll(machines), stages: out, activeStageId: active?.id ?? null };
}

function winnersOf(s: Stage, groups: Array<{ id: string; bracket_key: string | null }>, games: Array<{ id: string; group_id: string; status: string }>, scores: Array<{ game_id: string; player_id: string; placement: number }>): Record<string, string> {
  const need = Math.floor((s.config.bestOf ?? 1) / 2) + 1; const out: Record<string, string> = {};
  for (const g of groups) {
    if (!g.bracket_key) continue; const wins = new Map<string, number>();
    for (const gm of games.filter((x) => x.group_id === g.id && x.status === 'done')) for (const sc of scores.filter((x) => x.game_id === gm.id && x.placement === 1)) wins.set(sc.player_id, (wins.get(sc.player_id) ?? 0) + 1);
    for (const [p, w] of wins) if (w >= need) out[g.bracket_key] = p;
  }
  return out;
}

/** Turneringssystemet, flipper: spelare, maskiner, steg och resultat. Läsa: alla medlemmar. Skriva: ägare/admin. */
export function pinballRoutes(app: FastifyInstance, { authed, requireMember }: Helpers): void {
  const base = '/workspaces/:wid/tournaments/:id/pinball';
  const guard = async (c: Db, wid: string, write: boolean) => { const m = await modeFor(c, wid, 'tournament_system', 'max_tournaments'); if (!canRead(m.mode)) throw NOT_AVAILABLE(); if (write && !canWrite(m.mode)) throw READ_ONLY(); return m; };
  const loadT = async (c: Db, wid: string, id: string, lock = false) => {
    const t = (await c.query(`select id, name, format, status, is_public, created_at, updated_at from tournaments where id = $1 and workspace_id = $2${lock ? ' for update' : ''}`, [id, wid])).rows[0];
    if (!t || t.format !== 'pinball') throw notFound('Turneringen hittades inte.');
    return t as { id: string; status: 'draft' | 'running' | 'finished'; format: string };
  };
  const stageOf = async (c: Db, tid: string, sid: string) => { const s = (await c.query('select id, no, kind, name, config, status, current_round, final_ranking, rng_seed from pinball_stages where id = $1 and tournament_id = $2', [sid, tid])).rows[0] as Stage | undefined; if (!s) throw notFound('Steget hittades inte.'); return s; };
  const log = (c: Parameters<typeof audit>[0], req: { id: string; customer?: { userId: string } | undefined }, action: string, wid: string, id: string, meta: Record<string, unknown> = {}) =>
    audit(c, { requestId: req.id }, { action: `tournament.pinball.${action}`, workspaceId: wid, userId: req.customer!.userId, targetType: 'tournament', targetId: id, meta: { by: 'customer', ...meta } });
  const write = async (req: any, fn: (c: Db, p: any, t: Awaited<ReturnType<typeof loadT>>) => Promise<unknown>, shape: z.ZodType<any> = z.object({ wid: uuid, id: uuid })) => {
    const p = shape.parse(req.params); await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => { await guard(c, p.wid, true); const t = await loadT(c, p.wid, p.id, true); if (t.status === 'finished') throw conflict('TOURNAMENT_FINISHED', 'Turneringen är avslutad.'); return fn(c, p, t); });
  };
  const P = z.object({ wid: uuid, id: uuid });

  app.get(base, { preHandler: authed }, async (req) => {
    const p = P.parse(req.params); const role = await requireMember(req, p.wid);
    return withWorkspace(p.wid, async (c) => { const m = await guard(c, p.wid, false); const t = await loadT(c, p.wid, p.id); return { ...(await pinballView(c, t)), canManage: role !== 'member' && canWrite(m.mode) }; });
  });

  // ---- spelare ----
  /** Lägger till spelare (manuellt eller ur medlemsregistret). Före start: alltid. Efter start: bara i första steget om det är kval, matchplay eller Swiss. */
  const addPlayers = async (c: Db, req: any, p: any, t: { status: string }, inputNames: string[], source: 'manual' | 'members') => {
      let lateStage: Stage | null = null;
      if (t.status !== 'draft') {
        const running = (await c.query("select id, no, kind, name, config, status, current_round, final_ranking, rng_seed from pinball_stages where tournament_id = $1 and status = 'running'", [p.id])).rows[0] as Stage | undefined;
        const first = (await c.query('select min(no)::int as n from pinball_stages where tournament_id = $1', [p.id])).rows[0].n as number;
        if (!running || running.no !== first || !['best_game', 'matchplay', 'swiss'].includes(running.kind)) throw conflict('LATE_ENTRY_NOT_ALLOWED', 'Sena anmälningar går bara i första steget när det är kval, matchplay eller Swiss och pågår. De går med från nästa omgång.');
        lateStage = running;
      }
      const list = [...new Map(inputNames.map((n) => [n.toLowerCase(), n])).values()];
      const cur = (await c.query('select lower(name) as n, seed from pinball_players where tournament_id = $1', [p.id])).rows as Array<{ n: string; seed: number }>;
      if (cur.length + list.length > MAX_PLAYERS) throw conflict('TOO_MANY_PLAYERS', `Högst ${MAX_PLAYERS} spelare.`);
      const dup = list.filter((n) => cur.some((x) => x.n === n.toLowerCase())); if (dup.length) throw conflict('PLAYER_EXISTS', `Finns redan: ${dup.join(', ')}`, { names: dup });
      let seed = Math.max(0, ...cur.map((x) => x.seed));
      const newIds: string[] = [];
      for (const n of list) newIds.push((await c.query('insert into pinball_players (workspace_id, tournament_id, name, seed) values ($1,$2,$3,$4) returning id', [p.wid, p.id, n, ++seed])).rows[0].id);
      if (lateStage) { lateStage.config._players = [...(lateStage.config._players as string[]), ...newIds]; await c.query('update pinball_stages set config = $2 where id = $1', [lateStage.id, JSON.stringify(lateStage.config)]); }
      await log(c, req, 'players_added', p.wid, p.id, { count: list.length, late: !!lateStage, source }); return { added: list.length };
  };
  app.post(`${base}/players`, { preHandler: authed }, async (req, reply: FastifyReply) => {
    const b = names.parse(req.body); const r = await write(req, (c, p, t) => addPlayers(c, req, p, t, b.names, 'manual')); return reply.code(201).send(r);
  });
  const requireMembers = async (c: Db, wid: string) => { const m = await modeFor(c, wid); if (!canRead(m.mode)) throw forbidden('Föreningsportalen är inte aktiverad, så medlemsregistret kan inte användas.', 'MEMBERS_NOT_AVAILABLE'); };
  // Medlemsregistret som källa: bara namn kopieras (aldrig e-post, telefon eller anteckningar). Namnen blir publika om turneringen visas publikt.
  app.get(`${base}/member-candidates`, { preHandler: authed }, async (req) => {
    const p = P.parse(req.params); await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => { await guard(c, p.wid, false); await loadT(c, p.wid, p.id); await requireMembers(c, p.wid);
      const rows = (await c.query(`select m.id, m.name from association_members m where m.workspace_id = $1 and m.status = 'active' and not exists (select 1 from pinball_players x where x.tournament_id = $2 and lower(x.name) = lower(m.name)) order by lower(m.name), m.id limit 1000`, [p.wid, p.id])).rows;
      return { items: camelAll(rows) }; });
  });
  app.post(`${base}/players/from-members`, { preHandler: authed }, async (req, reply: FastifyReply) => {
    const b = z.object({ memberIds: z.array(uuid).min(1).max(MAX_PLAYERS) }).strict().parse(req.body);
    const r = await write(req, async (c, p, t) => {
      await requireMembers(c, p.wid); const ids = [...new Set(b.memberIds)];
      const rows = (await c.query(`select id, name from association_members where workspace_id = $1 and status = 'active' and id = any($2) order by lower(name), id`, [p.wid, ids])).rows as Array<{ id: string; name: string }>;
      if (rows.length !== ids.length) throw conflict('MEMBER_NOT_FOUND', 'Någon av medlemmarna finns inte eller är inte aktiv.');
      return addPlayers(c, req, p, t, rows.map((x) => x.name.trim().slice(0, 100)), 'members');
    });
    return reply.code(201).send(r);
  });
  app.patch(`${base}/players/:pid`, { preHandler: authed }, async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(100).optional(), withdrawn: z.boolean().optional() }).strict().refine((x) => Object.keys(x).length > 0).parse(req.body);
    return write(req, async (c, p) => {
      try { const r = await c.query('update pinball_players set name = coalesce($3, name), withdrawn = coalesce($4, withdrawn) where id = $1 and tournament_id = $2 returning id', [p.pid, p.id, b.name ?? null, b.withdrawn ?? null]); if (!r.rowCount) throw notFound('Spelaren hittades inte.'); }
      catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('PLAYER_EXISTS', 'Det finns redan en spelare med det namnet.'); throw e; }
      await log(c, req, 'player_updated', p.wid, p.id, b.withdrawn !== undefined ? { withdrawn: b.withdrawn } : {}); return { ok: true };
    }, P.extend({ pid: uuid }));
  });
  app.delete(`${base}/players/:pid`, { preHandler: authed }, async (req) => write(req, async (c, p, t) => {
    if (t.status !== 'draft') throw conflict('TOURNAMENT_STARTED', 'Spelare kan bara tas bort innan turneringen startat. Markera i stället som utgången.');
    const r = await c.query('delete from pinball_players where id = $1 and tournament_id = $2', [p.pid, p.id]); if (!r.rowCount) throw notFound('Spelaren hittades inte.');
    await log(c, req, 'player_removed', p.wid, p.id); return { ok: true };
  }, P.extend({ pid: uuid })));
  app.put(`${base}/players/order`, { preHandler: authed }, async (req) => {
    const b = z.object({ order: z.array(uuid).min(1).max(MAX_PLAYERS) }).strict().parse(req.body);
    return write(req, async (c, p, t) => {
      if (t.status !== 'draft') throw conflict('TOURNAMENT_STARTED', 'Seedning kan bara ändras innan turneringen startat.');
      const cur = (await c.query('select id from pinball_players where tournament_id = $1', [p.id])).rows.map((x: any) => x.id as string);
      if (new Set(b.order).size !== b.order.length || b.order.length !== cur.length || !b.order.every((x) => cur.includes(x))) throw conflict('INVALID_ORDER', 'Ordningen måste innehålla alla spelare exakt en gång.');
      await c.query('update pinball_players set seed = seed + 100000 where tournament_id = $1', [p.id]);
      for (const [i, id] of b.order.entries()) await c.query('update pinball_players set seed = $2 where id = $1', [id, i + 1]);
      await log(c, req, 'players_reordered', p.wid, p.id); return { ok: true };
    });
  });

  // ---- maskiner ----
  app.post(`${base}/machines`, { preHandler: authed }, async (req, reply: FastifyReply) => {
    const b = names.parse(req.body);
    const r = await write(req, async (c, p) => {
      const cur = (await c.query('select lower(name) as n, sort from pinball_machines where tournament_id = $1', [p.id])).rows as Array<{ n: string; sort: number }>;
      const list = [...new Map(b.names.map((n) => [n.toLowerCase(), n])).values()];
      if (cur.length + list.length > MAX_MACHINES) throw conflict('TOO_MANY_MACHINES', `Högst ${MAX_MACHINES} maskiner.`);
      const dup = list.filter((n) => cur.some((x) => x.n === n.toLowerCase())); if (dup.length) throw conflict('MACHINE_EXISTS', `Finns redan: ${dup.join(', ')}`, { names: dup });
      let sort = Math.max(0, ...cur.map((x) => x.sort)); for (const n of list) await c.query('insert into pinball_machines (workspace_id, tournament_id, name, sort) values ($1,$2,$3,$4)', [p.wid, p.id, n, ++sort]);
      await log(c, req, 'machines_added', p.wid, p.id, { count: list.length }); return { added: list.length };
    });
    return reply.code(201).send(r);
  });
  app.patch(`${base}/machines/:mid`, { preHandler: authed }, async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(100).optional(), active: z.boolean().optional() }).strict().refine((x) => Object.keys(x).length > 0).parse(req.body);
    return write(req, async (c, p) => {
      try { const r = await c.query('update pinball_machines set name = coalesce($3, name), active = coalesce($4, active) where id = $1 and tournament_id = $2 returning id', [p.mid, p.id, b.name ?? null, b.active ?? null]); if (!r.rowCount) throw notFound('Maskinen hittades inte.'); }
      catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('MACHINE_EXISTS', 'Det finns redan en maskin med det namnet.'); throw e; }
      await log(c, req, 'machine_updated', p.wid, p.id, b.active !== undefined ? { active: b.active } : {}); return { ok: true };
    }, P.extend({ mid: uuid }));
  });
  app.delete(`${base}/machines/:mid`, { preHandler: authed }, async (req) => write(req, async (c, p) => {
    const used = (await c.query('select 1 from pinball_games where machine_id = $1 union all select 1 from pinball_attempts where machine_id = $1 limit 1', [p.mid])).rowCount;
    if (used) throw conflict('MACHINE_IN_USE', 'Maskinen har använts. Markera den som inaktiv i stället.');
    const r = await c.query('delete from pinball_machines where id = $1 and tournament_id = $2', [p.mid, p.id]); if (!r.rowCount) throw notFound('Maskinen hittades inte.');
    await log(c, req, 'machine_removed', p.wid, p.id); return { ok: true };
  }, P.extend({ mid: uuid })));

  // ---- steg ----
  app.post(`${base}/stages`, { preHandler: authed }, async (req, reply: FastifyReply) => {
    const b = stageBody.parse(req.body);
    const r = await write(req, async (c, p) => {
      const cur = (await c.query('select no from pinball_stages where tournament_id = $1', [p.id])).rows as Array<{ no: number }>;
      if (cur.length >= MAX_STAGES) throw conflict('TOO_MANY_STAGES', `Högst ${MAX_STAGES} steg.`);
      const row = (await c.query('insert into pinball_stages (workspace_id, tournament_id, no, kind, name, config) values ($1,$2,$3,$4,$5,$6) returning id, no, kind, name, status', [p.wid, p.id, Math.max(0, ...cur.map((x) => x.no)) + 1, b.kind, b.name ?? KIND_NAME[b.kind], JSON.stringify(b.config)])).rows[0];
      await log(c, req, 'stage_added', p.wid, p.id, { kind: b.kind }); return camelAll([row])[0];
    });
    return reply.code(201).send(r);
  });
  app.delete(`${base}/stages/:sid`, { preHandler: authed }, async (req) => write(req, async (c, p) => {
    const s = await stageOf(c, p.id, p.sid); if (s.status !== 'pending') throw conflict('STAGE_STARTED', 'Ett påbörjat steg kan inte tas bort.');
    await c.query('delete from pinball_stages where id = $1', [p.sid]); await log(c, req, 'stage_removed', p.wid, p.id); return { ok: true };
  }, P.extend({ sid: uuid })));

  const history = async (c: Db, stageId: string) => {
    const h: History = new Map(); const played = new Map<string, Map<string, number>>();
    const gs = (await c.query('select g.id, gm.machine_id from pinball_groups g left join pinball_games gm on gm.group_id = g.id where g.stage_id = $1', [stageId])).rows as Array<{ id: string; machine_id: string | null }>;
    const gp = gs.length ? (await c.query('select group_id, player_id from pinball_group_players where group_id = any($1)', [gs.map((x) => x.id)])).rows as Array<{ group_id: string; player_id: string }> : [];
    const seenG = new Set<string>(); for (const g of gs) { const ids = gp.filter((x) => x.group_id === g.id).map((x) => x.player_id); if (!seenG.has(g.id)) { seenG.add(g.id); if (ids.length === 1) { const m = h.get(ids[0]!) ?? new Map<string, number>(); m.set('\0bye', 1); h.set(ids[0]!, m); } else addHistory(h, ids); } if (g.machine_id) for (const id of ids) { const m = played.get(id) ?? new Map<string, number>(); m.set(g.machine_id, (m.get(g.machine_id) ?? 0) + 1); played.set(id, m); } }
    return { h, played };
  };
  const insertGroup = async (c: Db, wid: string, stageId: string, round: number, slot: number, ids: string[], machine: string | null | Array<string | null>, key: string | null = null, bye?: { points: number }) => {
    const g = (await c.query('insert into pinball_groups (workspace_id, stage_id, round, slot, bracket_key) values ($1,$2,$3,$4,$5) returning id', [wid, stageId, round, slot, key])).rows[0];
    for (const [i, pid] of ids.entries()) await c.query('insert into pinball_group_players (workspace_id, group_id, player_id, seat) values ($1,$2,$3,$4)', [wid, g.id, pid, i + 1]);
    const machs = Array.isArray(machine) ? machine : [machine]; let gm: { id: string } = { id: '' };
    for (const [i, mid] of machs.entries()) gm = (await c.query('insert into pinball_games (workspace_id, group_id, game_no, machine_id, status) values ($1,$2,$3,$4,$5) returning id', [wid, g.id, i + 1, mid, bye ? 'done' : 'pending'])).rows[0];
    if (bye) await c.query('insert into pinball_scores (workspace_id, game_id, player_id, score, placement, points) values ($1,$2,$3,0,1,$4)', [wid, gm.id, ids[0], bye.points]);
  };
  const activeMachines = async (c: Db, tid: string) => (await c.query('select id from pinball_machines where tournament_id = $1 and active order by sort, id', [tid])).rows.map((x: any) => x.id as string);
  const standingOrder = async (c: Db, tid: string, s: Stage) => {
    const v = await pinballView(c, { id: tid }); const st = v.stages.find((x) => x.id === s.id) as any; return (st.standings as Array<{ playerId: string }>).map((r) => r.playerId);
  };

  async function genRound(c: Db, wid: string, tid: string, s: Stage, round: number, order: string[]) {
    const ids = order.filter((x) => (s.config._players as string[]).includes(x));
    const live = new Set((await c.query('select id from pinball_players where tournament_id = $1 and not withdrawn', [tid])).rows.map((x: any) => x.id as string));
    const active = ids.filter((x) => live.has(x)); if (active.length < 2) throw conflict('TOO_FEW_PLAYERS', 'Minst två aktiva spelare krävs.');
    const rng = rngFrom(s.rng_seed + round * 7919); const { h, played } = await history(c, s.id); const machines = await activeMachines(c, tid); const T = table(s);
    let groups: string[][]; let byes: string[] = [];
    if (s.kind === 'swiss') { const r = swissRound(active, h, s.config.groupSize, rng); groups = r.groups; byes = r.byes; }
    else if (s.kind === 'group_knockout') groups = assignGroups(active, active.length <= s.config.groupSize ? [active.length] : groupSizes(active.length, s.config.groupSize), h, 'balanced', rng);
    else groups = assignGroups(active, groupSizes(active.length, s.config.groupSize), h, round === 1 && s.config.grouping === 'random' ? 'random' : s.config.grouping === 'balanced' ? 'balanced' : 'random', rng);
    const perGame = s.kind === 'group_knockout' ? (s.config.gamesPerGroup as number) : 1; const msByGame: string[][] = [];
    for (let k = 0; k < perGame; k++) { const ms = assignMachines(groups, machines, played, round + k); msByGame.push(ms); groups.forEach((g, i) => { for (const pid of g) { const m = played.get(pid) ?? new Map<string, number>(); m.set(ms[i]!, (m.get(ms[i]!) ?? 0) + 1); played.set(pid, m); } }); }
    for (const [i, g] of groups.entries()) await insertGroup(c, wid, s.id, round, i, g, msByGame.map((x) => x[i] || null));
    for (const [i, b] of byes.entries()) await insertGroup(c, wid, s.id, round, groups.length + i, [b], null, null, { points: T[2][0]! });
    await c.query('update pinball_stages set current_round = $2 where id = $1', [s.id, round]);
  }

  async function participants(c: Db, tid: string, s: Stage): Promise<string[]> {
    if (s.no === (await c.query('select min(no)::int as n from pinball_stages where tournament_id = $1', [tid])).rows[0].n) return (await c.query('select id from pinball_players where tournament_id = $1 and not withdrawn order by seed, id', [tid])).rows.map((x: any) => x.id);
    const prev = (await c.query('select config, final_ranking from pinball_stages where tournament_id = $1 and no < $2 order by no desc limit 1', [tid, s.no])).rows[0];
    const live = new Set((await c.query('select id from pinball_players where tournament_id = $1 and not withdrawn', [tid])).rows.map((x: any) => x.id as string));
    const ranked = ((prev.final_ranking ?? []) as Array<{ playerId: string; rank: number }>).filter((x) => live.has(x.playerId));
    const take = prev.config.advance as number | undefined; return (take ? ranked.slice(0, take) : ranked).map((x) => x.playerId);
  }

  app.post(`${base}/stages/:sid/start`, { preHandler: authed }, async (req) => write(req, async (c, p, t) => {
    const s = await stageOf(c, p.id, p.sid); if (s.status !== 'pending') throw conflict('STAGE_STARTED', 'Steget är redan startat.');
    const earlier = (await c.query('select 1 from pinball_stages where tournament_id = $1 and no < $2 and status <> \'finished\'', [p.id, s.no])).rowCount; if (earlier) throw conflict('PREVIOUS_STAGE_OPEN', 'Avsluta föregående steg först.');
    const machines = await activeMachines(c, p.id); if (!machines.length) throw conflict('NO_MACHINES', 'Lägg till minst en aktiv maskin först.');
    const order = await participants(c, p.id, s); const min = s.kind === 'double_elim' ? 3 : s.kind === 'best_game' ? 1 : 2;
    if (order.length < min) throw conflict('TOO_FEW_PLAYERS', `Minst ${min} spelare krävs för det här steget.`);
    s.config._players = order; await c.query("update pinball_stages set status = 'running', config = $2 where id = $1", [s.id, JSON.stringify(s.config)]);
    if (t.status === 'draft') await c.query("update tournaments set status = 'running', updated_at = now() where id = $1", [p.id]);
    if (s.kind === 'matchplay' || s.kind === 'swiss' || s.kind === 'group_knockout') await genRound(c, p.wid, p.id, s, 1, order);
    else if (s.kind === 'round_robin') {
      const fx = roundRobin(order, s.config.doubleRound); const { played } = await history(c, s.id); let maxR = 0;
      for (const r of [...new Set(fx.map((f) => f.round))]) { const round = fx.filter((f) => f.round === r); const ms = assignMachines(round.map((f) => [f.home, f.away]), machines, played, r); for (const [i, f] of round.entries()) { await insertGroup(c, p.wid, s.id, r, i, [f.home, f.away], ms[i] || null); for (const id of [f.home, f.away]) { const m = played.get(id) ?? new Map<string, number>(); m.set(ms[i]!, (m.get(ms[i]!) ?? 0) + 1); played.set(id, m); } } maxR = r; }
      await c.query('update pinball_stages set current_round = $2 where id = $1', [s.id, maxR]);
    } else if (s.kind === 'single_elim' || s.kind === 'double_elim') {
      for (const n of nodesOf(s)) await insertGroup(c, p.wid, s.id, bracketRound(n), n.pos, [], null, n.key).then(async () => { /* inga spel förrän spelarna är kända */ });
      await c.query("delete from pinball_games where group_id in (select id from pinball_groups where stage_id = $1)", [s.id]); await syncBracket(c, p.wid, p.id, { ...s, status: 'running' });
    }
    await log(c, req, 'stage_started', p.wid, p.id, { kind: s.kind, players: order.length }); return { ok: true };
  }, P.extend({ sid: uuid })));

  /** Skapar spel för matcher som blivit spelbara och tar bort oresultatade spel för dem som inte längre är det. */
  async function syncBracket(c: Db, wid: string, tid: string, s: Stage) {
    const ids = s.config._players as string[]; const nodes = nodesOf(s); const machines = await activeMachines(c, tid);
    const groups = (await c.query('select id, round, slot, bracket_key from pinball_groups where stage_id = $1', [s.id])).rows as Array<{ id: string; round: number; slot: number; bracket_key: string }>;
    const games = (await c.query('select id, group_id, game_no, status from pinball_games where group_id = any($1)', [groups.map((g) => g.id)])).rows as Array<{ id: string; group_id: string; game_no: number; status: string }>;
    const scores = games.length ? (await c.query('select game_id, player_id, placement from pinball_scores where game_id = any($1)', [games.map((g) => g.id)])).rows as Array<{ game_id: string; player_id: string; placement: number }> : [];
    const state = evaluateBracket(nodes, ids, winnersOf(s, groups, games, scores));
    for (const g of groups) {
      const st = state.get(g.bracket_key)!; const mine = games.filter((x) => x.group_id === g.id);
      if (st.status === 'ready') { for (let n = mine.length + 1; n <= (s.config.bestOf ?? 1); n++) await c.query('insert into pinball_games (workspace_id, group_id, game_no, machine_id) values ($1,$2,$3,$4)', [wid, g.id, n, machines.length ? machines[(g.slot + n - 1 + g.round) % machines.length] : null]); }
      else for (const gm of mine) if (!scores.some((x) => x.game_id === gm.id)) await c.query('delete from pinball_games where id = $1', [gm.id]);
    }
    return state;
  }

  app.post(`${base}/stages/:sid/next-round`, { preHandler: authed }, async (req) => write(req, async (c, p) => {
    const s = await stageOf(c, p.id, p.sid); if (s.status !== 'running' || (s.kind !== 'matchplay' && s.kind !== 'swiss' && s.kind !== 'group_knockout')) throw conflict('NOT_APPLICABLE', 'Steget har inga omgångar att generera.');
    if (s.kind !== 'group_knockout' && s.current_round >= s.config.rounds) throw conflict('LAST_ROUND', 'Alla omgångar är redan skapade.');
    const open = (await c.query(`select 1 from pinball_games gm join pinball_groups g on g.id = gm.group_id where g.stage_id = $1 and g.round = $2 and gm.status <> 'done' limit 1`, [s.id, s.current_round])).rowCount;
    if (open) throw conflict('ROUND_NOT_DONE', 'Alla matcher i den pågående omgången måste vara klara.');
    if (s.kind === 'group_knockout') {
      const st = (await pinballView(c, { id: p.id })).stages.find((x) => x.id === s.id) as any; const last = st.groupResults[st.groupResults.length - 1];
      if (last.groups.length === 1) throw conflict('LAST_ROUND', 'Finalgruppen är redan skapad.');
      const adv = (last.groups as any[]).flatMap((g) => (g.rows as any[]).filter((r) => r.advances)).sort((a, b) => a.rank - b.rank || b.points - a.points || (s.config._players as string[]).indexOf(a.playerId) - (s.config._players as string[]).indexOf(b.playerId)).map((r) => r.playerId as string);
      await genRound(c, p.wid, p.id, s, s.current_round + 1, adv);
    } else await genRound(c, p.wid, p.id, s, s.current_round + 1, await standingOrder(c, p.id, s)); await log(c, req, 'round_generated', p.wid, p.id, { round: s.current_round + 1 }); return { round: s.current_round + 1 };
  }, P.extend({ sid: uuid })));

  app.post(`${base}/stages/:sid/finish`, { preHandler: authed }, async (req) => write(req, async (c, p) => {
    const s = await stageOf(c, p.id, p.sid); if (s.status !== 'running') throw conflict('NOT_RUNNING', 'Steget pågår inte.');
    const v = await pinballView(c, { id: p.id }); const st = v.stages.find((x) => x.id === s.id) as any; let ranking: Array<{ playerId: string; rank: number }>;
    if (s.kind === 'best_game') ranking = (st.ranking as Array<{ playerId: string; rank: number }>).map((x) => ({ playerId: x.playerId, rank: x.rank }));
    else {
      const open = (st.groups as any[]).some((g) => ['ready', 'playing'].includes(g.status)); if (open) throw conflict('MATCHES_OPEN', 'Alla matcher måste vara klara.');
      if (s.kind === 'matchplay' || s.kind === 'swiss') { if (s.current_round < s.config.rounds) throw conflict('ROUNDS_LEFT', 'Alla omgångar måste spelas.'); }
      if (s.kind === 'group_knockout') { if (!st.placements) throw conflict('ROUNDS_LEFT', 'Spela klart omgångarna till och med finalgruppen först.'); ranking = st.placements; }
      else if (s.kind === 'single_elim' || s.kind === 'double_elim') { if (!st.placements) throw conflict('MATCHES_OPEN', 'Utslagningen är inte avgjord.'); ranking = st.placements; }
      else ranking = (st.standings as Array<{ playerId: string; rank: number }>).map((x) => ({ playerId: x.playerId, rank: x.rank }));
    }
    await c.query("update pinball_stages set status = 'finished', final_ranking = $2 where id = $1", [s.id, JSON.stringify(ranking)]); await log(c, req, 'stage_finished', p.wid, p.id, { kind: s.kind }); return { ok: true, ranking };
  }, P.extend({ sid: uuid })));

  app.post(`${base}/finish`, { preHandler: authed }, async (req) => write(req, async (c, p) => {
    const st = (await c.query('select status from pinball_stages where tournament_id = $1', [p.id])).rows as Array<{ status: string }>;
    if (!st.length || st.some((x) => x.status !== 'finished')) throw conflict('STAGES_OPEN', 'Alla steg måste vara avslutade (och minst ett skapat).');
    await c.query("update tournaments set status = 'finished', updated_at = now() where id = $1", [p.id]); await log(c, req, 'finished', p.wid, p.id); return { ok: true };
  }));

  // ---- resultat ----
  const loadGame = async (c: Db, tid: string, gid: string) => {
    const g = (await c.query(`select gm.id, gm.group_id, gm.game_no, gm.machine_id, gm.status, g.stage_id, g.round, g.bracket_key from pinball_games gm join pinball_groups g on g.id = gm.group_id join pinball_stages s on s.id = g.stage_id where gm.id = $1 and s.tournament_id = $2`, [gid, tid])).rows[0] as { id: string; group_id: string; game_no: number; machine_id: string | null; status: string; stage_id: string; round: number; bracket_key: string | null } | undefined;
    if (!g) throw notFound('Spelet hittades inte.'); const s = await stageOf(c, tid, g.stage_id); if (s.status !== 'running') throw conflict('STAGE_NOT_RUNNING', 'Steget pågår inte.'); return { g, s };
  };
  const gamePlayers = async (c: Db, wid: string, tid: string, g: { group_id: string; bracket_key: string | null }, s: Stage): Promise<string[]> => {
    if (!g.bracket_key) return (await c.query('select player_id from pinball_group_players where group_id = $1 order by seat', [g.group_id])).rows.map((x: any) => x.player_id);
    const st = (await syncBracket(c, wid, tid, s)).get(g.bracket_key)!; if (st.status !== 'ready' && st.status !== 'done') throw conflict('MATCH_NOT_READY', 'Matchen har inte två kända spelare ännu.');
    return [st.home!, st.away!];
  };
  const lockedBy = async (c: Db, s: Stage, g: { round: number; bracket_key: string | null }) => {
    if (s.kind === 'round_robin') return false; // alla omgångar skapas direkt och påverkar inte varandra
    if (!g.bracket_key) return s.current_round > g.round;
    const deps = nodesOf(s).filter((n) => ['home', 'away'].some((k) => { const src = (n as any)[k]; return (src.win ?? src.lose) === g.bracket_key; })).map((n) => n.key);
    if (!deps.length) return false;
    return !!(await c.query(`select 1 from pinball_scores sc join pinball_games gm on gm.id = sc.game_id join pinball_groups x on x.id = gm.group_id where x.stage_id = $1 and x.bracket_key = any($2) limit 1`, [s.id, deps])).rowCount;
  };

  app.put(`${base}/games/:gid/scores`, { preHandler: authed }, async (req) => {
    const b = scoreIn.parse(req.body);
    return write(req, async (c, p) => {
      const { g, s } = await loadGame(c, p.id, p.gid); if (await lockedBy(c, s, g)) throw conflict('RESULT_LOCKED', 'Resultatet kan inte ändras eftersom nästa omgång/match redan har resultat.');
      const pl = await gamePlayers(c, p.wid, p.id, g, s); const given = b.scores.map((x) => x.playerId);
      if (new Set(given).size !== given.length || given.length !== pl.length || !given.every((x) => pl.includes(x))) throw conflict('SCORES_MISMATCH', 'Ange poäng för exakt de spelare som ingår i matchen.', { expected: pl });
      const aw = awardPoints(b.scores.map((x) => ({ id: x.playerId, score: x.score })), table(s))!;
      if (g.bracket_key && aw.filter((x) => x.placement === 1).length !== 1) throw conflict('TIE_NOT_ALLOWED', 'Oavgjort är inte tillåtet i utslagning.');
      await c.query('delete from pinball_scores where game_id = $1', [g.id]);
      for (const x of aw) await c.query('insert into pinball_scores (workspace_id, game_id, player_id, score, placement, points) values ($1,$2,$3,$4,$5,$6)', [p.wid, g.id, x.id, b.scores.find((y) => y.playerId === x.id)!.score, x.placement, x.points]);
      await c.query("update pinball_games set status = 'done', updated_at = now() where id = $1", [g.id]);
      if (g.bracket_key) await syncBracket(c, p.wid, p.id, s);
      await log(c, req, 'game_scored', p.wid, p.id, { gameId: g.id }); return { ok: true };
    }, P.extend({ gid: uuid }));
  });
  app.delete(`${base}/games/:gid/scores`, { preHandler: authed }, async (req) => write(req, async (c, p) => {
    const { g, s } = await loadGame(c, p.id, p.gid); if (await lockedBy(c, s, g)) throw conflict('RESULT_LOCKED', 'Resultatet kan inte ändras eftersom nästa omgång/match redan har resultat.');
    await c.query('delete from pinball_scores where game_id = $1', [g.id]); await c.query("update pinball_games set status = 'pending', updated_at = now() where id = $1", [g.id]);
    if (g.bracket_key) await syncBracket(c, p.wid, p.id, s); await log(c, req, 'game_cleared', p.wid, p.id, { gameId: g.id }); return { ok: true };
  }, P.extend({ gid: uuid })));
  app.patch(`${base}/games/:gid`, { preHandler: authed }, async (req) => {
    const b = z.object({ machineId: uuid.nullable().optional(), status: z.enum(['pending', 'playing']).optional() }).strict().refine((x) => Object.keys(x).length > 0).parse(req.body);
    return write(req, async (c, p) => {
      const { g, s } = await loadGame(c, p.id, p.gid); if (g.status === 'done') throw conflict('GAME_DONE', 'Spelet är redan avgjort.');
      if (g.bracket_key) { const st = (await syncBracket(c, p.wid, p.id, s)).get(g.bracket_key)!; if (st.status !== 'ready') throw conflict('MATCH_NOT_READY', 'Matchen har inte två kända spelare ännu.'); }
      const machine = b.machineId === undefined ? g.machine_id : b.machineId;
      if (b.machineId) { const m = (await c.query('select active from pinball_machines where id = $1 and tournament_id = $2', [b.machineId, p.id])).rows[0]; if (!m) throw notFound('Maskinen hittades inte.'); if (!m.active) throw conflict('MACHINE_INACTIVE', 'Maskinen är inaktiv.'); }
      if (b.status === 'playing') {
        if (!machine) throw conflict('NO_MACHINE', 'Välj maskin innan matchen startas.');
        const busy = (await c.query(`select m.name from pinball_games gm join pinball_groups x on x.id = gm.group_id join pinball_stages s on s.id = x.stage_id join pinball_machines m on m.id = gm.machine_id where s.tournament_id = $1 and gm.machine_id = $2 and gm.status = 'playing' and gm.id <> $3`, [p.id, machine, g.id])).rows[0];
        if (busy) throw conflict('MACHINE_BUSY', `${busy.name} används redan av en annan match.`);
      }
      await c.query('update pinball_games set machine_id = $2, status = coalesce($3, status), updated_at = now() where id = $1', [g.id, machine, b.status ?? null]); return { ok: true };
    }, P.extend({ gid: uuid }));
  });

  // ---- kval med försök ----
  app.post(`${base}/stages/:sid/attempts`, { preHandler: authed }, async (req, reply: FastifyReply) => {
    const b = z.object({ playerId: uuid, machineId: uuid, score: z.number().int().min(0).max(9_999_999_999_999) }).strict().parse(req.body);
    const r = await write(req, async (c, p) => {
      const s = await stageOf(c, p.id, p.sid); if (s.kind !== 'best_game' || s.status !== 'running') throw conflict('NOT_APPLICABLE', 'Steget tar inte emot försök just nu.');
      if (!(s.config._players as string[]).includes(b.playerId)) throw conflict('NOT_IN_STAGE', 'Spelaren deltar inte i steget.');
      const m = (await c.query('select active from pinball_machines where id = $1 and tournament_id = $2', [b.machineId, p.id])).rows[0]; if (!m) throw notFound('Maskinen hittades inte.'); if (!m.active) throw conflict('MACHINE_INACTIVE', 'Maskinen är inaktiv.');
      const n = (await c.query('select count(*)::int as n from pinball_attempts where stage_id = $1 and player_id = $2', [s.id, b.playerId])).rows[0].n as number;
      if (s.config.maxAttempts && n >= s.config.maxAttempts) throw conflict('ATTEMPTS_EXHAUSTED', `Spelaren har redan ${s.config.maxAttempts} försök.`);
      const row = (await c.query('insert into pinball_attempts (workspace_id, stage_id, player_id, machine_id, score) values ($1,$2,$3,$4,$5) returning id', [p.wid, s.id, b.playerId, b.machineId, b.score])).rows[0];
      await log(c, req, 'attempt_added', p.wid, p.id, { stageId: s.id }); return { id: row.id };
    }, P.extend({ sid: uuid }));
    return reply.code(201).send(r);
  });
  app.delete(`${base}/stages/:sid/attempts/:aid`, { preHandler: authed }, async (req) => write(req, async (c, p) => {
    const s = await stageOf(c, p.id, p.sid); if (s.status !== 'running') throw conflict('NOT_RUNNING', 'Steget pågår inte.');
    const r = await c.query('delete from pinball_attempts where id = $1 and stage_id = $2', [p.aid, s.id]); if (!r.rowCount) throw notFound('Försöket hittades inte.');
    await log(c, req, 'attempt_removed', p.wid, p.id); return { ok: true };
  }, P.extend({ sid: uuid, aid: uuid })));
}
