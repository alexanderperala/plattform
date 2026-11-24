import type { PoolClient } from 'pg';
import { conflict, notFound } from '../lib/errors.js';
import { WORKSPACE_TRANSITIONS } from '../domain/subscription.js';
import type { WorkspaceStatus } from '../domain/access.js';
import { audit, type AuditCtx } from './audit.js';
import { notifyWorkspaceAdmins } from './outbox.js';
import { getSetting } from './settings.js';

interface Ws { id: string; name: string; status: WorkspaceStatus; closed_at: Date | null }

async function lockWorkspace(db: PoolClient, id: string): Promise<Ws> {
  const { rows } = await db.query<Ws>('select id, name, status, closed_at from workspaces where id = $1 for update', [id]);
  if (!rows[0]) throw notFound('Arbetsytan hittades inte.');
  return rows[0];
}

async function revokeWorkspaceSessions(db: PoolClient, workspaceId: string): Promise<number> {
  const r = await db.query(
    `update user_sessions set revoked_at = now() where revoked_at is null
       and user_id in (select user_id from workspace_members where workspace_id = $1)`, [workspaceId]);
  return r.rowCount ?? 0;
}

export async function suspendWorkspace(db: PoolClient, ctx: AuditCtx, id: string, reason: string): Promise<void> {
  const ws = await lockWorkspace(db, id);
  if (!(WORKSPACE_TRANSITIONS[ws.status] as readonly string[]).includes('Suspended')) {
    throw conflict('INVALID_TRANSITION', `Arbetsytan kan inte pausas från status ${ws.status}.`);
  }
  await db.query(`update workspaces set status = 'Suspended', status_reason = $2, suspended_at = now(), updated_at = now() where id = $1`, [id, reason]);
  await audit(db, ctx, { action: 'workspace.suspend', severity: 'warning', workspaceId: id, targetType: 'workspace', targetId: id, reason, before: { status: ws.status }, after: { status: 'Suspended' } });
  await notifyWorkspaceAdmins(db, id, {
    kind: 'workspace_suspended', template: 'workspace_suspended', title: 'Din arbetsyta är pausad',
    body: `Arbetsytan ${ws.name} har pausats och är skrivskyddad. Du kan fortfarande logga in och exportera din data. Kontakta supporten för mer information.`,
  });
}

export async function reactivateWorkspace(db: PoolClient, ctx: AuditCtx, id: string, reason: string): Promise<void> {
  const ws = await lockWorkspace(db, id);
  if (ws.status === 'Active') throw conflict('INVALID_TRANSITION', 'Arbetsytan är redan aktiv.');
  if (ws.status === 'Closed') {
    const days = await getSetting<number>(db, 'retention.closed_workspace_days');
    const limit = ws.closed_at ? ws.closed_at.getTime() + days * 86_400_000 : 0;
    if (Date.now() > limit) {
      throw conflict('RETENTION_EXPIRED', `Arbetsytan avslutades för mer än ${days} dagar sedan och kan inte återaktiveras.`);
    }
  }
  await db.query(`update workspaces set status = 'Active', status_reason = $2, suspended_at = null, closed_at = null, updated_at = now() where id = $1`, [id, reason]);
  await audit(db, ctx, { action: 'workspace.reactivate', severity: ws.status === 'Closed' ? 'warning' : 'info', workspaceId: id, targetType: 'workspace', targetId: id, reason, before: { status: ws.status }, after: { status: 'Active' } });
  await notifyWorkspaceAdmins(db, id, {
    kind: 'workspace_reactivated', template: 'workspace_reactivated', title: 'Din arbetsyta är aktiv igen',
    body: `Arbetsytan ${ws.name} är återaktiverad och fungerar enligt ditt abonnemang.`,
  });
}

export async function closeWorkspace(db: PoolClient, ctx: AuditCtx, id: string, reason: string, meta: Record<string, unknown> = {}): Promise<void> {
  const ws = await lockWorkspace(db, id);
  if (ws.status === 'Closed') throw conflict('INVALID_TRANSITION', 'Arbetsytan är redan avslutad.');
  await db.query(`update workspaces set status = 'Closed', status_reason = $2, closed_at = now(), updated_at = now() where id = $1`, [id, reason]);
  const revoked = await revokeWorkspaceSessions(db, id);
  await audit(db, ctx, { action: 'workspace.close', severity: 'critical', workspaceId: id, targetType: 'workspace', targetId: id, reason, before: { status: ws.status }, after: { status: 'Closed' }, meta: { ...meta, sessionsRevoked: revoked } });
  await notifyWorkspaceAdmins(db, id, {
    kind: 'workspace_closed', template: 'workspace_closed', title: 'Din arbetsyta har avslutats',
    body: `Arbetsytan ${ws.name} har avslutats. Din data bevaras för export och återaktivering under retentionstiden.`,
  });
}

export async function revokeWorkspaceUserSessions(db: PoolClient, ctx: AuditCtx, id: string, reason: string): Promise<number> {
  await lockWorkspace(db, id);
  const n = await revokeWorkspaceSessions(db, id);
  await audit(db, ctx, { action: 'workspace.sessions_revoked', severity: 'warning', workspaceId: id, targetType: 'workspace', targetId: id, reason, meta: { sessionsRevoked: n } });
  return n;
}

/** Anonymiserar användaren (avsnitt 8.4). Nekas om användaren är ensam ägare till en arbetsyta som inte är avslutad. */
export async function deleteUser(db: PoolClient, ctx: AuditCtx, id: string, reason: string, meta: Record<string, unknown> = {}): Promise<void> {
  const u = await db.query<{ id: string; status: string }>('select id, status from users where id = $1 for update', [id]);
  if (!u.rows[0]) throw notFound('Användaren hittades inte.');
  if (u.rows[0].status === 'deleted') throw conflict('ALREADY_DELETED', 'Användaren är redan borttagen.');
  const sole = await db.query<{ name: string }>(
    `select w.name from workspace_members m join workspaces w on w.id = m.workspace_id
      where m.user_id = $1 and m.role = 'owner' and w.status <> 'Closed'
        and not exists (select 1 from workspace_members o where o.workspace_id = m.workspace_id and o.role = 'owner' and o.user_id <> m.user_id)`, [id]);
  if (sole.rows.length) {
    throw conflict('OWNER_TRANSFER_REQUIRED', `Användaren är ensam ägare till ${sole.rows.map((r) => r.name).join(', ')}. Överför ägarskapet först.`);
  }
  await db.query('delete from workspace_members where user_id = $1', [id]);
  await db.query('update user_sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
  await db.query('delete from user_tokens where user_id = $1', [id]);
  await db.query(
    `update users set name = 'Raderad användare', email = 'deleted+' || id::text || '@invalid', phone = null, password_hash = null,
        status = 'deleted', deleted_at = now(), updated_at = now() where id = $1`, [id]);
  await audit(db, ctx, { action: 'user.delete', severity: 'critical', userId: id, targetType: 'user', targetId: id, reason, before: { status: u.rows[0].status }, after: { status: 'deleted' }, meta });
}
