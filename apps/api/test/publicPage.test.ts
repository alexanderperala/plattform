import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withWorkspace } from '../src/db/pool.js';
import { auditRows, custCall, makeApp, registerCustomer, resetDb, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

const reg = (over: Record<string, unknown> = {}) => registerCustomer(app, { products: ['association_portal', 'tournament_system'], ...over });
const page = (c: TestCustomer, method: 'GET' | 'PUT', payload?: unknown, who = c) => custCall(app, { method, url: `/workspaces/${c.workspaceId}/public-page`, cookie: who.cookie, payload });
const tour = (c: TestCustomer, method: 'GET' | 'POST' | 'PATCH', extra = '', payload?: unknown) => custCall(app, { method, url: `/workspaces/${c.workspaceId}/tournaments${extra}`, cookie: c.cookie, payload });
const news = (c: TestCustomer, extra = '', payload?: unknown) => custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/association/news${extra}`, cookie: c.cookie, payload });
const pubGet = (url: string, ip = '10.0.0.1') => app.inject({ method: 'GET', url: `/api/v1/public/pages/${url}`, remoteAddress: ip });
const enable = (c: TestCustomer, slug: string) => page(c, 'PUT', { enabled: true, slug, showNews: true, consent: true });

async function runningTournament(c: TestCustomer, name = 'Vårcupen') {
  const t = (await tour(c, 'POST', '', { name })).json();
  for (const n of ['Lag Alfa', 'Lag Beta', 'Lag Gamma']) await tour(c, 'POST', `/${t.id}/teams`, { name: n });
  await tour(c, 'POST', `/${t.id}/start`);
  return t.id as string;
}

describe('Publik sida (opt-in)', () => {
  it('är avstängd som standard: inget syns och turneringar kan inte publiceras', async () => {
    const c = await reg(); const id = await runningTournament(c);
    expect((await page(c, 'GET')).json().page).toBeNull();
    expect((await pubGet('forening')).statusCode).toBe(404);
    expect((await tour(c, 'PATCH', `/${id}`, { isPublic: true })).json().error.code).toBe('PUBLIC_PAGE_DISABLED');
    expect((await tour(c, 'GET', `/${id}`)).json().isPublic).toBe(false);
  });

  it('kräver uttryckligt samtycke, loggar det och validerar adressen', async () => {
    const c = await reg();
    const r = await page(c, 'PUT', { enabled: true, slug: 'min-forening', showNews: true });
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe('CONSENT_REQUIRED');
    expect((await pubGet('min-forening')).statusCode).toBe(404);
    for (const bad of ['ab', 'Admin', 'api', 'a--b', '-abc', 'har mellanslag', 'x'.repeat(41)]) expect((await page(c, 'PUT', { enabled: true, slug: bad, consent: true })).statusCode, bad).toBe(400);
    expect((await enable(c, 'Min-Forening')).statusCode).toBe(200); // normaliseras till gemener
    const g = (await page(c, 'GET')).json();
    expect(g.page).toMatchObject({ slug: 'min-forening', enabled: true, showNews: true, consentVersion: g.consentVersion }); expect(g.page.consentAt).not.toBeNull();
    expect(await auditRows(`action = 'public_page.enabled'`)).toHaveLength(1);
    // senare ändringar kräver inte nytt samtycke så länge samtyckestexten är densamma
    expect((await page(c, 'PUT', { enabled: true, slug: 'min-forening', showNews: false })).statusCode).toBe(200);
  });

  it('adressen är unik mellan föreningar och bara ägare/admin kan ändra', async () => {
    const a = await reg(); const b = await reg();
    expect((await enable(a, 'samma')).statusCode).toBe(200);
    expect((await enable(b, 'samma')).json().error.code).toBe('SLUG_TAKEN');
    expect((await page(b, 'GET', undefined, a)).statusCode).toBeGreaterThanOrEqual(403); // annan arbetsyta
    expect((await custCall(app, { method: 'PUT', url: `/workspaces/${a.workspaceId}/public-page`, payload: { enabled: true, slug: 'xyz', consent: true } })).statusCode).toBe(401); // utan inloggning
  });

  it('visar bara publicerade nyheter och turneringar som uttryckligen valts – aldrig utkast eller medlemsdata', async () => {
    const c = await reg(); const id = await runningTournament(c); const hidden = await runningTournament(c, 'Intern cup');
    await custCall(app, { method: 'POST', url: `/workspaces/${c.workspaceId}/association/members`, cookie: c.cookie, payload: { name: 'Hemlig Medlem', email: 'hemlig@example.test', phone: '070-1234567' } });
    const n1 = (await news(c, '', { title: 'Publicerad nyhet', body: 'Hej alla' })).json(); await news(c, `/${n1.id}/publish`);
    await news(c, '', { title: 'Hemligt utkast', body: 'ska inte synas' });
    await enable(c, 'publik'); expect((await tour(c, 'PATCH', `/${id}`, { isPublic: true })).statusCode).toBe(200);
    const r = await pubGet('publik'); expect(r.statusCode).toBe(200); const j = r.json();
    expect(j.news.map((x: any) => x.title)).toEqual(['Publicerad nyhet']);
    expect(j.tournaments.map((x: any) => x.name)).toEqual(['Vårcupen']);
    const t = await pubGet(`publik/tournaments/${id}`); expect(t.statusCode).toBe(200);
    expect(t.json().teams.map((x: any) => x.name).sort()).toEqual(['Lag Alfa', 'Lag Beta', 'Lag Gamma']);
    expect((await pubGet(`publik/tournaments/${hidden}`)).statusCode).toBe(404); // inte vald för publik visning
    const all = JSON.stringify([j, t.json()]);
    for (const leak of ['Hemlig Medlem', 'hemlig@example.test', '070-1234567', 'Hemligt utkast', 'Intern cup', c.workspaceId, c.userId, c.email]) expect(all, leak).not.toContain(leak);
    expect((await pubGet('publik/tournaments/not-a-uuid')).statusCode).toBe(404);
  });

  it('showNews=false döljer nyheter, och avstängning döljer allt direkt och återställer turneringarnas publicering', async () => {
    const c = await reg(); const id = await runningTournament(c);
    const n = (await news(c, '', { title: 'Nyhet', body: 'x' })).json(); await news(c, `/${n.id}/publish`);
    await enable(c, 'pub2'); await tour(c, 'PATCH', `/${id}`, { isPublic: true });
    await page(c, 'PUT', { enabled: true, slug: 'pub2', showNews: false });
    expect((await pubGet('pub2')).json().news).toEqual([]);
    expect((await page(c, 'PUT', { enabled: false, slug: 'pub2', showNews: false })).statusCode).toBe(200);
    expect((await pubGet('pub2')).statusCode).toBe(404); expect((await pubGet(`pub2/tournaments/${id}`)).statusCode).toBe(404);
    expect((await tour(c, 'GET', `/${id}`)).json().isPublic).toBe(false);
    await enable(c, 'pub2'); // slås man på igen är turneringen fortfarande inte publik
    expect((await pubGet('pub2')).json().tournaments).toEqual([]);
    expect(await auditRows(`action = 'public_page.disabled'`)).toHaveLength(1);
  });

  it('suspenderad eller stängd arbetsyta och saknad produkt döljer sidan; andra föreningar påverkas inte', async () => {
    const a = await reg(); const b = await reg(); const ida = await runningTournament(a);
    await enable(a, 'forening-a'); await enable(b, 'forening-b'); await tour(a, 'PATCH', `/${ida}`, { isPublic: true });
    expect((await pubGet('forening-a/tournaments/' + ida)).statusCode).toBe(200);
    expect((await pubGet(`forening-b/tournaments/${ida}`)).statusCode).toBe(404); // fel förening → finns inte
    await pool.query(`update workspaces set status = 'Suspended' where id = $1`, [a.workspaceId]);
    expect((await pubGet('forening-a')).statusCode).toBe(404); expect((await pubGet('forening-b')).statusCode).toBe(200);
    await pool.query(`update workspaces set status = 'Active' where id = $1`, [a.workspaceId]);
    expect((await pubGet('forening-a')).statusCode).toBe(200);
    await pool.query(`update public_pages set enabled = true where workspace_id = $1`, [b.workspaceId]);
    await pool.query(`update product_entitlements set status = 'Disabled' where workspace_id = $1 and product = 'tournament_system'`, [a.workspaceId]);
    expect((await pubGet('forening-a')).json().tournaments).toEqual([]);
  });

  it('har hastighetsbegränsning per IP och ger inga ledtrådar om icke-existerande adresser', async () => {
    const r1 = await pubGet('finns-inte'); expect(r1.statusCode).toBe(404);
    expect(r1.json().error.code).toBe('NOT_FOUND');
    let last = 0; for (let i = 0; i < 125; i++) last = (await pubGet('finns-inte', '10.9.9.9')).statusCode;
    expect(last).toBe(429);
    expect((await pubGet('finns-inte', '10.8.8.8')).statusCode).toBe(404); // annan IP påverkas inte
    void withWorkspace;
  });
});
