import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx, withWorkspace } from '../../db/pool.js';
import { camelAll } from '../../lib/camel.js';
import { conflict, notFound } from '../../lib/errors.js';
import { rateLimit } from '../../lib/ratelimit.js';
import { audit } from '../../services/audit.js';
import { loadWorkspaceAccess } from '../../services/access.js';
import { tournamentView } from './tournaments.js';
import type { Helpers } from './association.js';

const uuid = z.string().uuid();
export const CONSENT_VERSION = '2026-11';
export const CONSENT_TEXT = 'Jag bekräftar att föreningen har rätt att publicera innehållet, att inget som publiceras innehåller personuppgifter om medlemmar utan deras samtycke, och att nyheter och turneringsresultat blir synliga för alla på internet utan inloggning.';
const RESERVED = new Set(['admin', 'api', 'p', 'www', 'app', 'login', 'unsubscribe', 'static', 'assets', 'support', 'help']);
const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/, 'Adressen får bara innehålla a–z, 0–9 och bindestreck, 3–40 tecken').refine((s) => !RESERVED.has(s) && !s.includes('--'), 'Adressen är reserverad eller ogiltig');
const settings = z.object({ enabled: z.boolean(), slug, showNews: z.boolean().default(true), consent: z.literal(true).optional() }).strict();

export function publicPageAdminRoutes(app: FastifyInstance, { authed, requireMember }: Helpers): void {
  const url = '/workspaces/:wid/public-page';
  app.get(url, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    await requireMember(req, wid, ['owner', 'admin']);
    const r = (await pool.query('select slug, enabled, show_news, consent_at, consent_version from public_pages where workspace_id = $1', [wid])).rows[0];
    return { page: r ? camelAll([r])[0] : null, consentText: CONSENT_TEXT, consentVersion: CONSENT_VERSION, defaultNoIndex: true };
  });

  app.put(url, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = settings.parse(req.body);
    await requireMember(req, wid, ['owner', 'admin']);
    return tx(async (c) => {
      const a = await loadWorkspaceAccess(c, wid);
      if (!a || a.workspaceStatus !== 'Active') throw conflict('WORKSPACE_NOT_ACTIVE', 'Arbetsytan är inte aktiv och kan inte ändra publika inställningar.');
      const cur = (await c.query('select consent_version from public_pages where workspace_id = $1 for update', [wid])).rows[0] as { consent_version: string | null } | undefined;
      const needsConsent = b.enabled && cur?.consent_version !== CONSENT_VERSION;
      if (needsConsent && b.consent !== true) throw conflict('CONSENT_REQUIRED', 'Du måste bekräfta ansvaret för publiceringen innan sidan kan slås på.', { consentText: CONSENT_TEXT });
      try {
        await c.query(`insert into public_pages (workspace_id, slug, enabled, show_news, consent_at, consent_by, consent_version) values ($1,$2,$3,$4,$5,$6,$7)
          on conflict (workspace_id) do update set slug = excluded.slug, enabled = excluded.enabled, show_news = excluded.show_news, updated_at = now(),
            consent_at = coalesce(excluded.consent_at, public_pages.consent_at), consent_by = coalesce(excluded.consent_by, public_pages.consent_by), consent_version = coalesce(excluded.consent_version, public_pages.consent_version)`,
        [wid, b.slug, b.enabled, b.showNews, needsConsent ? new Date() : null, needsConsent ? req.customer!.userId : null, needsConsent ? CONSENT_VERSION : null]);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw conflict('SLUG_TAKEN', 'Den adressen är upptagen. Välj en annan.'); throw e; }
      // Stänger man av sidan återgår alla turneringar till icke-publika – publicering ska alltid vara ett nytt, aktivt val.
      if (!b.enabled) await withWorkspace(wid, (w) => w.query('update tournaments set is_public = false where workspace_id = $1 and is_public', [wid]));
      await audit(c, { requestId: req.id }, { action: b.enabled ? 'public_page.enabled' : 'public_page.disabled', workspaceId: wid, userId: req.customer!.userId, targetType: 'public_page', meta: { by: 'customer', slug: b.slug, showNews: b.showNews, consentRecorded: needsConsent } });
      return { ok: true };
    });
  });
}

/** Publika rutter (ingen inloggning). Visar bara publicerade nyheter och turneringar som en admin uttryckligen valt, och aldrig medlemsuppgifter. */
export function publicPageRoutes(app: FastifyInstance): void {
  const find = async (req: { ip: string }, slugParam: unknown) => {
    rateLimit(`public:${req.ip}`, 120, 60_000);
    const s = slug.safeParse(slugParam);
    const row = s.success ? (await pool.query('select p.workspace_id, p.show_news, w.name from public_pages p join workspaces w on w.id = p.workspace_id where p.slug = $1 and p.enabled and w.status = $2', [s.data, 'Active'])).rows[0] : null;
    if (!row) throw notFound('Sidan finns inte.');
    const access = await loadWorkspaceAccess(pool, row.workspace_id);
    const mode = (p: string) => access?.products.find((x) => x.product === p)?.mode ?? 'none';
    return { wid: row.workspace_id as string, name: row.name as string, showNews: row.show_news as boolean, news: mode('association_portal') !== 'none', tournaments: mode('tournament_system') !== 'none' };
  };

  app.get('/public/pages/:slug', async (req) => {
    const p = await find(req, (req.params as { slug?: string }).slug);
    return withWorkspace(p.wid, async (c) => ({
      name: p.name,
      news: p.showNews && p.news ? camelAll((await c.query(`select id, title, body, pinned, published_at from association_news where workspace_id = $1 and status = 'published' order by pinned desc, published_at desc, id limit 20`, [p.wid])).rows) : [],
      tournaments: p.tournaments ? camelAll((await c.query(`select id, name, format, status from tournaments where workspace_id = $1 and is_public and status <> 'draft' order by created_at desc, id limit 50`, [p.wid])).rows) : [],
    }));
  });

  app.get('/public/pages/:slug/tournaments/:id', async (req) => {
    const params = req.params as { slug?: string; id?: string };
    const p = await find(req, params.slug);
    const id = uuid.safeParse(params.id);
    if (!id.success || !p.tournaments) throw notFound('Turneringen finns inte.');
    return withWorkspace(p.wid, async (c) => {
      const t = (await c.query(`select id, name, format, double_round, group_count, advance_per_group, status from tournaments where id = $1 and workspace_id = $2 and is_public and status <> 'draft'`, [id.data, p.wid])).rows[0];
      if (!t) throw notFound('Turneringen finns inte.');
      const v = await tournamentView(c, t);
      return { associationName: p.name, ...v };
    });
  });
}
