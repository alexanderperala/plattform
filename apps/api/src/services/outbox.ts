import type { Db } from '../db/pool.js';
import { maskDeep } from '../lib/mask.js';

export interface EmailMessage {
  workspaceId?: string | null;
  userId?: string | null;
  to: string;
  template: string;
  subject: string;
  body: string;
  payload?: Record<string, unknown>;
  unsubscribeUrl?: string;
}

/** E-post läggs i utkorgen. Transport (SMTP) kopplas på i Fas S1. Tills dess markeras inget som skickat. */
export async function enqueueEmail(db: Db, m: EmailMessage): Promise<void> {
  await db.query(
    `insert into notification_outbox (workspace_id, user_id, to_email, template, subject, body, payload, unsubscribe_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [m.workspaceId ?? null, m.userId ?? null, m.to, m.template, m.subject, m.body, JSON.stringify(maskDeep(m.payload ?? {})), m.unsubscribeUrl ?? null],
  );
}

/** Notis i produkten plus e-post till alla arbetsytans ägare och administratörer. Kan inte stängas av. */
export async function notifyWorkspaceAdmins(
  db: Db,
  workspaceId: string,
  n: { kind: string; title: string; body: string; template: string },
): Promise<number> {
  await db.query(`insert into workspace_notifications (workspace_id, kind, title, body) values ($1,$2,$3,$4)`, [
    workspaceId, n.kind, n.title, n.body,
  ]);
  const { rows } = await db.query<{ id: string; email: string }>(
    `select u.id, u.email from workspace_members m join users u on u.id = m.user_id
      where m.workspace_id = $1 and m.role in ('owner','admin') and u.status <> 'deleted'`,
    [workspaceId],
  );
  for (const r of rows) {
    await enqueueEmail(db, { workspaceId, userId: r.id, to: r.email, template: n.template, subject: n.title, body: n.body });
  }
  return rows.length;
}
