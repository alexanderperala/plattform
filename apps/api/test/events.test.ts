import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withWorkspace } from '../src/db/pool.js';
import { auditRows, custCall, makeApp, registerCustomer, resetDb, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

const day = 86_400_000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString();
const ev = (c: TestCustomer, extra = '') => `/workspaces/${c.workspaceId}/association/events${extra}`;
const call = (c: TestCustomer, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', extra = '', payload?: unknown, who = c) => custCall(app, { method, url: ev(c, extra), cookie: who.cookie, payload });
const newMember = async (c: TestCustomer, name: string) => (await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/association/members`, cookie: c.cookie, payload: { name } })).json().id as string;
async function withStaff() {
  const admin = await registerCustomer(app); const staff = await registerCustomer(app);
  await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [admin.workspaceId, staff.userId]);
  return { admin, staff };
}

describe('Föreningsportal: kalender', () => {
  it('skapar, publicerar, listar kommande/tidigare och ändrar utan att tappa fält', async () => {
    const c = await registerCustomer(app);
    const soon = (await call(c, 'POST', '', { title: 'Träning', startsAt: at(2), endsAt: at(2), location: 'Hallen', capacity: 20, description: 'Ta med vatten' })).json();
    const later = (await call(c, 'POST', '', { title: 'Årsmöte', startsAt: at(30) })).json();
    const past = (await call(c, 'POST', '', { title: 'Julfest', startsAt: at(-10), endsAt: at(-10) })).json();
    expect(soon).toMatchObject({ status: 'draft', capacity: 20, attendeeCount: 0, location: 'Hallen' });
    expect((await call(c, 'GET')).json().items.map((e: any) => e.title)).toEqual(['Träning', 'Årsmöte']);
    expect((await call(c, 'GET', '?scope=past')).json().items.map((e: any) => e.title)).toEqual(['Julfest']);
    expect((await call(c, 'GET', '?scope=all')).json().total).toBe(3);
    const up = await call(c, 'PATCH', `/${soon.id}`, { title: 'Torsdagsträning' });
    expect(up.json()).toMatchObject({ title: 'Torsdagsträning', description: 'Ta med vatten', location: 'Hallen', capacity: 20 }); // inget skrevs över
    expect((await call(c, 'PATCH', `/${soon.id}`, { location: '', capacity: null })).json()).toMatchObject({ location: null, capacity: null });
    expect((await call(c, 'POST', `/${later.id}/publish`)).json().status).toBe('published');
    expect(past.status).toBe('draft');
  });

  it('validerar tider, kapacitet och okända fält', async () => {
    const c = await registerCustomer(app);
    expect((await call(c, 'POST', '', { title: 'X', startsAt: 'imorgon' })).statusCode).toBe(400);
    expect((await call(c, 'POST', '', { title: 'X', startsAt: at(3), endsAt: at(2) })).json().error.code).toBe('INVALID_TIMES');
    expect((await call(c, 'POST', '', { title: 'X', startsAt: at(3), capacity: 0 })).statusCode).toBe(400);
    expect((await call(c, 'POST', '', { title: 'X', startsAt: at(3), status: 'published' })).statusCode).toBe(400);
    const e = (await call(c, 'POST', '', { title: 'Y', startsAt: at(3) })).json();
    expect((await call(c, 'PATCH', `/${e.id}`, { endsAt: at(1) })).json().error.code).toBe('INVALID_TIMES');
    expect((await call(c, 'PATCH', `/${e.id}`, {})).statusCode).toBe(400);
  });

  it('utkast och deltagarlista (personuppgifter) syns bara för ägare/admin', async () => {
    const { admin, staff } = await withStaff();
    const draft = (await call(admin, 'POST', '', { title: 'Utkast', startsAt: at(5) })).json();
    const live = (await call(admin, 'POST', '', { title: 'Öppen', startsAt: at(6) })).json();
    await call(admin, 'POST', `/${live.id}/publish`);
    const m = await newMember(admin, 'Anna Andersson');
    await call(admin, 'POST', `/${live.id}/attendees`, { memberId: m });
    expect((await call(admin, 'GET', '', undefined, staff)).json().items.map((e: any) => e.title)).toEqual(['Öppen']);
    expect((await call(admin, 'GET', `/${draft.id}`, undefined, staff)).statusCode).toBe(404);
    const asStaff = (await call(admin, 'GET', `/${live.id}`, undefined, staff)).json();
    expect(asStaff.attendeeCount).toBe(1);
    expect(asStaff.attendees).toBeUndefined();
    expect(JSON.stringify(asStaff)).not.toContain('Anna');
    expect((await call(admin, 'GET', `/${live.id}`)).json().attendees[0]).toMatchObject({ name: 'Anna Andersson' });
    expect((await call(admin, 'POST', '', { title: 'Nej', startsAt: at(1) }, staff)).statusCode).toBe(403);
    expect((await call(admin, 'POST', `/${live.id}/attendees`, { memberId: m }, staff)).statusCode).toBe(403);
    expect((await call(admin, 'DELETE', `/${live.id}`, undefined, staff)).statusCode).toBe(403);
  });

  it('anmäler medlemmar, nekar dubbletter, inaktiva och andra arbetsyters medlemmar', async () => {
    const a = await registerCustomer(app); const b = await registerCustomer(app);
    const e = (await call(a, 'POST', '', { title: 'Utflykt', startsAt: at(4) })).json();
    const m = await newMember(a, 'Bo'); const other = await newMember(b, 'Främling');
    expect((await call(a, 'POST', `/${e.id}/attendees`, { memberId: m })).statusCode).toBe(201);
    expect((await call(a, 'POST', `/${e.id}/attendees`, { memberId: m })).json().error.code).toBe('ALREADY_REGISTERED');
    expect((await call(a, 'POST', `/${e.id}/attendees`, { memberId: other })).statusCode).toBe(404);
    const inactive = await newMember(a, 'Vilande');
    await custCall(app, { method: 'PATCH', url: `/workspaces/${a.workspaceId}/association/members/${inactive}`, cookie: a.cookie, payload: { status: 'inactive' } });
    expect((await call(a, 'POST', `/${e.id}/attendees`, { memberId: inactive })).json().error.code).toBe('MEMBER_INACTIVE');
    expect((await call(a, 'GET', `/${e.id}`)).json().attendeeCount).toBe(1);
    expect((await call(a, 'DELETE', `/${e.id}/attendees/${m}`)).statusCode).toBe(200);
    expect((await call(a, 'DELETE', `/${e.id}/attendees/${m}`)).statusCode).toBe(404);
  });

  it('kapaciteten är atomär vid samtidiga anmälningar och kan inte sänkas under antal anmälda', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update product_entitlements set limits_override = '{"max_members":null}' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    const e = (await call(c, 'POST', '', { title: 'Begränsad', startsAt: at(4), capacity: 3 })).json();
    const members: string[] = [];
    for (let i = 0; i < 8; i++) members.push(await newMember(c, `Medlem ${i}`));
    const res = await Promise.all(members.map((m) => call(c, 'POST', `/${e.id}/attendees`, { memberId: m })));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(3);
    const full = res.filter((r) => r.statusCode === 409);
    expect(full).toHaveLength(5);
    expect(full[0]!.json().error.code).toBe('EVENT_FULL');
    expect((await call(c, 'GET', `/${e.id}`)).json().attendeeCount).toBe(3);
    const low = await call(c, 'PATCH', `/${e.id}`, { capacity: 2 });
    expect(low.statusCode).toBe(409); expect(low.json().error.code).toBe('CAPACITY_BELOW_ATTENDEES');
    expect((await call(c, 'PATCH', `/${e.id}`, { capacity: 3 })).statusCode).toBe(200);
  });

  it('raderar man en medlem eller aktivitet försvinner anmälningarna (inga kvarlevande kopplingar)', async () => {
    const c = await registerCustomer(app);
    const e = (await call(c, 'POST', '', { title: 'A', startsAt: at(4) })).json();
    const e2 = (await call(c, 'POST', '', { title: 'B', startsAt: at(5) })).json();
    const m = await newMember(c, 'Cia');
    await call(c, 'POST', `/${e.id}/attendees`, { memberId: m }); await call(c, 'POST', `/${e2.id}/attendees`, { memberId: m });
    const count = async () => (await pool.query('select count(*)::int as n from association_event_attendees')).rows[0].n;
    expect(await withWorkspace(c.workspaceId, async (x) => (await x.query('select count(*)::int as n from association_event_attendees')).rows[0].n)).toBe(2);
    await call(c, 'DELETE', `/${e2.id}`);
    expect(await withWorkspace(c.workspaceId, async (x) => (await x.query('select count(*)::int as n from association_event_attendees')).rows[0].n)).toBe(1);
    await custCall(app, { method: 'DELETE', url: `/workspaces/${c.workspaceId}/association/members/${m}`, cookie: c.cookie });
    expect(await withWorkspace(c.workspaceId, async (x) => (await x.query('select count(*)::int as n from association_event_attendees')).rows[0].n)).toBe(0);
    expect(await count()).toBe(0);
  });

  it('tenant-isolering och RLS: ingen kan läsa, ändra eller koppla över arbetsytor, ens på databasnivå', async () => {
    const a = await registerCustomer(app); const b = await registerCustomer(app);
    const e = (await call(a, 'POST', '', { title: 'A:s aktivitet', startsAt: at(4) })).json();
    const m = await newMember(a, 'A-medlem'); const bm = await newMember(b, 'B-medlem');
    expect((await call(a, 'GET', '', undefined, b)).statusCode).toBe(404);
    expect((await call(b, 'PATCH', `/${e.id}`, { title: 'Hackad' })).statusCode).toBe(404);
    expect((await call(b, 'POST', `/${e.id}/attendees`, { memberId: bm })).statusCode).toBe(404);
    expect((await call(b, 'DELETE', `/${e.id}`)).statusCode).toBe(404);
    expect((await pool.query('select 1 from association_events')).rowCount).toBe(0);
    expect((await pool.query('select 1 from association_event_attendees')).rowCount).toBe(0);
    // Sammansatt främmande nyckel: även en direkt SQL-kedja som försöker blanda arbetsytor nekas
    await expect(withWorkspace(a.workspaceId, (x) => x.query(`insert into association_event_attendees (event_id, member_id, workspace_id) values ($1,$2,$3)`, [e.id, bm, a.workspaceId]))).rejects.toThrow(/foreign key|violates/i);
    await call(a, 'POST', `/${e.id}/attendees`, { memberId: m });
    expect((await call(b, 'GET')).json().total).toBe(0);
  });

  it('åtkomstlägen, audit utan innehåll och kalendern räknas inte mot medlemsgränsen', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update product_entitlements set limits_override = '{"max_members":0}' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    const e = (await call(c, 'POST', '', { title: 'Hemlig titel', startsAt: at(4) })).json();
    expect(e.id).toBeTruthy();
    await call(c, 'POST', `/${e.id}/publish`);
    expect(JSON.stringify(await auditRows(`action like 'association.event.%'`))).not.toContain('Hemlig titel');
    await pool.query(`update workspaces set status = 'Suspended' where id = $1`, [c.workspaceId]);
    expect((await call(c, 'GET')).statusCode).toBe(200);
    expect((await call(c, 'POST', '', { title: 'Ny', startsAt: at(1) })).json().error.code).toBe('WORKSPACE_READ_ONLY');
    await pool.query(`update workspaces set status = 'Closed' where id = $1`, [c.workspaceId]);
    expect((await call(c, 'GET')).statusCode).toBe(403);
  });
});
