import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withWorkspace } from '../../db/pool.js';
import { camel, camelAll } from '../../lib/camel.js';
import { notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { canRead, canWrite } from '../../domain/access.js';
import { modeFor, NOT_AVAILABLE, READ_ONLY, type Helpers } from './association.js';

const uuid = z.string().uuid();
const COLS = 'id, title, body, status, pinned, published_at, created_at, updated_at';
const newsBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  pinned: z.boolean().optional(),
}).strict();
// Egen PATCH-variant utan standardvärden: ett utelämnat fält får aldrig skriva över befintligt innehåll.
const newsPatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().max(20_000).optional(),
  pinned: z.boolean().optional(),
}).strict();

/**
 * Nyheter. Utkast syns bara för ägare/admin (backend avgör, inte UI). Brödtext är ren text; gränssnittet renderar den
 * som text och aldrig som HTML, så inget skript kan injiceras.
 */
export function newsRoutes(app: FastifyInstance, { authed, requireMember }: Helpers): void {
  const base = '/workspaces/:wid/association/news';

  app.get(base, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const q = z.object({ status: z.enum(['draft', 'published']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
    const role = await requireMember(req, wid);
    const isAdmin = role !== 'member';
    return withWorkspace(wid, async (c) => {
      const { mode } = await modeFor(c, wid);
      if (!canRead(mode)) throw NOT_AVAILABLE();
      const where = ['workspace_id = $1']; const p: unknown[] = [wid];
      if (!isAdmin) where.push(`status = 'published'`);
      else if (q.status) { p.push(q.status); where.push(`status = $${p.length}`); }
      const total = (await c.query<{ n: number }>(`select count(*)::int as n from association_news where ${where.join(' and ')}`, p)).rows[0]!.n;
      p.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = (await c.query(
        `select ${COLS} from association_news where ${where.join(' and ')} order by pinned desc, coalesce(published_at, created_at) desc, id limit $${p.length - 1} offset $${p.length}`, p)).rows;
      return { items: camelAll(rows), total, page: q.page, pageSize: q.pageSize, canManage: isAdmin && canWrite(mode) };
    });
  });

  app.post(base, { preHandler: authed }, async (req, reply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = newsBody.parse(req.body);
    await requireMember(req, wid, ['owner', 'admin']);
    const row = await withWorkspace(wid, async (c) => {
      const { mode } = await modeFor(c, wid);
      if (!canRead(mode)) throw NOT_AVAILABLE();
      if (!canWrite(mode)) throw READ_ONLY();
      return (await c.query(`insert into association_news (workspace_id, title, body, pinned, created_by) values ($1,$2,$3,$4,$5) returning ${COLS}`,
        [wid, b.title, b.body, b.pinned ?? false, req.customer!.userId])).rows[0]!;
    });
    return reply.status(201).send(camel(row));
  });

  app.patch(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    const b = newsPatch.refine((x) => Object.keys(x).length > 0, 'Ange minst ett fält').parse(req.body);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      const { mode } = await modeFor(c, p.wid);
      if (!canRead(mode)) throw NOT_AVAILABLE();
      if (!canWrite(mode)) throw READ_ONLY();
      const r = (await c.query(
        `update association_news set title = coalesce($3, title), body = coalesce($4, body), pinned = coalesce($5, pinned), updated_at = now()
          where id = $1 and workspace_id = $2 returning ${COLS}`, [p.id, p.wid, b.title ?? null, b.body ?? null, b.pinned ?? null])).rows[0];
      if (!r) throw notFound('Nyheten hittades inte.');
      return camel(r);
    });
  });

  for (const act of ['publish', 'unpublish'] as const) {
    app.post(`${base}/:id/${act}`, { preHandler: authed }, async (req) => {
      const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
      await requireMember(req, p.wid, ['owner', 'admin']);
      return withWorkspace(p.wid, async (c) => {
        const { mode } = await modeFor(c, p.wid);
        if (!canRead(mode)) throw NOT_AVAILABLE();
        if (!canWrite(mode)) throw READ_ONLY();
        const r = (await c.query(
          act === 'publish'
            ? `update association_news set status = 'published', published_at = coalesce(published_at, now()), updated_at = now() where id = $1 and workspace_id = $2 returning ${COLS}`
            : `update association_news set status = 'draft', updated_at = now() where id = $1 and workspace_id = $2 returning ${COLS}`, [p.id, p.wid])).rows[0];
        if (!r) throw notFound('Nyheten hittades inte.');
        await audit(c, { requestId: req.id }, { action: `association.news.${act}ed`, workspaceId: p.wid, userId: req.customer!.userId, targetType: 'association_news', targetId: p.id, meta: { by: 'customer' } });
        return camel(r);
      });
    });
  }

  app.delete(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      const { mode } = await modeFor(c, p.wid);
      if (!canRead(mode)) throw NOT_AVAILABLE();
      if (!canWrite(mode)) throw READ_ONLY();
      if (!(await c.query('delete from association_news where id = $1 and workspace_id = $2', [p.id, p.wid])).rowCount) throw notFound('Nyheten hittades inte.');
      await audit(c, { requestId: req.id }, { action: 'association.news.deleted', workspaceId: p.wid, userId: req.customer!.userId, targetType: 'association_news', targetId: p.id, meta: { by: 'customer' } });
      return { ok: true };
    });
  });
}
