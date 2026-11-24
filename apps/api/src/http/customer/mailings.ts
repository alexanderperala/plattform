import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { withWorkspace } from '../../db/pool.js';
import { camelAll } from '../../lib/camel.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { enqueueEmail } from '../../services/outbox.js';
import { canWrite } from '../../domain/access.js';
import { modeFor, NOT_AVAILABLE, READ_ONLY, type Helpers } from './association.js';

const uuid = z.string().uuid();
const PORTAL_URL = process.env.ASSOCIATION_PORTAL_URL ?? 'http://localhost:5175';
export const MAILING_MAX_RECIPIENTS = 5000;
export const MAILING_MAX_PER_DAY = 5;
const body = z.object({ subject: z.string().trim().min(1).max(200).refine((s) => !/[\r\n]/.test(s), 'Ämnet får inte innehålla radbrytningar'), body: z.string().trim().min(1).max(20_000) }).strict();
const patch = z.object({ subject: body.shape.subject.optional(), body: body.shape.body.optional() }).strict().refine((x) => Object.keys(x).length > 0, 'Ange minst ett fält');

// ---- Avanmälningslänk: signerad, ingen databasuppslagning och ingen inloggning. Domänseparerad nyckel. ----
const key = () => createHmac('sha256', config.mfaEncryptionKey).update('association-unsubscribe-v1').digest();
const b64 = (s: string) => Buffer.from(s).toString('base64url');
export function unsubscribeToken(workspaceId: string, memberId: string): string {
  const p = b64(`${workspaceId}.${memberId}`);
  return `${p}.${createHmac('sha256', key()).update(p).digest('base64url')}`;
}
export function readUnsubscribeToken(token: string): { workspaceId: string; memberId: string } | null {
  const [p, sig, ...rest] = token.split('.');
  if (!p || !sig || rest.length) return null;
  const want = createHmac('sha256', key()).update(p).digest(); const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const [w, m] = Buffer.from(p, 'base64url').toString().split('.');
  return uuid.safeParse(w).success && uuid.safeParse(m).success ? { workspaceId: w!, memberId: m! } : null;
}

