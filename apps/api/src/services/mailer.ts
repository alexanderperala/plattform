import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';

export interface OutgoingMail { id: string; to: string; subject: string; text: string; unsubscribeUrl?: string }
export interface MailTransport { name: string; send(m: OutgoingMail): Promise<{ messageId: string }> }

export class SmtpTransport implements MailTransport {
  name = 'smtp';
  private t = nodemailer.createTransport({
    host: config.mail.smtpHost, port: config.mail.smtpPort, secure: config.mail.smtpSecure,
    auth: config.mail.smtpUser ? { user: config.mail.smtpUser, pass: config.mail.smtpPass } : undefined,
    connectionTimeout: 10_000, socketTimeout: 20_000,
  });
  async send(m: OutgoingMail) {
    const r = await this.t.sendMail({ from: config.mail.from, to: m.to, subject: m.subject, text: m.text, headers: { 'X-Outbox-Id': m.id, ...(m.unsubscribeUrl ? { 'List-Unsubscribe': `<${m.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}) } });
    return { messageId: String(r.messageId) };
  }
}

/** Utveckling: skriver ett .eml per meddelande till en katalog. */
export class FileTransport implements MailTransport {
  name = 'file';
  constructor(private dir = config.mail.fileDir) {}
  async send(m: OutgoingMail) {
    await mkdir(this.dir, { recursive: true });
    const raw = `From: ${config.mail.from}\r\nTo: ${m.to}\r\nSubject: ${m.subject}\r\n${m.unsubscribeUrl ? `List-Unsubscribe: <${m.unsubscribeUrl}>\r\n` : ''}Content-Type: text/plain; charset=utf-8\r\n\r\n${m.text}\r\n`;
    await writeFile(join(this.dir, `${Date.now()}-${m.id}.eml`), raw, { mode: 0o600 });
    return { messageId: `file:${m.id}` };
  }
}

export function createTransport(): MailTransport | null {
  if (config.mail.transport === 'smtp') return new SmtpTransport();
  if (config.mail.transport === 'file') return new FileTransport();
  return null;
}

// Mallar vars brödtext innehåller engångslänkar. Brödtexten rensas efter lyckad leverans.
const SENSITIVE_TEMPLATES = ['password_reset', 'email_verify', 'invite'];
const backoffMinutes = (attempt: number) => Math.min(60, 2 ** attempt); // 2, 4, 8, … max 60 min

export interface DeliveryResult { sent: number; failed: number; retried: number }

/**
 * Skickar förfallna meddelanden ur utkorgen. `for update skip locked` gör att flera instanser inte skickar samma mejl två gånger.
 * Raden "leasas" i 5 minuter medan den skickas; kraschar arbetaren försöks den igen efteråt (minst en gång).
 * Misslyckade försök görs om med backoff; efter maxAttempts markeras meddelandet som failed (syns på översikten).
 */
export async function deliverOutbox(db: Db, transport: MailTransport | null, batch = 25): Promise<DeliveryResult> {
  const res: DeliveryResult = { sent: 0, failed: 0, retried: 0 };
  if (!transport) return res;
  const { rows } = await db.query<{ id: string; to_email: string; subject: string; body: string; template: string; attempts: number; unsubscribe_url: string | null }>(
    `update notification_outbox o set last_attempt_at = now(), attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes' -- lease: andra arbetare hoppar över raden
      where o.id in (select id from notification_outbox where status = 'pending' and next_attempt_at <= now()
                      order by created_at limit $1 for update skip locked)
      returning o.id, o.to_email, o.subject, o.body, o.template, o.attempts, o.unsubscribe_url`, [batch]);
  for (const m of rows) {
    try {
      const r = await transport.send({ id: m.id, to: m.to_email, subject: m.subject, text: m.body, unsubscribeUrl: m.unsubscribe_url ?? undefined });
      await db.query(
        `update notification_outbox set status = 'sent', sent_at = now(), error = null, message_id = $2,
                body = case when template = any($3) then '[innehåll rensat efter leverans]' else body end where id = $1`,
        [m.id, r.messageId, SENSITIVE_TEMPLATES]);
      res.sent++;
    } catch (e) {
      const err = (e as Error).message.slice(0, 500);
      const final = m.attempts >= config.mail.maxAttempts;
      await db.query(
        `update notification_outbox set status = $2, error = $3, next_attempt_at = now() + make_interval(mins => $4) where id = $1`,
        [m.id, final ? 'failed' : 'pending', err, backoffMinutes(m.attempts)]);
      if (final) res.failed++; else res.retried++;
    }
  }
  return res;
}
