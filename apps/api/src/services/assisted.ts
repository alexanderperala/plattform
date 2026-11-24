import type { Db } from '../db/pool.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import type { AuditCtx } from './audit.js';
import { audit } from './audit.js';
import { notifyWorkspaceAdmins } from './outbox.js';

/** Åtgärdstyper som en kund kan tillåta (avsnitt 5.3). Allt annat är förbjudet i assisterat läge. */
export const ASSISTED_ACTIONS = ['change_setting', 'enable_permission', 'configure_feature'] as const;
export type AssistedAction = (typeof ASSISTED_ACTIONS)[number];

export const ASSISTED_LABELS: Record<AssistedAction, string> = {
  change_setting: 'Ändra felaktig inställning (arbetsytans uppgifter)',
  enable_permission: 'Aktivera behörighet (medlem ↔ administratör)',
  configure_feature: 'Hjälpa till med konfiguration av funktion',
};

export interface ActionInput {
  action: AssistedAction;
  params: Record<string, unknown>;
}

interface Perform { before: unknown; after: unknown; summary: string; target: { type: string; id: string } }

/** Utför en tillåten åtgärd. Förbjudna ändringar (ägare, abonnemang, betalning, lösenord, MFA, radering) finns inte här. */
export async function performAssisted(c: Db, workspaceId: string, a: ActionInput): Promise<Perform> {
  if (a.action === 'change_setting') {
    const p = a.params as { name?: string; contactName?: string; contactEmail?: string; orgNumber?: string | null };
    const cur = (await c.query('select name, contact_name, contact_email, org_number from workspaces where id = $1 for update', [workspaceId])).rows[0];
    if (!cur) throw notFound('Arbetsytan hittades inte.');
    const next = {
      name: p.name ?? cur.name, contact_name: p.contactName ?? cur.contact_name,
      contact_email: p.contactEmail ?? cur.contact_email, org_number: p.orgNumber === undefined ? cur.org_number : p.orgNumber,
    };
    await c.query('update workspaces set name=$2, contact_name=$3, contact_email=$4, org_number=$5, updated_at=now() where id=$1',
      [workspaceId, next.name, next.contact_name, next.contact_email, next.org_number]);
    return { before: cur, after: next, summary: 'Arbetsytans uppgifter ändrades', target: { type: 'workspace', id: workspaceId } };
  }
  if (a.action === 'enable_permission') {
    const p = a.params as { userId: string; role: 'admin' | 'member' };
    const cur = (await c.query('select role from workspace_members where workspace_id = $1 and user_id = $2 for update', [workspaceId, p.userId])).rows[0];
    if (!cur) throw notFound('Medlemmen hittades inte i arbetsytan.');
    if (cur.role === 'owner') throw new AppError(403, 'ACTION_FORBIDDEN', 'Ägarens roll kan inte ändras i assisterat läge.');
    await c.query('update workspace_members set role = $3 where workspace_id = $1 and user_id = $2', [workspaceId, p.userId, p.role]);
    return { before: { role: cur.role }, after: { role: p.role }, summary: `Medlemmens roll ändrades från ${cur.role} till ${p.role}`, target: { type: 'user', id: p.userId } };
  }
  const p = a.params as { flagKey: string; enabled: boolean };
  const flag = (await c.query('select key from feature_flags where key = $1', [p.flagKey])).rows[0];
  if (!flag) throw notFound('Funktionsflaggan finns inte.');
  const prev = (await c.query('select enabled from feature_flag_overrides where workspace_id = $1 and flag_key = $2', [workspaceId, p.flagKey])).rows[0];
  await c.query(
    `insert into feature_flag_overrides (workspace_id, flag_key, enabled) values ($1,$2,$3)
     on conflict (workspace_id, flag_key) do update set enabled = excluded.enabled`, [workspaceId, p.flagKey, p.enabled]);
  return { before: { enabled: prev?.enabled ?? null }, after: { enabled: p.enabled }, summary: `Funktionen ${p.flagKey} ${p.enabled ? 'aktiverades' : 'inaktiverades'}`, target: { type: 'feature_flag', id: p.flagKey } };
}

export async function runAssistedAction(
  c: Db, ctx: AuditCtx, s: { id: string; workspace_id: string; support_case_id: string; grant_id: string | null },
  adminName: string, a: ActionInput, reason: string,
): Promise<{ summary: string }> {
  // Kundens godkännande måste fortfarande gälla och åtgärdstypen måste vara tillåten
  const g = s.grant_id ? (await c.query(
    `select allowed_actions from support_access_grants where id = $1 and scope = 'assisted' and revoked_at is null and expires_at > now()`, [s.grant_id])).rows[0] : null;
  if (!g) throw new AppError(403, 'GRANT_REVOKED', 'Kundens godkännande för assisterad support har återkallats eller löpt ut.');
  if (!(g.allowed_actions as string[]).includes(a.action)) {
    throw new AppError(403, 'ACTION_NOT_ALLOWED', 'Kunden har inte tillåtit den här åtgärdstypen.', { action: a.action });
  }
  const r = await performAssisted(c, s.workspace_id, a);
  await c.query('update support_access_sessions set actions = actions + 1 where id = $1', [s.id]);
  await audit(c, ctx, {
    action: 'support.assisted.action', severity: 'warning', workspaceId: s.workspace_id, targetType: r.target.type, targetId: r.target.id,
    supportCaseId: s.support_case_id, reason, before: r.before, after: r.after, meta: { sessionId: s.id, assistedAction: a.action, grantId: s.grant_id },
  });
  await notifyWorkspaceAdmins(c, s.workspace_id, {
    kind: 'support_assisted_action', template: 'support_assisted_action', title: 'Supportpersonal har utfört en åtgärd åt er',
    body: `${adminName} (support) utförde en åtgärd för er räkning: ${r.summary}. Orsak: ${reason}.`,
  });
  return { summary: r.summary };
}
export { conflict };
