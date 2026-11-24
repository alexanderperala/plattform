import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withWorkspace } from '../../db/pool.js';
import { camel, camelAll } from '../../lib/camel.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { canRead, canWrite } from '../../domain/access.js';
import { modeFor, NOT_AVAILABLE, READ_ONLY, type Helpers } from './association.js';

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const text = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable();
const eventFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
  location: text(200),
  startsAt: iso,
  endsAt: iso.nullable(),
  capacity: z.number().int().min(1).max(100_000).nullable(),
};
const create = z.object({ ...eventFields, description: eventFields.description.default(''), location: eventFields.location.optional(), endsAt: eventFields.endsAt.optional(), capacity: eventFields.capacity.optional() }).strict();
// Egen PATCH-variant utan standardvärden: utelämnade fält får aldrig skriva över befintliga värden.
const patch = z.object({ title: eventFields.title.optional(), description: eventFields.description.optional(), location: eventFields.location.optional(),
  startsAt: iso.optional(), endsAt: eventFields.endsAt.optional(), capacity: eventFields.capacity.optional() }).strict();

const COLS = `e.id, e.title, e.description, e.location, e.starts_at, e.ends_at, e.capacity, e.status, e.created_at, e.updated_at,
  (select count(*)::int from association_event_attendees a where a.event_id = e.id) as attendee_count`;

