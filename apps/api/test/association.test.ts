import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withWorkspace } from '../src/db/pool.js';
import { custCall, auditRows, makeApp, registerCustomer, resetDb, type TestCustomer } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

const url = (c: TestCustomer, extra = '') => `/workspaces/${c.workspaceId}/association/members${extra}`;
const add = (c: TestCustomer, payload: Record<string, unknown>, who = c) => custCall(app, { method: 'POST', url: url(c), cookie: who.cookie, payload });
const list = (c: TestCustomer, q = '', who = c) => custCall(app, { method: 'GET', url: url(c, q), cookie: who.cookie });

describe('Föreningsportal: medlemsregister', () => {
  it('skapar, listar, söker, ändrar och raderar medlemmar', async () => {
    const c = await registerCustomer(app);
    const r = await add(c, { name: 'Anna Andersson', email: 'Anna@Example.test', phone: '070-1234567', memberNumber: '1001', joinedOn: '2024-03-01', notes: 'Kassör' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'Anna Andersson', email: 'anna@example.test', memberNumber: '1001', status: 'active', joinedOn: '2024-03-01' });
    await add(c, { name: 'Bo Bengtsson' });
    const all = (await list(c)).json();
    expect(all.total).toBe(2);
    expect(all.items.map((m: any) => m.name)).toEqual(['Anna Andersson', 'Bo Bengtsson']);
    expect(all.access).toMatchObject({ mode: 'full', used: 2 });
    expect((await list(c, '?q=anna')).json().total).toBe(1);
    expect((await list(c, '?q=1001')).json().total).toBe(1);
    const id = r.json().id;
    const up = await custCall(app, { method: 'PATCH', url: url(c, `/${id}`), cookie: c.cookie, payload: { status: 'inactive', phone: '' } });
    expect(up.json()).toMatchObject({ status: 'inactive', phone: null, name: 'Anna Andersson' });
    expect((await list(c, '?status=inactive')).json().total).toBe(1);
    expect((await custCall(app, { method: 'DELETE', url: url(c, `/${id}`), cookie: c.cookie })).statusCode).toBe(200);
    expect((await list(c)).json().total).toBe(1);
    expect((await custCall(app, { method: 'DELETE', url: url(c, `/${id}`), cookie: c.cookie })).statusCode).toBe(404);
    const log = await auditRows(`action = 'association.member.deleted'`);
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0])).not.toContain('Anna'); // inga personuppgifter i loggen
  });

  it('validerar indata och unika medlemsnummer', async () => {
    const c = await registerCustomer(app);
    expect((await add(c, { name: '' })).statusCode).toBe(400);
    expect((await add(c, { name: 'X', email: 'inte-en-epost' })).statusCode).toBe(400);
    expect((await add(c, { name: 'X', joinedOn: '1 mars' })).statusCode).toBe(400);
    expect((await add(c, { name: 'X', workspaceId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);
    expect((await add(c, { name: 'A', memberNumber: '7' })).statusCode).toBe(201);
    const dup = await add(c, { name: 'B', memberNumber: '7' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('MEMBER_NUMBER_TAKEN');
  });

  it('vanliga medlemmar i arbetsytan får läsa men inte ändra; icke-medlemmar får 404', async () => {
    const c = await registerCustomer(app);
    const staff = await registerCustomer(app);
    await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [c.workspaceId, staff.userId]);
    const m = (await add(c, { name: 'Ida' })).json();
    expect((await list(c, '', staff)).statusCode).toBe(200);
    expect((await add(c, { name: 'Nils' }, staff)).statusCode).toBe(403);
    expect((await custCall(app, { method: 'DELETE', url: url(c, `/${m.id}`), cookie: staff.cookie })).statusCode).toBe(403);
    const outsider = await registerCustomer(app);
    expect((await list(c, '', outsider)).statusCode).toBe(404);
    expect((await add(c, { name: 'Nils' }, outsider)).statusCode).toBe(404);
    expect((await custCall(app, { method: 'GET', url: url(c, '/export'), cookie: outsider.cookie })).statusCode).toBe(404);
  });

  it('tenant-isolering: en annan arbetsyts medlem kan inte nås via egen sökväg', async () => {
    const a = await registerCustomer(app); const b = await registerCustomer(app);
    const m = (await add(a, { name: 'Hemlig Person' })).json();
    expect((await custCall(app, { method: 'PATCH', url: url(b, `/${m.id}`), cookie: b.cookie, payload: { name: 'Hackad' } })).statusCode).toBe(404);
    expect((await custCall(app, { method: 'DELETE', url: url(b, `/${m.id}`), cookie: b.cookie })).statusCode).toBe(404);
    expect((await list(b)).json().total).toBe(0);
    expect((await pool.query('select name from association_members')).rowCount).toBe(0); // utan kontext syns inget (RLS)
    expect((await withWorkspace(a.workspaceId, (c) => c.query('select name from association_members'))).rows[0].name).toBe('Hemlig Person');
  });
});

describe('Row-Level Security (databasnivå)', () => {
  it('är fail-closed och isolerar arbetsytor även när applikationen glömmer filtrera', async () => {
    const a = await registerCustomer(app); const b = await registerCustomer(app);
    await add(a, { name: 'A-medlem' }); await add(b, { name: 'B-medlem' });
    // Frågor utan where-sats ser bara den egna arbetsytan
    const seenByA = (await withWorkspace(a.workspaceId, (c) => c.query('select name from association_members'))).rows;
    expect(seenByA.map((r) => r.name)).toEqual(['A-medlem']);
    // Utan arbetsyta: tomt resultat, inte alla rader
    expect((await pool.query('select 1 from association_members')).rowCount).toBe(0);
    // Skrivning mot en annan arbetsyta nekas av with check
    await expect(withWorkspace(a.workspaceId, (c) => c.query(`insert into association_members (workspace_id, name) values ($1, 'Intrång')`, [b.workspaceId]))).rejects.toThrow(/row-level security/i);
    // Uppdatering/radering av andras rader påverkar 0 rader
    const upd = await withWorkspace(a.workspaceId, (c) => c.query(`update association_members set name = 'Hackad' where workspace_id = $1`, [b.workspaceId]));
    expect(upd.rowCount).toBe(0);
    const del = await withWorkspace(a.workspaceId, (c) => c.query('delete from association_members'));
    expect(del.rowCount).toBe(1);
    expect((await withWorkspace(b.workspaceId, (c) => c.query('select name from association_members'))).rows[0].name).toBe('B-medlem');
  });

  it('kontexten läcker inte mellan transaktioner i poolen', async () => {
    const a = await registerCustomer(app);
    await add(a, { name: 'A-medlem' });
    for (let i = 0; i < 12; i++) expect((await pool.query('select 1 from association_members')).rowCount).toBe(0);
  });
});

describe('åtkomstlägen och gränser (avsnitt 4)', () => {
  it('gränsen max_members blockerar skapande med LIMIT_EXCEEDED och licensen återhämtar sig vid radering (ENT-2/3)', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update product_entitlements set limits_override = '{"max_members":2}' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    expect((await add(c, { name: 'Ett' })).statusCode).toBe(201);
    const two = await add(c, { name: 'Två' });
    expect(two.statusCode).toBe(201);
    const three = await add(c, { name: 'Tre' });
    expect(three.statusCode).toBe(409);
    expect(three.json().error).toMatchObject({ code: 'LIMIT_EXCEEDED', details: { limit: 'max_members', max: 2, used: 2 } });
    // Sänkt gräns under befintligt antal: befintlig data påverkas inte, men skapande blockeras
    await pool.query(`update product_entitlements set limits_override = '{"max_members":1}' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    const { evaluateLimits } = await import('../src/services/access.js');
    await evaluateLimits(pool, c.workspaceId);
    expect((await pool.query(`select status from product_entitlements where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId])).rows[0].status).toBe('LimitExceeded');
    expect((await list(c)).json().total).toBe(2);
    expect((await add(c, { name: 'Fyra' })).statusCode).toBe(409);
    const id = (await list(c)).json().items[0].id;
    expect((await custCall(app, { method: 'PATCH', url: url(c, `/${id}`), cookie: c.cookie, payload: { notes: 'ändring tillåten' } })).statusCode).toBe(200);
    await custCall(app, { method: 'DELETE', url: url(c, `/${id}`), cookie: c.cookie });
    expect((await pool.query(`select status from product_entitlements where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId])).rows[0].status).toBe('Enabled');
  });

  it('gränskontrollen är atomär vid samtidiga skapanden', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update product_entitlements set limits_override = '{"max_members":3}' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => add(c, { name: `Medlem ${i}` })));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(res.filter((r) => r.statusCode === 409)).toHaveLength(5);
    expect((await list(c)).json().total).toBe(3);
  });

  it('pausad arbetsyta är skrivskyddad, avslutad är endast export, inaktiverad produkt nekas', async () => {
    const c = await registerCustomer(app);
    const m = (await add(c, { name: 'Kvar' })).json();
    await pool.query(`update workspaces set status = 'Suspended' where id = $1`, [c.workspaceId]);
    expect((await list(c)).statusCode).toBe(200);
    const w = await add(c, { name: 'Ny' });
    expect(w.statusCode).toBe(403); expect(w.json().error.code).toBe('WORKSPACE_READ_ONLY');
    expect((await custCall(app, { method: 'DELETE', url: url(c, `/${m.id}`), cookie: c.cookie })).statusCode).toBe(403);
    await pool.query(`update workspaces set status = 'Closed' where id = $1`, [c.workspaceId]);
    expect((await list(c)).statusCode).toBe(403);
    expect((await custCall(app, { method: 'GET', url: url(c, '/export?format=json'), cookie: c.cookie })).json().items).toHaveLength(1);
    await pool.query(`update workspaces set status = 'Active' where id = $1`, [c.workspaceId]);
    await pool.query(`update product_entitlements set status = 'Disabled' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    const d = await list(c);
    expect(d.statusCode).toBe(403); expect(d.json().error.code).toBe('PRODUCT_NOT_AVAILABLE');
    expect((await custCall(app, { method: 'GET', url: url(c, '/export'), cookie: c.cookie })).statusCode).toBe(403);
    // Data bevaras orörd när licensen är inaktiverad (D7)
    expect((await withWorkspace(c.workspaceId, (x) => x.query('select 1 from association_members'))).rowCount).toBe(1);
  });
});

describe('export', () => {
  it('ger CSV med BOM, skyddar mot formelinjektion och loggar utan personuppgifter', async () => {
    const c = await registerCustomer(app);
    await add(c, { name: '=HYPERLINK("http://ond.example","klicka")', email: 'x@example.test', notes: 'rad "med" citat, och komma' });
    const r = await custCall(app, { method: 'GET', url: url(c, '/export'), cookie: c.cookie });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.body.startsWith('﻿"Medlemsnummer"')).toBe(true);
    expect(r.body).toContain(`"'=HYPERLINK(""http://ond.example"",""klicka"")"`);
    expect(r.body).toContain('"rad ""med"" citat, och komma"');
    const log = await auditRows(`action = 'association.member.exported'`);
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0])).not.toContain('HYPERLINK');
  });
});

