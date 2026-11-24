import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withWorkspace } from '../src/db/pool.js';
import { auditRows, custCall, makeApp, registerCustomer, resetDb, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

const u = (c: TestCustomer, extra = '') => `/workspaces/${c.workspaceId}/association/news${extra}`;
const call = (c: TestCustomer, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', extra = '', payload?: unknown, who = c) => custCall(app, { method, url: u(c, extra), cookie: who.cookie, payload });
async function withStaff() {
  const admin = await registerCustomer(app); const staff = await registerCustomer(app);
  await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [admin.workspaceId, staff.userId]);
  return { admin, staff };
}

describe('Föreningsportal: nyheter', () => {
  it('skapar utkast, publicerar, fäster och avpublicerar med audit utan innehåll', async () => {
    const c = await registerCustomer(app);
    const d = await call(c, 'POST', '', { title: 'Årsmöte', body: 'Rad 1\nRad 2' });
    expect(d.statusCode).toBe(201);
    expect(d.json()).toMatchObject({ status: 'draft', publishedAt: null, pinned: false });
    const id = d.json().id;
    const pub = await call(c, 'POST', `/${id}/publish`);
    expect(pub.json()).toMatchObject({ status: 'published' });
    expect(pub.json().publishedAt).toBeTruthy();
    const firstPublished = pub.json().publishedAt;
    await call(c, 'POST', `/${id}/unpublish`);
    const again = await call(c, 'POST', `/${id}/publish`);
    expect(again.json().publishedAt).toBe(firstPublished); // ursprungligt publiceringsdatum bevaras
    expect((await call(c, 'PATCH', `/${id}`, { pinned: true, title: 'Årsmöte 2026' })).json()).toMatchObject({ pinned: true, title: 'Årsmöte 2026', body: 'Rad 1\nRad 2' });
    const log = await auditRows(`action like 'association.news.%'`);
    expect(log.map((l) => l.action)).toEqual(['association.news.published', 'association.news.unpublished', 'association.news.published']);
    expect(JSON.stringify(log)).not.toContain('Årsmöte');
  });

  it('utkast syns bara för ägare/admin; vanliga medlemmar ser endast publicerat (backend avgör)', async () => {
    const { admin, staff } = await withStaff();
    const draft = (await call(admin, 'POST', '', { title: 'Hemligt utkast' })).json();
    const live = (await call(admin, 'POST', '', { title: 'Offentlig nyhet' })).json();
    await call(admin, 'POST', `/${live.id}/publish`);
    const asAdmin = (await call(admin, 'GET')).json();
    expect(asAdmin.items.map((n: any) => n.title).sort()).toEqual(['Hemligt utkast', 'Offentlig nyhet']);
    expect(asAdmin.canManage).toBe(true);
    const asStaff = (await call(admin, 'GET', '', undefined, staff)).json();
    expect(asStaff.items.map((n: any) => n.title)).toEqual(['Offentlig nyhet']);
    expect(asStaff.total).toBe(1);
    expect(asStaff.canManage).toBe(false);
    // status=draft ändrar inte vad en medlem får se
    expect((await call(admin, 'GET', '?status=draft', undefined, staff)).json().items).toHaveLength(1);
    expect((await call(admin, 'GET', '?status=draft')).json().items.map((n: any) => n.id)).toEqual([draft.id]);
    // skrivning nekas
    expect((await call(admin, 'POST', '', { title: 'Nej' }, staff)).statusCode).toBe(403);
    expect((await call(admin, 'POST', `/${draft.id}/publish`, undefined, staff)).statusCode).toBe(403);
    expect((await call(admin, 'DELETE', `/${live.id}`, undefined, staff)).statusCode).toBe(403);
    expect((await call(admin, 'PATCH', `/${live.id}`, { title: 'Hackad' }, staff)).statusCode).toBe(403);
  });

  it('sorterar fästa först, därefter nyast publicerad; pagination fungerar', async () => {
    const c = await registerCustomer(app);
    const ids: string[] = [];
    for (let i = 1; i <= 12; i++) { const n = (await call(c, 'POST', '', { title: `Nyhet ${i}` })).json(); await call(c, 'POST', `/${n.id}/publish`); ids.push(n.id); await new Promise((r) => setTimeout(r, 5)); }
    await call(c, 'PATCH', `/${ids[0]}`, { pinned: true });
    const p1 = (await call(c, 'GET')).json();
    expect(p1.total).toBe(12);
    expect(p1.items).toHaveLength(10);
    expect(p1.items[0].title).toBe('Nyhet 1');
    expect(p1.items[1].title).toBe('Nyhet 12');
    expect((await call(c, 'GET', '?page=2')).json().items).toHaveLength(2);
  });

  it('validerar indata: tom titel, för långt innehåll och okända fält nekas', async () => {
    const c = await registerCustomer(app);
    expect((await call(c, 'POST', '', { title: '' })).statusCode).toBe(400);
    expect((await call(c, 'POST', '', { title: 'x', body: 'a'.repeat(20_001) })).statusCode).toBe(400);
    expect((await call(c, 'POST', '', { title: 'x', status: 'published' })).statusCode).toBe(400); // publicering går bara via publish
    expect((await call(c, 'PATCH', `/00000000-0000-4000-8000-000000000000`, {})).statusCode).toBe(400);
    expect((await call(c, 'PATCH', `/00000000-0000-4000-8000-000000000000`, { title: 'x' })).statusCode).toBe(404);
  });

  it('script i innehåll lagras som text (renderas aldrig som HTML) och returneras oförändrat', async () => {
    const c = await registerCustomer(app);
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const n = (await call(c, 'POST', '', { title: evil, body: evil })).json();
    expect(n.title).toBe(evil);
    expect(n.body).toBe(evil);
  });

  it('tenant-isolering: annan arbetsyta når varken läsa, ändra, publicera eller radera', async () => {
    const a = await registerCustomer(app); const b = await registerCustomer(app);
    const n = (await call(a, 'POST', '', { title: 'A:s nyhet' })).json();
    expect((await call(a, 'GET', '', undefined, b)).statusCode).toBe(404);
    expect((await call(b, 'PATCH', `/${n.id}`, { title: 'Hackad' })).statusCode).toBe(404);
    expect((await call(b, 'POST', `/${n.id}/publish`)).statusCode).toBe(404);
    expect((await call(b, 'DELETE', `/${n.id}`)).statusCode).toBe(404);
    expect((await call(b, 'GET')).json().total).toBe(0);
    expect((await pool.query('select 1 from association_news')).rowCount).toBe(0); // RLS: ingen kontext, inga rader
    expect((await withWorkspace(a.workspaceId, (x) => x.query('select title from association_news'))).rows[0].title).toBe('A:s nyhet');
    await expect(withWorkspace(a.workspaceId, (x) => x.query(`insert into association_news (workspace_id, title) values ($1,'Intrång')`, [b.workspaceId]))).rejects.toThrow(/row-level security/i);
    expect((await call(a, 'GET')).json().items[0].title).toBe('A:s nyhet');
  });

  it('åtkomstlägen: pausad = läsning, avslutad/inaktiverad = nekad, och radering ger 404 andra gången', async () => {
    const c = await registerCustomer(app);
    const n = (await call(c, 'POST', '', { title: 'Kvar' })).json();
    await pool.query(`update workspaces set status = 'Suspended' where id = $1`, [c.workspaceId]);
    expect((await call(c, 'GET')).statusCode).toBe(200);
    expect((await call(c, 'GET')).json().canManage).toBe(false);
    const w = await call(c, 'POST', '', { title: 'Ny' });
    expect(w.statusCode).toBe(403); expect(w.json().error.code).toBe('WORKSPACE_READ_ONLY');
    await pool.query(`update workspaces set status = 'Closed' where id = $1`, [c.workspaceId]);
    expect((await call(c, 'GET')).statusCode).toBe(403);
    await pool.query(`update workspaces set status = 'Active' where id = $1`, [c.workspaceId]);
    await pool.query(`update product_entitlements set status = 'Disabled' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    expect((await call(c, 'GET')).json().error.code).toBe('PRODUCT_NOT_AVAILABLE');
    await pool.query(`update product_entitlements set status = 'Enabled' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    expect((await call(c, 'DELETE', `/${n.id}`)).statusCode).toBe(200);
    expect((await call(c, 'DELETE', `/${n.id}`)).statusCode).toBe(404);
  });

  it('nyheter räknas inte mot medlemsgränsen och blockeras inte när den är nådd', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update product_entitlements set limits_override = '{"max_members":0}' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    expect((await call(c, 'POST', '', { title: 'Fungerar ändå' })).statusCode).toBe(201);
  });
});
