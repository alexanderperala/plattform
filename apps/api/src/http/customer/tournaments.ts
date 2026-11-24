import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { withWorkspace } from '../../db/pool.js';
import { camelAll } from '../../lib/camel.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { evaluateLimits } from '../../services/access.js';
import { canCreate, canRead, canWrite } from '../../domain/access.js';
import { knockout, nextSlot, qualifierSeeds, roundRobin, snakeGroups, standings } from '../../domain/tournament.js';
import { pinballView } from './pinball.js';
import { csvCell, modeFor, type Helpers } from './association.js';
import { forbidden } from '../../lib/errors.js';

const uuid = z.string().uuid();
const NOT_AVAILABLE = () => forbidden('Turneringssystemet är inte aktiverat för den här arbetsytan.', 'PRODUCT_NOT_AVAILABLE');
const READ_ONLY = () => forbidden('Arbetsytan eller produkten är skrivskyddad. Kontakta er administratör eller supporten.', 'WORKSPACE_READ_ONLY');
const create = z.object({ name: z.string().trim().min(1).max(200), format: z.enum(['round_robin', 'single_elimination', 'groups_knockout', 'pinball']).default('round_robin'), doubleRound: z.boolean().default(false),
  groupCount: z.union([z.literal(2), z.literal(4), z.literal(8)]).optional(), advancePerGroup: z.union([z.literal(1), z.literal(2)]).optional() })
  .strict().refine((x) => x.format === 'round_robin' || !x.doubleRound, 'Dubbelserie gäller bara serie')
  .refine((x) => x.format === 'groups_knockout' ? x.groupCount !== undefined : x.groupCount === undefined && x.advancePerGroup === undefined, 'Antal grupper anges bara (och krävs) för gruppspel');
const patch = z.object({ name: z.string().trim().min(1).max(200).optional(), doubleRound: z.boolean().optional(), isPublic: z.boolean().optional() }).strict().refine((x) => Object.keys(x).length > 0, 'Ange minst ett fält');
const team = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const score = z.object({ homeScore: z.number().int().min(0).max(999).nullable(), awayScore: z.number().int().min(0).max(999).nullable() }).strict()
  .refine((x) => (x.homeScore === null) === (x.awayScore === null), 'Ange båda resultaten eller ingetdera');
const MAX_TEAMS = 64;

/** Gemensam vy över en turnering (lag, matcher, tabeller, slutspel). Används av både den inloggade och den publika vyn – innehåller bara lagnamn, aldrig personuppgifter. */
export async function tournamentView(c: Parameters<typeof modeFor>[0], t: { id: string; format: string; status: string; group_count: number | null; advance_per_group: number | null; [k: string]: unknown }): Promise<any> {
    if (t.format === 'pinball') return pinballView(c, t);
    const teams = (await c.query('select id, name, group_no from tournament_teams where tournament_id = $1 order by lower(name), id', [t.id])).rows as { id: string; name: string; group_no: number | null }[];
    const matches = (await c.query('select id, round, position, group_no, home_team_id, away_team_id, home_score, away_score, winner_team_id from tournament_matches where tournament_id = $1 order by group_no nulls first, round, position nulls first, id', [t.id])).rows as
      { id: string; round: number; position: number | null; group_no: number | null; home_team_id: string | null; away_team_id: string | null; home_score: number | null; away_score: number | null; winner_team_id: string | null }[];
    const koMatches = matches.filter((x) => x.position !== null); const stageMatches = matches.filter((x) => x.position === null);
    const played = (ms: typeof matches) => ms.filter((x) => x.home_score !== null).map((x) => ({ home: x.home_team_id!, away: x.away_team_id!, homeScore: x.home_score!, awayScore: x.away_score! }));
    const gk = t.format === 'groups_knockout';
    const table = t.format === 'round_robin' ? standings(teams.map((x) => x.id), played(stageMatches)) : [];
    const groups = gk ? Array.from({ length: t.group_count! }, (_, i) => { const ids = teams.filter((x) => x.group_no === i + 1).map((x) => x.id); return { groupNo: i + 1, teamIds: ids, standings: ids.length ? standings(ids, played(stageMatches.filter((x) => x.group_no === i + 1))) : [] }; }) : [];
    const totalRounds = Math.max(0, ...koMatches.map((x) => x.round));
    const final = koMatches.find((x) => x.round === totalRounds);
    const phase = gk ? (t.status === 'draft' ? 'draft' : koMatches.length ? 'knockout' : 'groups') : null;
    return { ...camelAll([t])[0], teams: camelAll(teams), matches: camelAll(matches.map((x) => ({ ...x, bye: x.position !== null && x.round === 1 && x.away_team_id === null }))), standings: table, groups, phase, totalRounds, championTeamId: final?.winner_team_id ?? null };
}

