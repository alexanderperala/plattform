import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tx } from '../../db/pool.js';
import { camel, camelAll } from '../../lib/camel.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { maskPhone } from '../../lib/mask.js';
import { auditCtx } from '../context.js';
import { audit } from '../../services/audit.js';
import { loadWorkspaceAccess } from '../../services/access.js';
import { notifyWorkspaceAdmins } from '../../services/outbox.js';
import { adminRoute, reauthRecent } from './guard.js';
import { hasPermission } from '../../domain/permissions.js';
import { runAssistedAction } from '../../services/assisted.js';

const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);
const READONLY_DEFAULT_MIN = 30;
const READONLY_MAX_MIN = 120;
const ASSISTED_MAX_MIN = 60;

interface SessionRow {
  id: string; admin_id: string; workspace_id: string; support_case_id: string; mode: string; personal_data: boolean;
  started_at: Date; expires_at: Date; ended_at: Date | null; reason: string;
}

/** Hämtar sessionen och avslutar den om den löpt ut. Åtkomst nekas direkt när tiden är slut (SUP-6). */
async function activeSession(id: string, adminId: string): Promise<SessionRow> {
  const s = (await pool.query<SessionRow>('select * from support_access_sessions where id = $1', [id])).rows[0];
  if (!s || s.admin_id !== adminId) throw notFound('Supportsessionen hittades inte.');
  if (s.ended_at) throw new AppError(403, 'SUPPORT_SESSION_ENDED', 'Supportsessionen är avslutad.');
  if (s.expires_at <= new Date()) {
    await pool.query(`update support_access_sessions set ended_at = now(), ended_reason = 'expired' where id = $1 and ended_at is null`, [id]);
    throw new AppError(403, 'SUPPORT_SESSION_EXPIRED', 'Supportsessionen har löpt ut. Starta en ny session om du behöver fortsätta.');
  }
  return s;
}

