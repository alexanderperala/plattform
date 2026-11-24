import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withWorkspace } from '../src/db/pool.js';
import { deliverOutbox, type OutgoingMail } from '../src/services/mailer.js';
import { MAILING_MAX_PER_DAY, readUnsubscribeToken, unsubscribeToken } from '../src/http/customer/mailings.js';
import { auditRows, custCall, makeApp, registerCustomer, resetDb, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

type M = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const mail = (c: TestCustomer, method: M, extra = '', payload?: unknown, who = c) => custCall(app, { method, url: `/workspaces/${c.workspaceId}/association/mailings${extra}`, cookie: who.cookie, payload });
const addMember = async (c: TestCustomer, m: Record<string, unknown>) => (await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/association/members`, cookie: c.cookie, payload: m })).json();
const outbox = async (c: TestCustomer) => (await pool.query(`select to_email, subject, body, unsubscribe_url from notification_outbox where workspace_id = $1 and template = 'association_mailing' order by to_email`, [c.workspaceId])).rows;
const tokenFrom = (body: string) => /unsubscribe\?t=([\w.-]+)/.exec(body)![1]!;
const pub = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method, url: `/api/v1/public/unsubscribe${url}`, payload: payload as never, headers });
async function seeded() {
  const c = await registerCustomer(app);
  const a = await addMember(c, { name: 'Anna', email: 'anna@example.test' }); const b = await addMember(c, { name: 'Bo', email: 'bo@example.test' });
  await addMember(c, { name: 'Cia' }); await addMember(c, { name: 'Dan', email: 'dan@example.test', status: 'inactive' });
  const e = await addMember(c, { name: 'Eva', email: 'eva@example.test' });
  await withWorkspace(c.workspaceId, (cl) => cl.query(`update association_members set email_opt_out = true where id = $1`, [e.id]));
  return { c, a, b, e };
}
const draft = async (c: TestCustomer) => (await mail(c, 'POST', '', { subject: 'Årsmöte', body: 'Välkommen till årsmötet på torsdag.' })).json();

describe('Medlemsutskick', () => {
  it('skickar bara till aktiva, nåbara medlemmar som inte avanmält sig, och loggar vem som fått vad', async () => {
    const { c, a, b } = await seeded(); const m = await draft(c);
    const pre = (await mail(c, 'GET', `/${m.id}`)).json();
    expect(pre.audience).toEqual({ recipients: 2, noEmail: 1, optedOut: 1, inactive: 1 });
    const r = await mail(c, 'POST', `/${m.id}/send`); expect(r.json()).toEqual({ status: 'sent', recipientCount: 2 });
    const rows = await outbox(c); expect(rows.map((x) => x.to_email)).toEqual(['anna@example.test', 'bo@example.test']);
    for (const x of rows) { expect(x.subject).toBe('Årsmöte'); expect(x.body).toContain('Välkommen till årsmötet'); expect(x.body).toMatch(/Avsluta här: http\S+\/unsubscribe\?t=/); expect(x.unsubscribe_url).toContain('/unsubscribe?t='); }
    expect(new Set(rows.map((x) => tokenFrom(x.body))).size).toBe(2); // egen länk per mottagare
    const done = (await mail(c, 'GET', `/${m.id}`)).json();
    expect(done).toMatchObject({ status: 'sent', recipientCount: 2, audience: null }); expect(done.recipients.map((x: any) => x.name)).toEqual(['Anna', 'Bo']);
    expect(done.recipients.map((x: any) => x.memberId).sort()).toEqual([a.id, b.id].sort());
    expect((await mail(c, 'POST', `/${m.id}/send`)).json().error.code).toBe('MAILING_SENT');
    expect((await mail(c, 'PATCH', `/${m.id}`, { subject: 'Nytt' })).json().error.code).toBe('MAILING_SENT');
    expect((await mail(c, 'DELETE', `/${m.id}`)).json().error.code).toBe('MAILING_SENT');
    const log = await auditRows(`action = 'association.mailing.sent'`); expect(log).toHaveLength(1); expect(JSON.stringify(log[0])).not.toContain('anna@example.test'); // ingen adress i auditloggen
    expect((await mail(c, 'GET')).json().items[0]).toMatchObject({ status: 'sent', recipientCount: 2 });
  });

  it('avanmälan: signerad länk, bekräftelse via POST, idempotent, utesluter medlemmen nästa gång', async () => {
    const { c, a } = await seeded(); const m = await draft(c); await mail(c, 'POST', `/${m.id}/send`);
    const tok = tokenFrom((await outbox(c)).find((x) => x.to_email === 'anna@example.test')!.body);
    expect(readUnsubscribeToken(tok)).toEqual({ workspaceId: c.workspaceId, memberId: a.id });
    expect((await pub('GET', `?t=${tok}`)).json().associationName).toBeTruthy();
    expect((await withWorkspace(c.workspaceId, (cl) => cl.query('select email_opt_out from association_members where id = $1', [a.id]))).rows[0].email_opt_out).toBe(false); // GET ändrar inget
    expect((await pub('POST', '', { token: tok })).statusCode).toBe(200);
    expect((await pub('POST', '', { token: tok })).statusCode).toBe(200); // upprepat klick
    const row = (await withWorkspace(c.workspaceId, (cl) => cl.query('select email_opt_out, email_opt_out_at from association_members where id = $1', [a.id]))).rows[0];
    expect(row.email_opt_out).toBe(true); expect(row.email_opt_out_at).not.toBeNull();
    expect(await auditRows(`action = 'association.member.unsubscribed'`)).toHaveLength(1);
    const bo = tokenFrom((await outbox(c)).find((x) => x.to_email === 'bo@example.test')!.body);
    expect((await pub('POST', `?t=${bo}`, 'List-Unsubscribe=One-Click', { 'content-type': 'application/x-www-form-urlencoded' })).statusCode).toBe(200); // RFC 8058
    const m2 = await draft(c); expect((await mail(c, 'GET', `/${m2.id}`)).json().audience.recipients).toBe(0);
    expect((await mail(c, 'POST', `/${m2.id}/send`)).json().error.code).toBe('NO_RECIPIENTS');
  });

  it('förfalskade, ändrade och främmande länkar avvisas', async () => {
    const { c, a } = await seeded(); const other = await registerCustomer(app);
    const good = unsubscribeToken(c.workspaceId, a.id);
    const [p, sig] = good.split('.');
    const forged = `${Buffer.from(`${other.workspaceId}.${a.id}`).toString('base64url')}.${sig}`; // byt arbetsyta, behåll signaturen
    for (const t of [forged, `${p}.AAAA`, `${p}`, 'skräp', '', `${good}.x`]) expect((await pub('POST', '', { token: t })).statusCode, t).toBe(400);
    expect((await pub('POST', '', {})).statusCode).toBe(400);
    expect((await withWorkspace(c.workspaceId, (cl) => cl.query('select email_opt_out from association_members where id = $1', [a.id]))).rows[0].email_opt_out).toBe(false);
    // en giltig länk i arbetsyta A kan aldrig påverka medlem i arbetsyta B
    const bm = await addMember(other, { name: 'Zed', email: 'z@example.test' });
    await pub('POST', '', { token: unsubscribeToken(c.workspaceId, bm.id) });
    expect((await withWorkspace(other.workspaceId, (cl) => cl.query('select email_opt_out from association_members where id = $1', [bm.id]))).rows[0].email_opt_out).toBe(false);
  });

  it('validering, dygnsgräns, roller, isolering och åtkomstlägen', async () => {
    const { c } = await seeded(); const other = await registerCustomer(app);
    expect((await mail(c, 'POST', '', { subject: 'A\nBcc: x@y.z', body: 'x' })).statusCode).toBe(400); // header-injektion
    expect((await mail(c, 'POST', '', { subject: '', body: 'x' })).statusCode).toBe(400);
    expect((await mail(c, 'POST', '', { subject: 'S', body: 'x', extra: 1 })).statusCode).toBe(400);
    const m = await draft(c); expect((await mail(c, 'PATCH', `/${m.id}`, { body: 'Ändrad text' })).statusCode).toBe(200);
    expect((await mail(c, 'GET', `/${m.id}`)).json()).toMatchObject({ subject: 'Årsmöte', body: 'Ändrad text' });
    const staff = await registerCustomer(app); await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [c.workspaceId, staff.userId]);
    for (const [meth, p, b] of [['GET', '', undefined], ['POST', '', { subject: 'x', body: 'y' }], ['POST', `/${m.id}/send`, undefined]] as const) expect((await mail(c, meth, p, b, staff)).statusCode).toBe(403);
    expect((await mail(other, 'GET', `/${m.id}`)).statusCode).toBe(404); expect((await mail(other, 'POST', `/${m.id}/send`)).statusCode).toBe(404);
    expect((await mail(c, 'GET', '', undefined, other)).statusCode).toBe(404);
    expect((await mail(other, 'GET')).json().items).toHaveLength(0);
    await pool.query(`update workspaces set status = 'Suspended' where id = $1`, [c.workspaceId]);
    expect((await mail(c, 'POST', `/${m.id}/send`)).json().error.code).toBe('WORKSPACE_READ_ONLY'); expect((await mail(c, 'GET')).statusCode).toBe(200);
    await pool.query(`update workspaces set status = 'Active' where id = $1`, [c.workspaceId]);
    for (let i = 0; i < MAILING_MAX_PER_DAY; i++) { const x = await draft(c); expect((await mail(c, 'POST', `/${x.id}/send`)).statusCode, `utskick ${i + 1}`).toBe(200); }
    const over = await draft(c); expect((await mail(c, 'POST', `/${over.id}/send`)).json().error.code).toBe('MAILING_LIMIT');
    expect((await outbox(c)).length).toBe(2 * MAILING_MAX_PER_DAY); // det avvisade utskicket köade inget
    expect((await mail(c, 'DELETE', `/${over.id}`)).statusCode).toBe(204);
  });

  it('parallella sändningar av samma utskick ger exakt en sändning', async () => {
    const { c } = await seeded(); const m = await draft(c);
    const rs = await Promise.all([1, 2, 3].map(() => mail(c, 'POST', `/${m.id}/send`)));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1); expect((await outbox(c)).length).toBe(2);
  });

  it('e-postleveransen skickar List-Unsubscribe-länken med varje utskick', async () => {
    const { c } = await seeded(); const m = await draft(c); await mail(c, 'POST', `/${m.id}/send`);
    const sent: OutgoingMail[] = [];
    await deliverOutbox(pool, { name: 'test', send: async (x) => { sent.push(x); return { messageId: 'x' }; } }, 100);
    const mailings = sent.filter((x) => x.unsubscribeUrl); expect(mailings).toHaveLength(2);
    for (const x of mailings) expect(x.text).toContain(x.unsubscribeUrl!);
  });
});