/** Turneringssystem, steg 1: serie (alla möter alla). Läsa: alla medlemmar i arbetsytan. Skriva: ägare/admin. */
export function tournamentRoutes(app: FastifyInstance, { authed, requireMember }: Helpers): void {
  const base = '/workspaces/:wid/tournaments';
  const mode = (c: Parameters<typeof modeFor>[0], wid: string) => modeFor(c, wid, 'tournament_system', 'max_tournaments');
  const mode_ = mode;
  const guard = async (c: Parameters<typeof modeFor>[0], wid: string, write: boolean) => {
    const m = await mode(c, wid);
    if (!canRead(m.mode)) throw NOT_AVAILABLE();
    if (write && !canWrite(m.mode)) throw READ_ONLY();
    return m;
  };
  const load = async (c: Parameters<typeof modeFor>[0], wid: string, id: string, lock = false) => {
    const t = (await c.query(`select id, name, format, double_round, group_count, advance_per_group, status, is_public, created_at, updated_at from tournaments where id = $1 and workspace_id = $2${lock ? ' for update' : ''}`, [id, wid])).rows[0];
    if (!t) throw notFound('Turneringen hittades inte.');
    return t as { is_public: boolean; id: string; name: string; format: 'round_robin' | 'single_elimination' | 'groups_knockout' | 'pinball'; group_count: number | null; advance_per_group: number | null; status: 'draft' | 'running' | 'finished'; double_round: boolean };
  };
  const log = (c: Parameters<typeof audit>[0], req: { id: string; customer?: { userId: string } | undefined }, action: string, wid: string, id: string, meta: Record<string, unknown> = {}) =>
    audit(c, { requestId: req.id }, { action: `tournament.${action}`, workspaceId: wid, userId: req.customer!.userId, targetType: 'tournament', targetId: id, meta: { by: 'customer', ...meta } });

  app.get(base, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const role = await requireMember(req, wid);
    return withWorkspace(wid, async (c) => {
      const m = await guard(c, wid, false);
      const rows = (await c.query(`select t.id, t.name, t.format, t.double_round, t.status, t.is_public, t.created_at,
        (select count(*)::int from tournament_teams x where x.tournament_id = t.id) as team_count,
        (select count(*)::int from pinball_players x where x.tournament_id = t.id) as player_count,
        (select count(*)::int from tournament_matches x where x.tournament_id = t.id and not (x.position is not null and x.round = 1 and x.away_team_id is null)) as match_count,
        (select count(*)::int from tournament_matches x where x.tournament_id = t.id and x.home_score is not null) as played_count
        from tournaments t where t.workspace_id = $1 order by t.created_at desc, t.id`, [wid])).rows;
      return { items: camelAll(rows), canManage: role !== 'member' && canWrite(m.mode) };
    });
  });

  // Export (dataportabilitet, 8.3): alla turneringar med lag och matcher. Tillåten även när arbetsytan är avslutad (export_only).
  app.get(`${base}/export`, { preHandler: authed }, async (req, reply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const q = z.object({ format: z.enum(['csv', 'json']).default('csv') }).parse(req.query);
    await requireMember(req, wid, ['owner', 'admin']);
    const data = await withWorkspace(wid, async (c) => {
      const { mode } = await mode_(c, wid);
      if (mode === 'none') throw NOT_AVAILABLE();
      await audit(c, { requestId: req.id }, { action: 'tournament.exported', workspaceId: wid, userId: req.customer!.userId, meta: { format: q.format, by: 'customer' } });
      const ts = (await c.query('select id, name, format, double_round, group_count, advance_per_group, status, created_at from tournaments where workspace_id = $1 order by created_at, id', [wid])).rows;
      const teams = (await c.query('select id, tournament_id, name, group_no from tournament_teams where workspace_id = $1 order by lower(name), id', [wid])).rows;
      const ms = (await c.query('select tournament_id, round, position, group_no, home_team_id, away_team_id, home_score, away_score, winner_team_id from tournament_matches where workspace_id = $1 order by tournament_id, group_no nulls first, round, position nulls first, id', [wid])).rows;
      return { ts, teams, ms };
    });
    const tname = new Map(data.teams.map((t) => [t.id as string, t.name as string]));
    if (q.format === 'json') return reply.header('content-disposition', 'attachment; filename="turneringar.json"').send({
      items: data.ts.map((t) => ({ ...camelAll([t])[0], teams: camelAll(data.teams.filter((x) => x.tournament_id === t.id)), matches: camelAll(data.ms.filter((m) => m.tournament_id === t.id)) })) });
    const FORMAT: Record<string, string> = { round_robin: 'Serie', single_elimination: 'Utslagning', groups_knockout: 'Gruppspel + slutspel' };
    const STATUS: Record<string, string> = { draft: 'Utkast', running: 'Pågår', finished: 'Avslutad' };
    const head = ['Turnering', 'Format', 'Status', 'Fas', 'Grupp', 'Omgång', 'Hemmalag', 'Bortalag', 'Hemmamål', 'Bortamål', 'Vinnare'];
    const lines = [head.map(csvCell).join(',')];
    for (const t of data.ts) for (const m of data.ms.filter((x) => x.tournament_id === t.id))
      lines.push([t.name, FORMAT[t.format as string], STATUS[t.status as string], m.position !== null ? 'Slutspel' : m.group_no ? 'Grupp' : 'Serie', m.group_no ? String.fromCharCode(64 + m.group_no) : '', m.round,
        tname.get(m.home_team_id) ?? '', tname.get(m.away_team_id) ?? '', m.home_score, m.away_score, tname.get(m.winner_team_id) ?? ''].map(csvCell).join(','));
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="turneringar.csv"').send('﻿' + lines.join('\r\n') + '\r\n');
  });

  app.get(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    const role = await requireMember(req, p.wid);
    return withWorkspace(p.wid, async (c) => {
      const m = await guard(c, p.wid, false);
      const t = await load(c, p.wid, p.id);
      const view = await tournamentView(c, t);
      return { ...view, canManage: role !== 'member' && canWrite(m.mode) };
    });
  });

  app.post(base, { preHandler: authed }, async (req, reply: FastifyReply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = create.parse(req.body);
    await requireMember(req, wid, ['owner', 'admin']);
    const row = await withWorkspace(wid, async (c) => {
      await c.query('select id from workspaces where id = $1 for update', [wid]); // serialiserar gränskontrollen
      const { mode: md, max, used } = await mode(c, wid);
      if (!canRead(md)) throw NOT_AVAILABLE();
      if (!canWrite(md)) throw READ_ONLY();
      if (!canCreate(md) || (max !== null && used + 1 > max)) throw conflict('LIMIT_EXCEEDED', `Gränsen för antal aktiva turneringar${max !== null ? ` (${max})` : ''} är nådd. Avsluta en turnering eller uppgradera abonnemanget.`, { limit: 'max_tournaments', max, used });
      const r = (await c.query('insert into tournaments (workspace_id, name, format, double_round, group_count, advance_per_group, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, name, format, double_round, group_count, advance_per_group, status, created_at', [wid, b.name, b.format, b.doubleRound, b.format === 'groups_knockout' ? b.groupCount! : null, b.format === 'groups_knockout' ? (b.advancePerGroup ?? 2) : null, req.customer!.userId])).rows[0];
      await log(c, req, 'created', wid, r.id);
      await evaluateLimits(c, wid);
      return r;
    });
    return reply.code(201).send(camelAll([row])[0]);
  });

  app.patch(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    const b = patch.parse(req.body);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      const t = await load(c, p.wid, p.id, true);
      if (b.doubleRound !== undefined && t.format !== 'round_robin') throw conflict('NOT_APPLICABLE', 'Dubbelserie gäller bara serie.');
      if (b.doubleRound !== undefined && t.status !== 'draft') throw conflict('TOURNAMENT_LOCKED', 'Formatet kan bara ändras innan turneringen startats.');
      if (b.isPublic === true && !(await c.query('select 1 from public_pages where workspace_id = $1 and enabled', [p.wid])).rowCount) throw conflict('PUBLIC_PAGE_DISABLED', 'Slå på föreningens publika sida först (under Publik sida i Föreningsportalen).');
      const r = (await c.query('update tournaments set name = coalesce($3, name), double_round = coalesce($4, double_round), is_public = coalesce($5, is_public), updated_at = now() where id = $1 and workspace_id = $2 returning id, name, double_round, is_public, status', [p.id, p.wid, b.name ?? null, b.doubleRound ?? null, b.isPublic ?? null])).rows[0];
      await log(c, req, 'updated', p.wid, p.id, b.isPublic !== undefined ? { isPublic: b.isPublic } : {});
      return camelAll([r])[0];
    });
  });

  app.delete(`${base}/:id`, { preHandler: authed }, async (req, reply) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    await withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      await load(c, p.wid, p.id, true);
      await c.query('delete from tournaments where id = $1 and workspace_id = $2', [p.id, p.wid]);
      await log(c, req, 'deleted', p.wid, p.id);
      await evaluateLimits(c, p.wid);
    });
    return reply.code(204).send();
  });

  app.post(`${base}/:id/teams`, { preHandler: authed }, async (req, reply) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    const b = team.parse(req.body);
    await requireMember(req, p.wid, ['owner', 'admin']);
    const row = await withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      const t = await load(c, p.wid, p.id, true);
      if (t.format === 'pinball') throw conflict('WRONG_FORMAT', 'Det här är en flipperturnering. Använd flipper-funktionerna (spelare, maskiner, steg).');
      if (t.status !== 'draft') throw conflict('TOURNAMENT_LOCKED', 'Lag kan bara läggas till innan turneringen startats.');
      const n = (await c.query<{ n: number }>('select count(*)::int as n from tournament_teams where tournament_id = $1', [p.id])).rows[0]!.n;
      if (n >= MAX_TEAMS) throw conflict('TOO_MANY_TEAMS', `En turnering kan ha högst ${MAX_TEAMS} lag.`);
      try { return (await c.query('insert into tournament_teams (workspace_id, tournament_id, name) values ($1,$2,$3) returning id, name', [p.wid, p.id, b.name])).rows[0]; }
      catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('TEAM_EXISTS', 'Ett lag med det namnet finns redan i turneringen.'); throw e; }
    });
    return reply.code(201).send(row);
  });

  app.delete(`${base}/:id/teams/:teamId`, { preHandler: authed }, async (req, reply) => {
    const p = z.object({ wid: uuid, id: uuid, teamId: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    await withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      const t = await load(c, p.wid, p.id, true);
      if (t.format === 'pinball') throw conflict('WRONG_FORMAT', 'Det här är en flipperturnering. Använd flipper-funktionerna (spelare, maskiner, steg).');
      if (t.status !== 'draft') throw conflict('TOURNAMENT_LOCKED', 'Lag kan bara tas bort innan turneringen startats.');
      const r = await c.query('delete from tournament_teams where id = $1 and tournament_id = $2 and workspace_id = $3', [p.teamId, p.id, p.wid]);
      if (!r.rowCount) throw notFound('Laget hittades inte.');
    });
    return reply.code(204).send();
  });

  app.post(`${base}/:id/start`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      const t = await load(c, p.wid, p.id, true);
      if (t.format === 'pinball') throw conflict('WRONG_FORMAT', 'Det här är en flipperturnering. Använd flipper-funktionerna (spelare, maskiner, steg).');
      if (t.status !== 'draft') throw conflict('TOURNAMENT_LOCKED', 'Turneringen är redan startad.');
      const ids = (await c.query<{ id: string }>('select id from tournament_teams where tournament_id = $1 order by created_at, id', [p.id])).rows.map((x) => x.id);
      if (ids.length < 2) throw conflict('TOO_FEW_TEAMS', 'Minst två lag krävs för att starta.');
      let count: number;
      if (t.format === 'single_elimination') {
        const br = knockout(ids); count = br.filter((m) => !(m.round === 1 && m.away === null)).length;
        const ins = async (m: (typeof br)[number]) => (await c.query<{ id: string }>('insert into tournament_matches (workspace_id, tournament_id, round, position, home_team_id, away_team_id) values ($1,$2,$3,$4,$5,$6) returning id', [p.wid, p.id, m.round, m.position, m.home, m.away])).rows[0]!.id;
        for (const m of br) await ins(m);
        const rounds = Math.max(...br.map((m) => m.round));
        for (const m of br.filter((x) => x.round === 1 && x.home && !x.away)) await advance(c, p.wid, p.id, 1, m.position, m.home!, rounds); // frilott: vinner direkt
      } else if (t.format === 'groups_knockout') {
        if (ids.length < t.group_count! * 2) throw conflict('TOO_FEW_TEAMS', `Minst ${t.group_count! * 2} lag krävs för ${t.group_count} grupper (två per grupp).`);
        count = 0;
        for (const [gi, grp] of snakeGroups(ids, t.group_count!).entries()) {
          await c.query('update tournament_teams set group_no = $2 where id = any($1::uuid[]) and workspace_id = $3', [grp, gi + 1, p.wid]);
          for (const f of roundRobin(grp)) { count++; await c.query('insert into tournament_matches (workspace_id, tournament_id, round, group_no, home_team_id, away_team_id) values ($1,$2,$3,$4,$5,$6)', [p.wid, p.id, f.round, gi + 1, f.home, f.away]); }
        }
      } else {
        const fx = roundRobin(ids, t.double_round); count = fx.length;
        for (const f of fx) await c.query('insert into tournament_matches (workspace_id, tournament_id, round, home_team_id, away_team_id) values ($1,$2,$3,$4,$5)', [p.wid, p.id, f.round, f.home, f.away]);
      }
      await c.query(`update tournaments set status = 'running', updated_at = now() where id = $1`, [p.id]);
      await log(c, req, 'started', p.wid, p.id, { teams: ids.length, matches: count });
      return { status: 'running', matches: count };
    });
  });

  // Resultat kan rapporteras av ägare/admin. Rättning (även rensning) tillåts så länge turneringen pågår.
  app.put(`${base}/:id/matches/:matchId`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid, matchId: uuid }).parse(req.params);
    const b = score.parse(req.body);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      const t = await load(c, p.wid, p.id, true);
      if (t.format === 'pinball') throw conflict('WRONG_FORMAT', 'Det här är en flipperturnering. Använd flipper-funktionerna (spelare, maskiner, steg).');
      if (t.status !== 'running') throw conflict('TOURNAMENT_NOT_RUNNING', t.status === 'draft' ? 'Turneringen har inte startats.' : 'Turneringen är avslutad.');
      const cur = (await c.query('select id, round, position, group_no, home_team_id, away_team_id from tournament_matches where id = $1 and tournament_id = $2 and workspace_id = $3 for update', [p.matchId, p.id, p.wid])).rows[0] as
        { round: number; position: number | null; group_no: number | null; home_team_id: string | null; away_team_id: string | null } | undefined;
      if (!cur) throw notFound('Matchen hittades inte.');
      const ko = cur.position !== null; let winner: string | null = null;
      if (!ko && t.format === 'groups_knockout' && (await c.query('select 1 from tournament_matches where tournament_id = $1 and position is not null limit 1', [p.id])).rowCount) throw conflict('GROUP_LOCKED', 'Gruppspelet är avslutat och slutspelet har startat – gruppresultat kan inte ändras.');
      if (ko) {
        if (!cur.home_team_id || !cur.away_team_id) throw conflict('MATCH_NOT_READY', 'Matchen kan inte spelas förrän båda lagen är klara.');
        if (b.homeScore !== null && b.homeScore === b.awayScore) throw conflict('DRAW_NOT_ALLOWED', 'En utslagsmatch måste ha en vinnare – oavgjort är inte tillåtet.');
        if (b.homeScore !== null) winner = b.homeScore! > b.awayScore! ? cur.home_team_id : cur.away_team_id;
        const rounds = (await c.query<{ r: number }>('select max(round)::int as r from tournament_matches where tournament_id = $1 and position is not null', [p.id])).rows[0]!.r;
        const nx = nextSlot(cur.round, cur.position!, rounds);
        if (nx) {
          const next = (await c.query('select home_score from tournament_matches where tournament_id = $1 and round = $2 and position = $3 for update', [p.id, nx.round, nx.position])).rows[0];
          if (next && next.home_score !== null) throw conflict('RESULT_LOCKED', 'Nästa match har redan ett resultat. Rensa det först.');
        }
        await advance(c, p.wid, p.id, cur.round, cur.position!, winner, rounds);
      }
      const r = (await c.query('update tournament_matches set home_score = $4, away_score = $5, winner_team_id = $7, reported_by = $6, updated_at = now() where id = $1 and tournament_id = $2 and workspace_id = $3 returning id, round, home_score, away_score',
        [p.matchId, p.id, p.wid, b.homeScore, b.awayScore, req.customer!.userId, winner])).rows[0];
      await log(c, req, 'result_reported', p.wid, p.id, { matchId: p.matchId, cleared: b.homeScore === null });
      return camelAll([r])[0];
    });
  });

  // Gruppspel -> slutspel. Kräver att alla gruppmatcher är spelade. Delad placering som påverkar slutspelsplatser måste avgöras av administratören.
  app.post(`${base}/:id/knockout`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    const b = z.object({ order: z.array(uuid).max(64).optional() }).strict().parse(req.body ?? {});
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      const t = await load(c, p.wid, p.id, true);
      if (t.format === 'pinball') throw conflict('WRONG_FORMAT', 'Det här är en flipperturnering. Använd flipper-funktionerna (spelare, maskiner, steg).');
      if (t.format !== 'groups_knockout') throw conflict('NOT_APPLICABLE', 'Gäller bara gruppspel med slutspel.');
      if (t.status !== 'running') throw conflict('TOURNAMENT_NOT_RUNNING', 'Turneringen pågår inte.');
      if ((await c.query('select 1 from tournament_matches where tournament_id = $1 and position is not null limit 1', [p.id])).rowCount) throw conflict('TOURNAMENT_LOCKED', 'Slutspelet är redan startat.');
      const ms = (await c.query('select group_no, home_team_id, away_team_id, home_score, away_score from tournament_matches where tournament_id = $1', [p.id])).rows as
        { group_no: number; home_team_id: string; away_team_id: string; home_score: number | null; away_score: number | null }[];
      const open = ms.filter((m) => m.home_score === null).length;
      if (open > 0) throw conflict('GROUPS_INCOMPLETE', `${open} gruppmatcher saknar resultat.`, { open });
      const k = t.advance_per_group as 1 | 2;
      const ranked: string[][] = []; const ties: { groupNo: number; teamIds: string[] }[] = [];
      for (let g = 1; g <= t.group_count!; g++) {
        const ids = (await c.query<{ id: string }>('select id from tournament_teams where tournament_id = $1 and group_no = $2', [p.id, g])).rows.map((x) => x.id);
        const tab = standings(ids, ms.filter((m) => m.group_no === g).map((m) => ({ home: m.home_team_id, away: m.away_team_id, homeScore: m.home_score!, awayScore: m.away_score! })));
        const pos = (id: string) => (b.order ?? []).indexOf(id);
        let list = tab.map((r) => r.teamId);
        const rankOf = new Map(tab.map((r) => [r.teamId, r.rank]));
        // delad placering som rör de k första platserna kräver uttryckligt avgörande
        for (const rank of new Set(tab.map((r) => r.rank))) {
          const set = tab.filter((r) => r.rank === rank).map((r) => r.teamId);
          const start = tab.findIndex((r) => r.rank === rank);
          if (set.length > 1 && start < k) {
            if (set.some((id) => pos(id) < 0)) { ties.push({ groupNo: g, teamIds: set }); continue; }
            const ordered = [...set].sort((x, y) => pos(x) - pos(y));
            list = [...list.slice(0, start), ...ordered, ...list.slice(start + set.length)];
          }
        }
        void rankOf; ranked.push(list);
      }
      if (ties.length) throw conflict('TIE_AT_CUTOFF', 'Lika placering i gruppen avgör slutspelsplats. Ange ordning för de lag som är lika.', { groups: ties });
      const br = knockout(qualifierSeeds(ranked, k));
      for (const m of br) await c.query('insert into tournament_matches (workspace_id, tournament_id, round, position, home_team_id, away_team_id) values ($1,$2,$3,$4,$5,$6)', [p.wid, p.id, m.round, m.position, m.home, m.away]);
      await log(c, req, 'knockout_started', p.wid, p.id, { qualifiers: br.filter((m) => m.round === 1).length * 2 });
      return { matches: br.length };
    });
  });

  app.post(`${base}/:id/finish`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      const t = await load(c, p.wid, p.id, true);
      if (t.format === 'pinball') throw conflict('WRONG_FORMAT', 'Det här är en flipperturnering. Använd flipper-funktionerna (spelare, maskiner, steg).');
      if (t.status !== 'running') throw conflict('TOURNAMENT_NOT_RUNNING', 'Bara pågående turneringar kan avslutas.');
      if (t.format === 'groups_knockout' && !(await c.query('select 1 from tournament_matches where tournament_id = $1 and position is not null limit 1', [p.id])).rowCount) throw conflict('TOURNAMENT_INCOMPLETE', 'Slutspelet har inte startats.');
      const open = (await c.query<{ n: number }>('select count(*)::int as n from tournament_matches where tournament_id = $1 and home_score is null and not (position is not null and round = 1 and away_team_id is null)', [p.id])).rows[0]!.n;
      if (open > 0) throw conflict('TOURNAMENT_INCOMPLETE', `${open} matcher saknar resultat.`, { open });
      await c.query(`update tournaments set status = 'finished', updated_at = now() where id = $1`, [p.id]);
      await log(c, req, 'finished', p.wid, p.id);
      await evaluateLimits(c, p.wid); // avslutad turnering räknas inte som aktiv
      return { status: 'finished' };
    });
  });
}

type Conn = Parameters<typeof modeFor>[0];
/** Flyttar vinnaren (eller tömmer platsen när null) till nästa omgång. Frilott: vinnaren sätts också på matchen själv. */
async function advance(c: Conn, wid: string, tid: string, round: number, position: number, winner: string | null, rounds: number): Promise<void> {
  const nx = nextSlot(round, position, rounds);
  if (!nx) return;
  const col = nx.slot === 'home' ? 'home_team_id' : 'away_team_id';
  await c.query(`update tournament_matches set ${col} = $4, updated_at = now() where tournament_id = $1 and round = $2 and position = $3 and workspace_id = $5`, [tid, nx.round, nx.position, winner, wid]);
  if (round === 1 && winner) await c.query('update tournament_matches set winner_team_id = $4 where tournament_id = $1 and round = 1 and position = $2 and workspace_id = $3 and away_team_id is null', [tid, position, wid, winner]);
}