/** Kalender. Utkast syns bara för ägare/admin. Deltagarlistan (personuppgifter) syns bara för ägare/admin. */
export function eventRoutes(app: FastifyInstance, { authed, requireMember }: Helpers): void {
  const base = '/workspaces/:wid/association/events';
  const guard = async (c: Parameters<typeof modeFor>[0], wid: string, write: boolean) => {
    const { mode } = await modeFor(c, wid);
    if (!canRead(mode)) throw NOT_AVAILABLE();
    if (write && !canWrite(mode)) throw READ_ONLY();
    return mode;
  };
  const checkTimes = (s: string, e: string | null | undefined) => { if (e && new Date(e) < new Date(s)) throw conflict('INVALID_TIMES', 'Sluttiden kan inte vara före starttiden.'); };

  app.get(base, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const q = z.object({ scope: z.enum(['upcoming', 'past', 'all']).default('upcoming'), status: z.enum(['draft', 'published']).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const role = await requireMember(req, wid); const isAdmin = role !== 'member';
    return withWorkspace(wid, async (c) => {
      const mode = await guard(c, wid, false);
      const where = ['e.workspace_id = $1']; const p: unknown[] = [wid];
      if (!isAdmin) where.push(`e.status = 'published'`); else if (q.status) { p.push(q.status); where.push(`e.status = $${p.length}`); }
      // "Kommande" = pågår eller har inte börjat; "tidigare" = slut passerad (start om slut saknas)
      if (q.scope === 'upcoming') where.push(`coalesce(e.ends_at, e.starts_at) >= now()`);
      if (q.scope === 'past') where.push(`coalesce(e.ends_at, e.starts_at) < now()`);
      const total = (await c.query<{ n: number }>(`select count(*)::int as n from association_events e where ${where.join(' and ')}`, p)).rows[0]!.n;
      p.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = (await c.query(`select ${COLS} from association_events e where ${where.join(' and ')}
        order by ${q.scope === 'past' ? 'e.starts_at desc' : 'e.starts_at asc'}, e.id limit $${p.length - 1} offset $${p.length}`, p)).rows;
      return { items: camelAll(rows), total, page: q.page, pageSize: q.pageSize, canManage: isAdmin && canWrite(mode) };
    });
  });

  app.get(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    const role = await requireMember(req, p.wid); const isAdmin = role !== 'member';
    return withWorkspace(p.wid, async (c) => {
      const mode = await guard(c, p.wid, false);
      const e = (await c.query(`select ${COLS} from association_events e where e.id = $1 and e.workspace_id = $2 ${isAdmin ? '' : `and e.status = 'published'`}`, [p.id, p.wid])).rows[0];
      if (!e) throw notFound('Aktiviteten hittades inte.');
      const out: Record<string, unknown> = { ...camel<Record<string, unknown>>(e), canManage: isAdmin && canWrite(mode) };
      if (isAdmin) out.attendees = camelAll((await c.query(
        `select m.id as member_id, m.name, m.member_number, a.created_at from association_event_attendees a join association_members m on m.id = a.member_id
          where a.event_id = $1 order by lower(m.name)`, [p.id])).rows);
      return out;
    });
  });

  app.post(base, { preHandler: authed }, async (req, reply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = create.parse(req.body); checkTimes(b.startsAt, b.endsAt);
    await requireMember(req, wid, ['owner', 'admin']);
    const row = await withWorkspace(wid, async (c) => {
      await guard(c, wid, true);
      const id = (await c.query(`insert into association_events (workspace_id, title, description, location, starts_at, ends_at, capacity, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [wid, b.title, b.description, b.location ?? null, b.startsAt, b.endsAt ?? null, b.capacity ?? null, req.customer!.userId])).rows[0]!.id;
      return (await c.query(`select ${COLS} from association_events e where e.id = $1`, [id])).rows[0]!;
    });
    return reply.status(201).send(camel(row));
  });

  app.patch(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    const b = patch.refine((x) => Object.keys(x).length > 0, 'Ange minst ett fält').parse(req.body);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      const cur = (await c.query('select * from association_events where id = $1 and workspace_id = $2 for update', [p.id, p.wid])).rows[0];
      if (!cur) throw notFound('Aktiviteten hittades inte.');
      const n = {
        title: b.title ?? cur.title, description: b.description ?? cur.description, location: b.location === undefined ? cur.location : b.location,
        starts_at: b.startsAt ?? cur.starts_at, ends_at: b.endsAt === undefined ? cur.ends_at : b.endsAt, capacity: b.capacity === undefined ? cur.capacity : b.capacity,
      };
      checkTimes(new Date(n.starts_at).toISOString(), n.ends_at ? new Date(n.ends_at).toISOString() : null);
      const count = (await c.query<{ n: number }>('select count(*)::int as n from association_event_attendees where event_id = $1', [p.id])).rows[0]!.n;
      if (n.capacity !== null && n.capacity < count) throw conflict('CAPACITY_BELOW_ATTENDEES', `Det finns redan ${count} anmälda. Ta bort deltagare först eller välj en högre kapacitet.`, { attendees: count });
      await c.query('update association_events set title=$3, description=$4, location=$5, starts_at=$6, ends_at=$7, capacity=$8, updated_at=now() where id=$1 and workspace_id=$2',
        [p.id, p.wid, n.title, n.description, n.location, n.starts_at, n.ends_at, n.capacity]);
      return camel((await c.query(`select ${COLS} from association_events e where e.id = $1`, [p.id])).rows[0]!);
    });
  });

  for (const act of ['publish', 'unpublish'] as const) {
    app.post(`${base}/:id/${act}`, { preHandler: authed }, async (req) => {
      const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
      await requireMember(req, p.wid, ['owner', 'admin']);
      return withWorkspace(p.wid, async (c) => {
        await guard(c, p.wid, true);
        const r = await c.query(`update association_events set status = $3, updated_at = now() where id = $1 and workspace_id = $2`, [p.id, p.wid, act === 'publish' ? 'published' : 'draft']);
        if (!r.rowCount) throw notFound('Aktiviteten hittades inte.');
        await audit(c, { requestId: req.id }, { action: `association.event.${act}ed`, workspaceId: p.wid, userId: req.customer!.userId, targetType: 'association_event', targetId: p.id, meta: { by: 'customer' } });
        return camel((await c.query(`select ${COLS} from association_events e where e.id = $1`, [p.id])).rows[0]!);
      });
    });
  }

  app.delete(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      if (!(await c.query('delete from association_events where id = $1 and workspace_id = $2', [p.id, p.wid])).rowCount) throw notFound('Aktiviteten hittades inte.');
      await audit(c, { requestId: req.id }, { action: 'association.event.deleted', workspaceId: p.wid, userId: req.customer!.userId, targetType: 'association_event', targetId: p.id, meta: { by: 'customer' } });
      return { ok: true };
    });
  });

  // ---------- Deltagare (ur medlemsregistret) ----------
  app.post(`${base}/:id/attendees`, { preHandler: authed }, async (req, reply) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    const b = z.object({ memberId: uuid }).strict().parse(req.body);
    await requireMember(req, p.wid, ['owner', 'admin']);
    await withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      // Radlås på aktiviteten serialiserar anmälningar, så kapaciteten kan aldrig överskridas av samtidiga anrop
      const e = (await c.query('select capacity from association_events where id = $1 and workspace_id = $2 for update', [p.id, p.wid])).rows[0];
      if (!e) throw notFound('Aktiviteten hittades inte.');
      const m = (await c.query('select status from association_members where id = $1 and workspace_id = $2', [b.memberId, p.wid])).rows[0];
      if (!m) throw notFound('Medlemmen hittades inte i registret.');
      if (m.status !== 'active') throw conflict('MEMBER_INACTIVE', 'Inaktiva medlemmar kan inte anmälas.');
      const count = (await c.query<{ n: number }>('select count(*)::int as n from association_event_attendees where event_id = $1', [p.id])).rows[0]!.n;
      if (e.capacity !== null && count >= e.capacity) throw conflict('EVENT_FULL', `Aktiviteten är fullsatt (${e.capacity} platser).`, { capacity: e.capacity });
      const ins = await c.query(`insert into association_event_attendees (event_id, member_id, workspace_id, created_by) values ($1,$2,$3,$4) on conflict do nothing`, [p.id, b.memberId, p.wid, req.customer!.userId]);
      if (!ins.rowCount) throw conflict('ALREADY_REGISTERED', 'Medlemmen är redan anmäld.');
    });
    return reply.status(201).send({ ok: true });
  });

  app.delete(`${base}/:id/attendees/:memberId`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid, memberId: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      if (!(await c.query('delete from association_event_attendees where event_id = $1 and member_id = $2 and workspace_id = $3', [p.id, p.memberId, p.wid])).rowCount) throw notFound('Anmälan hittades inte.');
      return { ok: true };
    });
  });
}
