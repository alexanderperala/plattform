import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { enqueueEmail } from '../src/services/outbox.js';
import { deliverOutbox, type MailTransport, type OutgoingMail } from '../src/services/mailer.js';
import { adminCall, createAdmin, loginAdmin, makeApp, resetDb } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

class Fake implements MailTransport {
  name = 'fake'; sent: OutgoingMail[] = []; failTimes = 0;
  async send(m: OutgoingMail) { if (this.failTimes > 0) { this.failTimes--; throw new Error('SMTP 451 tillfälligt fel'); } this.sent.push(m); return { messageId: `<${m.id}@test>` }; }
}
const row = async () => (await pool.query(`select status, attempts, error, body, message_id, next_attempt_at > now() as delayed from notification_outbox order by created_at limit 1`)).rows[0];

describe('utkorgsleverans', () => {
  it('skickar väntande mejl en gång och markerar dem som skickade', async () => {
    const t = new Fake();
    await enqueueEmail(pool, { to: 'a@example.test', template: 'support_reply', subject: 'Hej', body: 'Text' });
    expect(await deliverOutbox(pool, t)).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(await deliverOutbox(pool, t)).toEqual({ sent: 0, failed: 0, retried: 0 }); // inte igen
    expect(t.sent).toHaveLength(1);
    const r = await row();
    expect(r.status).toBe('sent'); expect(r.message_id).toBeTruthy(); expect(r.body).toBe('Text');
  });

  it('utan transport skickas inget och inget markeras som skickat', async () => {
    await enqueueEmail(pool, { to: 'a@example.test', template: 'x', subject: 'S', body: 'B' });
    expect(await deliverOutbox(pool, null)).toEqual({ sent: 0, failed: 0, retried: 0 });
    expect((await row()).status).toBe('pending');
  });

  it('rensar engångslänkar ur brödtexten efter lyckad leverans', async () => {
    await enqueueEmail(pool, { to: 'a@example.test', template: 'password_reset', subject: 'Återställ', body: 'https://x/reset?token=hemlig' });
    await deliverOutbox(pool, new Fake());
    const r = await row();
    expect(r.status).toBe('sent'); expect(r.body).not.toContain('hemlig');
  });

  it('misslyckande ger omförsök med backoff och därefter failed', async () => {
    const t = new Fake(); t.failTimes = 99;
    await enqueueEmail(pool, { to: 'a@example.test', template: 'x', subject: 'S', body: 'B' });
    expect(await deliverOutbox(pool, t)).toEqual({ sent: 0, failed: 0, retried: 1 });
    let r = await row();
    expect(r.status).toBe('pending'); expect(r.delayed).toBe(true); expect(r.error).toContain('451');
    expect(await deliverOutbox(pool, t)).toEqual({ sent: 0, failed: 0, retried: 0 }); // väntar på backoff
    for (let i = 0; i < 5; i++) {
      await pool.query(`update notification_outbox set next_attempt_at = now() - interval '1 minute'`);
      await deliverOutbox(pool, t);
    }
    r = await row();
    expect(r.status).toBe('failed'); expect(r.attempts).toBe(6);
  });

  it('ett tillfälligt fel följt av lyckat försök skickar mejlet', async () => {
    const t = new Fake(); t.failTimes = 1;
    await enqueueEmail(pool, { to: 'a@example.test', template: 'x', subject: 'S', body: 'B' });
    await deliverOutbox(pool, t);
    await pool.query(`update notification_outbox set next_attempt_at = now() - interval '1 minute'`);
    expect((await deliverOutbox(pool, t)).sent).toBe(1);
    expect((await row()).status).toBe('sent');
  });

  it('parallella leveranser skickar aldrig samma mejl två gånger', async () => {
    const t = new Fake();
    for (let i = 0; i < 10; i++) await enqueueEmail(pool, { to: `u${i}@example.test`, template: 'x', subject: 'S', body: 'B' });
    await Promise.all([deliverOutbox(pool, t, 5), deliverOutbox(pool, t, 5), deliverOutbox(pool, t, 5), deliverOutbox(pool, t, 5)]);
    expect(t.sent.length).toBe(new Set(t.sent.map((m) => m.id)).size);
    expect(t.sent.length).toBeGreaterThanOrEqual(10);
  });
});

describe('svar till kund via supportärende', () => {
  async function mkCase(cookie: string, extra: object = {}) {
    return (await adminCall(app, { method: 'POST', url: '/support/cases', cookie, payload: { subject: 'Hjälp med inloggning', ...extra } })).json().id as string;
  }
  it('kräver mottagare, nekar stängda ärenden och skickar annars med ärendenummer', async () => {
    const a = await createAdmin('support_admin'); const cookie = await loginAdmin(app, a);
    const noRecipient = await mkCase(cookie);
    const r1 = await adminCall(app, { method: 'POST', url: `/support/cases/${noRecipient}/comments`, cookie, payload: { body: 'Svar', internal: false } });
    expect(r1.statusCode).toBe(409); expect(r1.json().error.code).toBe('NO_RECIPIENT');
    const id = await mkCase(cookie, { requesterEmail: 'kund@example.test' });
    const ok = await adminCall(app, { method: 'POST', url: `/support/cases/${id}/comments`, cookie, payload: { body: 'Vi har återställt ditt konto.', internal: false } });
    expect(ok.statusCode).toBe(201);
    const t = new Fake(); await deliverOutbox(pool, t);
    expect(t.sent).toHaveLength(1); expect(t.sent[0]!.to).toBe('kund@example.test'); expect(t.sent[0]!.subject).toMatch(/^\[Ärende #\d+\]/);
    // intern kommentar skickar inget
    await adminCall(app, { method: 'POST', url: `/support/cases/${id}/comments`, cookie, payload: { body: 'Intern notering', internal: true } });
    expect((await pool.query(`select count(*)::int n from notification_outbox where template = 'support_reply'`)).rows[0].n).toBe(1);
    // stängt ärende
    await adminCall(app, { method: 'PATCH', url: `/support/cases/${id}`, cookie, payload: { status: 'Resolved' } });
    await adminCall(app, { method: 'PATCH', url: `/support/cases/${id}`, cookie, payload: { status: 'Closed' } });
    const closed = await adminCall(app, { method: 'POST', url: `/support/cases/${id}/comments`, cookie, payload: { body: 'Sent', internal: false } });
    expect(closed.json().error.code).toBe('CASE_CLOSED');
    // revisionsloggen innehåller inte mottagarens e-postadress
    const audit = (await pool.query(`select meta from admin_audit_log where action = 'support.comment_added' and meta->>'internal' = 'false'`)).rows;
    expect(JSON.stringify(audit)).not.toContain('kund@example.test');
  });
  it('läsbehörig roll kan inte svara kund', async () => {
    const a = await createAdmin('readonly_admin'); const cookie = await loginAdmin(app, a);
    const r = await adminCall(app, { method: 'POST', url: `/support/cases/00000000-0000-4000-8000-000000000000/comments`, cookie, payload: { body: 'x', internal: false } });
    expect(r.statusCode).toBe(403);
  });
});