describe('import av medlemmar (CSV)', () => {
  const imp = (c: TestCustomer, csv: string, extra: Record<string, unknown> = {}, who = c, suffix = '') =>
    custCall(app, { method: 'POST', url: url(c, `/import${suffix}`), cookie: who.cookie, payload: { csv, ...extra } });
  const csvOk = 'Medlemsnummer;Namn;E-post;Telefon;Status;Medlem sedan;Anteckningar\n1;Anna Andersson;anna@example.test;070-1;Aktiv;2024-01-02;Kassör\n2;Bo Bengtsson;;;Inaktiv;;\n3;"Cecilia ""Cia"" Dahl";cia@example.test;;;;\n';

  it('förhandsgranskar utan att skriva, och importerar sedan alla giltiga rader atomärt', async () => {
    const c = await registerCustomer(app);
    const p = (await imp(c, csvOk, {}, c, '/preview')).json();
    expect(p).toMatchObject({ total: 3, valid: 3, invalid: 0, wouldExceedLimit: false, canImport: true });
    expect((await list(c)).json().total).toBe(0);
    const r = await imp(c, csvOk);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ imported: 3, skipped: 0 });
    const items = (await list(c)).json().items;
    expect(items.map((m: any) => m.name)).toEqual(['Anna Andersson', 'Bo Bengtsson', 'Cecilia "Cia" Dahl']);
    expect(items[1]).toMatchObject({ status: 'inactive', memberNumber: '2' });
    expect(items[0]).toMatchObject({ status: 'active', joinedOn: '2024-01-02', phone: '070-1' });
    const log = await auditRows(`action = 'association.member.imported'`);
    expect(log[0]!.meta).toMatchObject({ imported: 3, skipped: 0 });
    expect(JSON.stringify(log[0])).not.toContain('Anna');
  });

  it('rapporterar fel per rad och importerar inget om inte skipInvalid väljs', async () => {
    const c = await registerCustomer(app);
    await add(c, { name: 'Befintlig', memberNumber: '2' });
    const csv = 'Namn,Medlemsnummer,E-post,Medlem sedan\nGod Person,1,ok@example.test,2024-05-01\n,3,,\nDålig Epost,4,inte-epost,\nDublett Fil,1,,\nDublett Db,2,,\nFel Datum,5,,1 maj\n';
    const p = (await imp(c, csv, {}, c, '/preview')).json();
    expect(p).toMatchObject({ total: 6, valid: 1, invalid: 5 });
    expect(p.errors.map((e: any) => e.line)).toEqual([3, 4, 5, 6, 7]);
    expect(JSON.stringify(p.errors)).toContain('finns redan');
    expect(JSON.stringify(p.errors)).toContain('flera gånger');
    const strict = await imp(c, csv);
    expect(strict.statusCode).toBe(409);
    expect(strict.json().error.code).toBe('IMPORT_INVALID');
    expect((await list(c)).json().total).toBe(1);
    const lenient = await imp(c, csv, { skipInvalid: true });
    expect(lenient.json()).toEqual({ imported: 1, skipped: 5 });
    expect((await list(c)).json().total).toBe(2);
  });

  it('nekar fil utan Namn-kolumn, tom fil och okända kolumner rapporteras', async () => {
    const c = await registerCustomer(app);
    expect((await imp(c, 'E-post\nx@example.test', {}, c, '/preview')).json().fatal).toContain('Namn');
    expect((await imp(c, 'Namn', {}, c, '/preview')).json().fatal).toContain('minst en medlem');
    expect((await imp(c, 'Namn,Skostorlek\nA,42', {}, c, '/preview')).json().unknownColumns).toEqual(['Skostorlek']);
    expect((await imp(c, 'Namn\n"oavslutat')).statusCode).toBe(409);
    expect((await imp(c, '')).statusCode).toBe(400);
  });

  it('respekterar max_members: hela importen nekas om den skulle överskrida gränsen', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update product_entitlements set limits_override = '{"max_members":2}' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    const p = (await imp(c, csvOk, {}, c, '/preview')).json();
    expect(p.wouldExceedLimit).toBe(true);
    const r = await imp(c, csvOk);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'LIMIT_EXCEEDED', details: { max: 2, importing: 3 } });
    expect((await list(c)).json().total).toBe(0);
  });

  it('kräver admin, skrivbart läge och egen arbetsyta; rader hamnar bara hos rätt kund', async () => {
    const a = await registerCustomer(app); const b = await registerCustomer(app);
    const staff = await registerCustomer(app);
    await pool.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [a.workspaceId, staff.userId]);
    expect((await imp(a, csvOk, {}, staff)).statusCode).toBe(403);
    expect((await imp(a, csvOk, {}, b)).statusCode).toBe(404);
    expect((await imp(a, csvOk, {}, b, '/preview')).statusCode).toBe(404);
    await pool.query(`update workspaces set status = 'Suspended' where id = $1`, [a.workspaceId]);
    expect((await imp(a, csvOk)).json().error.code).toBe('WORKSPACE_READ_ONLY');
    await pool.query(`update workspaces set status = 'Active' where id = $1`, [a.workspaceId]);
    await imp(a, csvOk);
    expect((await list(b)).json().total).toBe(0);
    expect((await list(a)).json().total).toBe(3);
  });

  it('klarar en stor fil (1000 rader) i en transaktion', async () => {
    const c = await registerCustomer(app);
    await pool.query(`update product_entitlements set limits_override = '{"max_members":null}' where workspace_id = $1 and product = 'association_portal'`, [c.workspaceId]);
    const csv = 'Medlemsnummer,Namn\n' + Array.from({ length: 1000 }, (_, i) => `${i + 1},Medlem ${i + 1}`).join('\n');
    const t = Date.now();
    expect((await imp(c, csv)).json()).toEqual({ imported: 1000, skipped: 0 });
    expect(Date.now() - t).toBeLessThan(10_000);
    expect((await list(c)).json().total).toBe(1000);
  });
});