export function mailingRoutes(app: FastifyInstance, { authed, requireMember }: Helpers): void {
  const base = '/workspaces/:wid/association/mailings';
  const guard = async (c: Parameters<typeof modeFor>[0], wid: string, write: boolean) => {
    const m = await modeFor(c, wid);
    if (m.mode === 'none') throw NOT_AVAILABLE();
    if (write && !canWrite(m.mode)) throw READ_ONLY();
  };
  const load = async (c: Parameters<typeof modeFor>[0], wid: string, id: string, lock = false) => {
    const r = (await c.query(`select id, subject, body, status, recipient_count, sent_at, created_at, updated_at from association_mailings where id = $1 and workspace_id = $2${lock ? ' for update' : ''}`, [id, wid])).rows[0];
    if (!r) throw notFound('Utskicket hittades inte.');
    return r as { id: string; subject: string; body: string; status: 'draft' | 'sent' };
  };
  /** Mottagare = aktiva medlemmar med e-postadress som inte avanmält sig. Övriga räknas och redovisas, men får aldrig något. */
  const audience = async (c: Parameters<typeof modeFor>[0], wid: string) => {
    const r = (await c.query(`select count(*) filter (where status = 'active' and email is not null and email <> '' and not email_opt_out)::int as recipients,
        count(*) filter (where status = 'active' and (email is null or email = ''))::int as no_email,
        count(*) filter (where status = 'active' and email is not null and email <> '' and email_opt_out)::int as opted_out,
        count(*) filter (where status <> 'active')::int as inactive from association_members where workspace_id = $1`, [wid])).rows[0];
    return r as { recipients: number; no_email: number; opted_out: number; inactive: number };
  };

  app.get(base, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    await requireMember(req, wid, ['owner', 'admin']);
    return withWorkspace(wid, async (c) => {
      await guard(c, wid, false);
      const rows = (await c.query('select id, subject, status, recipient_count, sent_at, created_at from association_mailings where workspace_id = $1 order by created_at desc, id limit 200', [wid])).rows;
      return { items: camelAll(rows), maxPerDay: MAILING_MAX_PER_DAY, maxRecipients: MAILING_MAX_RECIPIENTS };
    });
  });

  app.get(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, false);
      const m = await load(c, p.wid, p.id);
      const rec = m.status === 'sent' ? (await c.query(`select x.member_id, mm.name, mm.email from association_mailing_recipients x join association_members mm on mm.workspace_id = x.workspace_id and mm.id = x.member_id
        where x.mailing_id = $1 and x.workspace_id = $2 order by lower(mm.name)`, [p.id, p.wid])).rows : [];
      return { ...camelAll([m])[0], audience: m.status === 'draft' ? camelAll([await audience(c, p.wid)])[0] : null, recipients: camelAll(rec) };
    });
  });

  app.post(base, { preHandler: authed }, async (req, reply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = body.parse(req.body);
    await requireMember(req, wid, ['owner', 'admin']);
    const row = await withWorkspace(wid, async (c) => {
      await guard(c, wid, true);
      const r = (await c.query('insert into association_mailings (workspace_id, subject, body, created_by) values ($1,$2,$3,$4) returning id, subject, status, created_at', [wid, b.subject, b.body, req.customer!.userId])).rows[0];
      await audit(c, { requestId: req.id }, { action: 'association.mailing.created', workspaceId: wid, userId: req.customer!.userId, targetType: 'mailing', targetId: r.id, meta: { by: 'customer' } });
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
      const m = await load(c, p.wid, p.id, true);
      if (m.status !== 'draft') throw conflict('MAILING_SENT', 'Ett skickat utskick kan inte ändras.');
      const r = (await c.query('update association_mailings set subject = coalesce($3, subject), body = coalesce($4, body), updated_at = now() where id = $1 and workspace_id = $2 returning id, subject, status', [p.id, p.wid, b.subject ?? null, b.body ?? null])).rows[0];
      return camelAll([r])[0];
    });
  });

  app.delete(`${base}/:id`, { preHandler: authed }, async (req, reply) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    await withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      const m = await load(c, p.wid, p.id, true);
      if (m.status !== 'draft') throw conflict('MAILING_SENT', 'Ett skickat utskick sparas som historik och kan inte raderas.');
      await c.query('delete from association_mailings where id = $1 and workspace_id = $2', [p.id, p.wid]);
    });
    return reply.code(204).send();
  });

  app.post(`${base}/:id/send`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      await guard(c, p.wid, true);
      await c.query('select id from workspaces where id = $1 for update', [p.wid]); // serialiserar dygnsgränsen
      const m = await load(c, p.wid, p.id, true);
      if (m.status !== 'draft') throw conflict('MAILING_SENT', 'Utskicket är redan skickat.');
      const today = (await c.query<{ n: number }>(`select count(*)::int as n from association_mailings where workspace_id = $1 and sent_at > now() - interval '24 hours'`, [p.wid])).rows[0]!.n;
      if (today >= MAILING_MAX_PER_DAY) throw conflict('MAILING_LIMIT', `Högst ${MAILING_MAX_PER_DAY} utskick per dygn är tillåtna. Försök igen senare.`, { max: MAILING_MAX_PER_DAY });
      const rec = (await c.query<{ id: string; email: string }>(`select id, email from association_members where workspace_id = $1 and status = 'active' and email is not null and email <> '' and not email_opt_out order by id`, [p.wid])).rows;
      if (rec.length === 0) throw conflict('NO_RECIPIENTS', 'Det finns inga mottagare: aktiva medlemmar med e-postadress som inte avanmält sig.');
      if (rec.length > MAILING_MAX_RECIPIENTS) throw conflict('TOO_MANY_RECIPIENTS', `Utskick kan nå högst ${MAILING_MAX_RECIPIENTS} mottagare.`, { recipients: rec.length, max: MAILING_MAX_RECIPIENTS });
      const ws = (await c.query<{ name: string }>('select name from workspaces where id = $1', [p.wid])).rows[0]!.name;
      for (const r of rec) {
        const url = `${PORTAL_URL}/unsubscribe?t=${unsubscribeToken(p.wid, r.id)}`;
        await enqueueEmail(c, { workspaceId: p.wid, to: r.email, template: 'association_mailing', subject: m.subject, body: `${m.body}\n\n--\nDu får det här meddelandet eftersom du är medlem i ${ws}.\nVill du inte få fler utskick? Avsluta här: ${url}\n`, payload: { mailingId: p.id }, unsubscribeUrl: url });
      }
      await c.query('insert into association_mailing_recipients (workspace_id, mailing_id, member_id) select $1, $2, unnest($3::uuid[])', [p.wid, p.id, rec.map((r) => r.id)]);
      await c.query(`update association_mailings set status = 'sent', sent_at = now(), sent_by = $3, recipient_count = $4, updated_at = now() where id = $1 and workspace_id = $2`, [p.id, p.wid, req.customer!.userId, rec.length]);
      await audit(c, { requestId: req.id }, { action: 'association.mailing.sent', workspaceId: p.wid, userId: req.customer!.userId, targetType: 'mailing', targetId: p.id, meta: { by: 'customer', recipients: rec.length } });
      return { status: 'sent', recipientCount: rec.length };
    });
  });
}

/** Publika avanmälningsrutter. Ingen inloggning – bara den signerade länken. Ändringen sker via GET-fri bekräftelse (POST) så att e-postskannrar inte avanmäler av misstag. */
export function unsubscribeRoutes(app: FastifyInstance): void {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, b, done) => done(null, {})); // RFC 8058 "One-Click": tokenen ligger i URL:en
  const tokenOf = (req: { query: unknown; body: unknown }) => {
    const t = z.string().min(10).max(300).safeParse((req.query as { t?: string })?.t ?? (req.body as { token?: string } | null)?.token);
    const r = t.success ? readUnsubscribeToken(t.data) : null;
    if (!r) throw badRequest('INVALID_TOKEN', 'Länken är ogiltig. Använd länken i det senaste utskicket.');
    return r;
  };
  app.get('/public/unsubscribe', async (req) => {
    const t = tokenOf(req);
    const name = await withWorkspace(t.workspaceId, async (c) => (await c.query<{ name: string }>('select name from workspaces where id = $1', [t.workspaceId])).rows[0]?.name);
    if (!name) throw badRequest('INVALID_TOKEN', 'Länken är ogiltig. Använd länken i det senaste utskicket.');
    return { associationName: name };
  });
  app.post('/public/unsubscribe', async (req) => {
    const t = tokenOf(req);
    return withWorkspace(t.workspaceId, async (c) => {
      const r = await c.query(`update association_members set email_opt_out = true, email_opt_out_at = coalesce(email_opt_out_at, now()), updated_at = now() where id = $1 and workspace_id = $2 and not email_opt_out`, [t.memberId, t.workspaceId]);
      if (r.rowCount) await audit(c, { requestId: req.id }, { action: 'association.member.unsubscribed', workspaceId: t.workspaceId, targetType: 'member', targetId: t.memberId, meta: { by: 'member_link' } });
      return { ok: true }; // alltid samma svar – avslöjar inte om medlemmen fanns
    });
  });
}