export function supportAccessRoutes(app: FastifyInstance): void {
  // Start av read-only supportsession (läge 1). Assisterat läge levereras i Fas S1.
  adminRoute(app, { method: 'POST', url: '/support/access-sessions', access: { perm: 'support.access_readonly' } }, async (req, reply) => {
    const b = z.object({
      workspaceId: uuid, supportCaseId: uuid, reason,
      mode: z.enum(['readonly', 'assisted']).default('readonly'),
      minutes: z.number().int().min(5).max(READONLY_MAX_MIN).default(READONLY_DEFAULT_MIN),
      includePersonalData: z.boolean().default(false),
    }).parse(req.body);
    const assisted = b.mode === 'assisted';
    if (assisted) {
      // Assisterat läge kräver egen behörighet och nylig åter-autentisering (matrisen: O R), kontrollerat i backend
      if (!hasPermission(req.admin!.role, 'support.access_assisted')) throw forbidden('Din roll saknar behörighet för assisterad support.', 'FORBIDDEN', { permission: 'support.access_assisted' });
      if (!reauthRecent(req.admin!)) throw forbidden('Bekräfta din identitet med en MFA-kod för att fortsätta.', 'REAUTH_REQUIRED');
      if (b.minutes > ASSISTED_MAX_MIN) throw badRequest('SESSION_TOO_LONG', `Assisterade sessioner får vara högst ${ASSISTED_MAX_MIN} minuter.`);
      if (b.includePersonalData) throw badRequest('INVALID_COMBINATION', 'Personuppgiftsåtkomst startas i en separat läsning, inte i assisterat läge.');
    }
    req.errCtx.workspaceId = b.workspaceId;

    const out = await tx(async (c) => {
      const ws = (await c.query('select id, name from workspaces where id = $1', [b.workspaceId])).rows[0];
      if (!ws) throw notFound('Arbetsytan hittades inte.');
      const sc = (await c.query('select id, number, workspace_id from support_cases where id = $1 for update', [b.supportCaseId])).rows[0];
      if (!sc) throw notFound('Supportärendet hittades inte. Ett ärende krävs för supportåtkomst.');
      if (sc.workspace_id && sc.workspace_id !== b.workspaceId) throw conflict('CASE_WORKSPACE_MISMATCH', 'Ärendet är kopplat till en annan arbetsyta.');
      if (!sc.workspace_id) await c.query('update support_cases set workspace_id = $2 where id = $1', [sc.id, b.workspaceId]);

      let grantId: string | null = null;
      if (b.includePersonalData) {
        // Personnära data kräver kundens godkännande (avsnitt 5.3)
        const g = (await c.query(
          `select id from support_access_grants where workspace_id = $1 and scope = 'personal_data' and revoked_at is null and expires_at > now() order by expires_at desc limit 1`,
          [b.workspaceId])).rows[0];
        if (!g) throw conflict('GRANT_REQUIRED', 'Kunden har inte godkänt åtkomst till personuppgifter. Be arbetsytans administratör godkänna åtkomsten först.');
        grantId = g.id;
      }
      let assistedExpiry: Date | null = null;
      let allowed: string[] = [];
      if (assisted) {
        const g = (await c.query(
          `select id, expires_at, allowed_actions from support_access_grants
            where workspace_id = $1 and scope = 'assisted' and revoked_at is null and expires_at > now()
              and (support_case_id is null or support_case_id = $2) order by expires_at desc limit 1`, [b.workspaceId, b.supportCaseId])).rows[0];
        if (!g) throw conflict('GRANT_REQUIRED', 'Kunden har inte godkänt assisterad support för det här ärendet. Be arbetsytans administratör godkänna åtgärder först.');
        grantId = g.id; assistedExpiry = g.expires_at; allowed = g.allowed_actions;
      }
      // Max en aktiv session per administratör och arbetsyta
      await c.query(`update support_access_sessions set ended_at = now(), ended_reason = 'manual' where admin_id = $1 and workspace_id = $2 and ended_at is null`, [req.admin!.adminId, b.workspaceId]);
      let expires = new Date(Date.now() + b.minutes * 60_000);
      if (assistedExpiry && assistedExpiry < expires) expires = assistedExpiry;
      const s = (await c.query(
        `insert into support_access_sessions (admin_id, workspace_id, support_case_id, mode, reason, grant_id, personal_data, expires_at)
         values ($1,$2,$3,$8,$4,$5,$6,$7) returning id, started_at, expires_at`,
        [req.admin!.adminId, b.workspaceId, b.supportCaseId, b.reason, grantId, b.includePersonalData, expires, assisted ? 'assisted' : 'readonly'])).rows[0];

      await audit(c, auditCtx(req), {
        action: 'support.access.started', severity: b.includePersonalData || assisted ? 'warning' : 'info', workspaceId: b.workspaceId,
        targetType: 'support_access_session', targetId: s.id, supportCaseId: b.supportCaseId, reason: b.reason,
        meta: { mode: assisted ? 'assisted' : 'readonly', allowedActions: allowed, minutes: b.minutes, personalData: b.includePersonalData, grantId },
      });
      // SUP-N: kunden notifieras alltid, och notisen kan inte stängas av
      await notifyWorkspaceAdmins(c, b.workspaceId, {
        kind: 'support_access_started', template: 'support_access_started',
        title: assisted ? 'Supportpersonal har startat en assisterad session i din arbetsyta' : 'Supportpersonal har fått läsåtkomst till din arbetsyta',
        body: `${req.admin!.name} (support) har startat en ${assisted ? 'assisterad' : 'skrivskyddad'} supportsession för ${ws.name}. Ärende #${sc.number}. Orsak: ${b.reason}. Gäller till ${expires.toISOString()}. Läge: ${assisted ? `assisterat, tillåtna åtgärder: ${allowed.join(', ')}` : 'endast läsning'}${b.includePersonalData ? ', inklusive personuppgifter som ni har godkänt' : ', utan personuppgifter'}.`,
      });
      return s;
    });
    return reply.status(201).send(camel(out));
  });

  // Åtgärd inom en aktiv assisterad session. Varje åtgärd kräver orsak + åter-autentisering (matrisen) och loggas.
  adminRoute(app, { method: 'POST', url: '/support/access-sessions/:id/actions', access: { perm: 'support.access_assisted' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const base = { reason };
    const b = z.discriminatedUnion('action', [
      z.object({ action: z.literal('change_setting'), params: z.object({
        name: z.string().trim().min(1).max(200).optional(), contactName: z.string().trim().min(1).max(200).optional(),
        contactEmail: z.string().trim().toLowerCase().email().max(320).optional(), orgNumber: z.string().trim().max(40).nullable().optional(),
      }).strict().refine((p) => Object.keys(p).length > 0, 'Ange minst ett fält'), ...base }),
      z.object({ action: z.literal('enable_permission'), params: z.object({ userId: uuid, role: z.enum(['admin', 'member']) }).strict(), ...base }),
      z.object({ action: z.literal('configure_feature'), params: z.object({ flagKey: z.string().min(1).max(100), enabled: z.boolean() }).strict(), ...base }),
    ]).parse(req.body);
    const s = await activeSession(id, req.admin!.adminId);
    req.errCtx.workspaceId = s.workspace_id;
    if (s.mode !== 'assisted') throw forbidden('Sessionen är skrivskyddad. Starta en assisterad session för att utföra åtgärder.', 'SESSION_READONLY');
    const full = (await pool.query('select grant_id from support_access_sessions where id = $1', [id])).rows[0];
    const out = await tx((c) => runAssistedAction(c, auditCtx(req), { id, workspace_id: s.workspace_id, support_case_id: s.support_case_id, grant_id: full.grant_id }, req.admin!.name, { action: b.action, params: b.params as Record<string, unknown> }, b.reason));
    return { ok: true, ...out };
  });

  // Lista sessioner för en arbetsyta eller egna aktiva sessioner
  adminRoute(app, { method: 'GET', url: '/support/access-sessions', access: { perm: 'support.view' } }, async (req) => {
    const q = z.object({ workspaceId: uuid.optional(), mine: z.enum(['true', 'false']).optional() }).parse(req.query);
    const where: string[] = []; const p: unknown[] = [];
    if (q.workspaceId) { p.push(q.workspaceId); where.push(`s.workspace_id = $${p.length}`); }
    if (q.mine === 'true') { p.push(req.admin!.adminId); where.push(`s.admin_id = $${p.length}`); where.push('s.ended_at is null and s.expires_at > now()'); }
    const rows = (await pool.query(
      `select s.id, s.workspace_id, w.name as workspace_name, s.support_case_id, s.mode, s.personal_data, s.started_at, s.expires_at, s.ended_at, s.ended_reason, s.views, s.actions, a.name as admin_name
         from support_access_sessions s join platform_admins a on a.id = s.admin_id join workspaces w on w.id = s.workspace_id
        ${where.length ? 'where ' + where.join(' and ') : ''} order by s.started_at desc limit 50`, p)).rows;
    return { items: camelAll(rows) };
  });

  adminRoute(app, { method: 'POST', url: '/support/access-sessions/:id/end', access: { perm: 'support.access_readonly' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    const s = (await pool.query<SessionRow>('select * from support_access_sessions where id = $1', [id])).rows[0];
    if (!s || s.admin_id !== req.admin!.adminId) throw notFound('Supportsessionen hittades inte.');
    if (s.ended_at) return { ok: true, alreadyEnded: true };
    await tx(async (c) => {
      await c.query(`update support_access_sessions set ended_at = now(), ended_reason = 'manual' where id = $1`, [id]);
      await audit(c, auditCtx(req), { action: 'support.access.ended', workspaceId: s.workspace_id, targetType: 'support_access_session', targetId: id, supportCaseId: s.support_case_id, reason: b.reason });
    });
    return { ok: true };
  });

  // Läsvy: konfiguration och aggregerad data. Personuppgifter endast med kundens godkännande.
  adminRoute(app, { method: 'GET', url: '/support/access-sessions/:id/view', access: { perm: 'support.access_readonly' } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const s = await activeSession(id, req.admin!.adminId);
    req.errCtx.workspaceId = s.workspace_id;
    const ws = (await pool.query(
      `select id, name, kind, country, status, created_at, last_activity_at, terms_version, dpa_version from workspaces where id = $1`, [s.workspace_id])).rows[0];
    const access = await loadWorkspaceAccess(pool, s.workspace_id);
    const roleCounts = (await pool.query(`select role, count(*)::int as n from workspace_members where workspace_id = $1 group by role`, [s.workspace_id])).rows;
    const flags = (await pool.query(
      `select f.key, coalesce(o.enabled, f.default_enabled) as enabled from feature_flags f left join feature_flag_overrides o on o.flag_key = f.key and o.workspace_id = $1 order by f.key`, [s.workspace_id])).rows;
    const errors = (await pool.query(`select at, code, message, route, status_code from system_errors where workspace_id = $1 order by at desc limit 10`, [s.workspace_id])).rows;
    const out: Record<string, unknown> = {
      session: { id: s.id, mode: s.mode, expiresAt: s.expires_at, remainingSeconds: Math.max(0, Math.floor((s.expires_at.getTime() - Date.now()) / 1000)), personalData: s.personal_data },
      notice: s.mode === 'assisted' ? 'Assisterad session. Endast åtgärder som kunden tillåtit kan utföras. Allt loggas och kunden informeras.' : 'Skrivskyddad supportvy. Inga ändringar kan göras. Åtkomsten loggas och kunden är informerad.',
      workspace: camel(ws), subscription: access?.subscription ?? null, products: access?.products ?? [],
      roleCounts, featureFlags: flags, recentErrors: camelAll(errors),
    };
    if (s.personal_data) {
      // Kontrollera att kundens godkännande fortfarande gäller (kan ha återkallats under sessionen)
      const g = (await pool.query(`select 1 from support_access_grants where id = (select grant_id from support_access_sessions where id = $1) and revoked_at is null and expires_at > now()`, [id])).rowCount;
      if (!g) throw forbidden('Kundens godkännande för personuppgifter har återkallats eller löpt ut.', 'GRANT_REVOKED');
      const members = (await pool.query(
        `select u.id as user_id, u.name, u.email, u.phone, m.role, u.status, u.last_login_at from workspace_members m join users u on u.id = m.user_id
          where m.workspace_id = $1 order by lower(u.name)`, [s.workspace_id])).rows;
      out.members = members.map((m) => ({ ...camel<Record<string, unknown>>(m), phone: maskPhone(m.phone as string | null) }));
    }
    if (s.mode === 'assisted') {
      // Assisterat läge: tillåtna åtgärder, och (endast om kunden tillåtit rolländring) namn och roll så att rätt medlem kan väljas. Aldrig e-post/telefon.
      const g = (await pool.query(
        `select g.allowed_actions from support_access_sessions s join support_access_grants g on g.id = s.grant_id
          where s.id = $1 and g.revoked_at is null and g.expires_at > now()`, [id])).rows[0];
      if (!g) throw forbidden('Kundens godkännande för assisterad support har återkallats eller löpt ut.', 'GRANT_REVOKED');
      out.allowedActions = g.allowed_actions;
      if ((g.allowed_actions as string[]).includes('enable_permission')) {
        out.assistedMembers = camelAll((await pool.query(
          `select u.id as user_id, u.name, m.role from workspace_members m join users u on u.id = m.user_id where m.workspace_id = $1 order by lower(u.name)`, [s.workspace_id])).rows);
      }
    }
    await tx(async (c) => {
      await c.query('update support_access_sessions set views = views + 1 where id = $1', [id]);
      await audit(c, auditCtx(req), { action: 'support.access.view', workspaceId: s.workspace_id, targetType: 'support_access_session', targetId: id, supportCaseId: s.support_case_id, meta: { personalData: s.personal_data } });
    });
    return out;
  });
}
