import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withWorkspace } from '../../db/pool.js';
import { camel, camelAll } from '../../lib/camel.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit } from '../../services/audit.js';
import { evaluateLimits, loadWorkspaceAccess } from '../../services/access.js';
import { parseCsv } from '../../lib/csv.js';
import { canCreate, canRead, canWrite, type AccessMode } from '../../domain/access.js';

const uuid = z.string().uuid();
type Role = 'owner' | 'admin' | 'member';
export interface Helpers {
  authed: (req: FastifyRequest) => Promise<void>;
  requireMember: (req: FastifyRequest, wid: string, roles?: Role[]) => Promise<Role>;
}

const field = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const memberBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
  phone: field(40),
  memberNumber: field(40),
  status: z.enum(['active', 'inactive']).optional(),
  joinedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum ska vara ÅÅÅÅ-MM-DD').nullable().optional(),
  notes: field(2000),
}).strict();

const COLS = 'id, member_number, name, email, phone, status, joined_on::text as joined_on, notes, email_opt_out, created_at, updated_at';

/** Produktens åtkomstläge: det mest restriktiva av arbetsyta, abonnemang och licens (avsnitt 4.4). */
export async function modeFor(c: Parameters<typeof loadWorkspaceAccess>[0], wid: string, product: 'association_portal' | 'tournament_system' = 'association_portal', limitKey = 'max_members'): Promise<{ mode: AccessMode; max: number | null; used: number }> {
  const a = await loadWorkspaceAccess(c, wid);
  const p = a?.products.find((x) => x.product === product);
  if (!a || !p) throw notFound('Arbetsytan hittades inte.');
  return { mode: p.mode, max: p.limits[limitKey] ?? null, used: p.usage[limitKey] ?? 0 };
}

export const NOT_AVAILABLE = () => forbidden('Föreningsportalen är inte aktiverad för den här arbetsytan.', 'PRODUCT_NOT_AVAILABLE');
export const READ_ONLY = () => forbidden('Arbetsytan eller produkten är skrivskyddad. Kontakta er administratör eller supporten.', 'WORKSPACE_READ_ONLY');

/** Skyddar mot CSV-/formelinjektion när exporten öppnas i kalkylprogram. */
export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function associationRoutes(app: FastifyInstance, { authed, requireMember }: Helpers): void {
  const base = '/workspaces/:wid/association/members';

  app.get(base, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const q = z.object({
      q: z.string().trim().max(100).optional(), status: z.enum(['active', 'inactive']).optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
    }).parse(req.query);
    await requireMember(req, wid);
    return withWorkspace(wid, async (c) => {
      const { mode, max, used } = await modeFor(c, wid);
      if (!canRead(mode)) throw NOT_AVAILABLE();
      const where = ['workspace_id = $1']; const p: unknown[] = [wid];
      if (q.q) { p.push(`%${q.q.toLowerCase()}%`); where.push(`(lower(name) like $${p.length} or lower(coalesce(email,'')) like $${p.length} or coalesce(member_number,'') ilike $${p.length})`); }
      if (q.status) { p.push(q.status); where.push(`status = $${p.length}`); }
      const total = (await c.query<{ n: number }>(`select count(*)::int as n from association_members where ${where.join(' and ')}`, p)).rows[0]!.n;
      p.push(q.pageSize, (q.page - 1) * q.pageSize);
      const rows = (await c.query(`select ${COLS} from association_members where ${where.join(' and ')} order by lower(name), id limit $${p.length - 1} offset $${p.length}`, p)).rows;
      return { items: camelAll(rows), total, page: q.page, pageSize: q.pageSize, access: { mode, max, used } };
    });
  });

  app.post(base, { preHandler: authed }, async (req, reply: FastifyReply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = memberBody.parse(req.body);
    const role = await requireMember(req, wid, ['owner', 'admin']);
    const row = await withWorkspace(wid, async (c) => {
      await c.query('select id from workspaces where id = $1 for update', [wid]); // serialiserar gränskontrollen per arbetsyta
      const { mode, max, used } = await modeFor(c, wid);
      if (mode === 'none' || !canRead(mode)) throw NOT_AVAILABLE();
      if (!canWrite(mode)) throw READ_ONLY();
      if (!canCreate(mode) || (max !== null && used + 1 > max)) {
        throw conflict('LIMIT_EXCEEDED', `Gränsen för antal medlemmar${max !== null ? ` (${max})` : ''} är nådd. Uppgradera abonnemanget eller ta bort medlemmar.`, { limit: 'max_members', max, used });
      }
      try {
        const r = (await c.query(
          `insert into association_members (workspace_id, member_number, name, email, phone, status, joined_on, notes, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${COLS}`,
          [wid, b.memberNumber ?? null, b.name, b.email ?? null, b.phone ?? null, b.status ?? 'active', b.joinedOn ?? null, b.notes ?? null, req.customer!.userId])).rows[0]!;
        await evaluateLimits(c, wid);
        return r;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('MEMBER_NUMBER_TAKEN', 'Medlemsnumret används redan av en annan medlem.');
        throw e;
      }
    });
    void role;
    return reply.status(201).send(camel(row));
  });

  app.patch(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    const b = memberBody.partial().refine((x) => Object.keys(x).length > 0, 'Ange minst ett fält').parse(req.body);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      const { mode } = await modeFor(c, p.wid);
      if (!canRead(mode)) throw NOT_AVAILABLE();
      if (!canWrite(mode)) throw READ_ONLY();
      const cur = (await c.query('select * from association_members where id = $1 and workspace_id = $2 for update', [p.id, p.wid])).rows[0];
      if (!cur) throw notFound('Medlemmen hittades inte.');
      const n = {
        member_number: b.memberNumber === undefined ? cur.member_number : b.memberNumber, name: b.name ?? cur.name,
        email: b.email === undefined ? cur.email : b.email, phone: b.phone === undefined ? cur.phone : b.phone,
        status: b.status ?? cur.status, joined_on: b.joinedOn === undefined ? cur.joined_on : b.joinedOn, notes: b.notes === undefined ? cur.notes : b.notes,
      };
      try {
        const r = (await c.query(
          `update association_members set member_number=$3, name=$4, email=$5, phone=$6, status=$7, joined_on=$8, notes=$9, updated_at=now()
            where id=$1 and workspace_id=$2 returning ${COLS}`,
          [p.id, p.wid, n.member_number, n.name, n.email, n.phone, n.status, n.joined_on, n.notes])).rows[0]!;
        return camel(r);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('MEMBER_NUMBER_TAKEN', 'Medlemsnumret används redan av en annan medlem.');
        throw e;
      }
    });
  });

  // Radering görs av kunden (personuppgiftsansvarig). Plattformen raderar aldrig kunddata automatiskt (D7).
  app.delete(`${base}/:id`, { preHandler: authed }, async (req) => {
    const p = z.object({ wid: uuid, id: uuid }).parse(req.params);
    await requireMember(req, p.wid, ['owner', 'admin']);
    return withWorkspace(p.wid, async (c) => {
      const { mode } = await modeFor(c, p.wid);
      if (!canRead(mode)) throw NOT_AVAILABLE();
      if (!canWrite(mode)) throw READ_ONLY();
      const r = await c.query('delete from association_members where id = $1 and workspace_id = $2', [p.id, p.wid]);
      if (!r.rowCount) throw notFound('Medlemmen hittades inte.');
      await evaluateLimits(c, p.wid); // ENT-3: licensen återgår till Enabled när användningen är inom gränsen
      await audit(c, { requestId: req.id }, { action: 'association.member.deleted', workspaceId: p.wid, userId: req.customer!.userId, targetType: 'association_member', targetId: p.id, meta: { by: 'customer' } });
      return { ok: true };
    });
  });

  // Export (dataportabilitet, 8.3). Tillåten även när arbetsytan är avslutad (export_only).
  app.get(`${base}/export`, { preHandler: authed }, async (req, reply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const q = z.object({ format: z.enum(['csv', 'json']).default('csv') }).parse(req.query);
    await requireMember(req, wid, ['owner', 'admin']);
    const rows = await withWorkspace(wid, async (c) => {
      const { mode } = await modeFor(c, wid);
      if (mode === 'none') throw NOT_AVAILABLE();
      await audit(c, { requestId: req.id }, { action: 'association.member.exported', workspaceId: wid, userId: req.customer!.userId, meta: { format: q.format, by: 'customer' } });
      return (await c.query(`select ${COLS} from association_members where workspace_id = $1 order by lower(name), id`, [wid])).rows;
    });
    if (q.format === 'json') return reply.header('content-disposition', 'attachment; filename="medlemmar.json"').send({ items: camelAll(rows) });
    const head = ['Medlemsnummer', 'Namn', 'E-post', 'Telefon', 'Status', 'Medlem sedan', 'Anteckningar'];
    const lines = [head.map(csvCell).join(','), ...rows.map((r) => [r.member_number, r.name, r.email, r.phone, r.status, r.joined_on, r.notes].map(csvCell).join(','))];
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="medlemmar.csv"').send('﻿' + lines.join('\r\n') + '\r\n');
  });
}

// ---------- Import ----------

export const IMPORT_MAX_ROWS = 5000;
const HEADERS: Record<string, string> = {
  medlemsnummer: 'memberNumber', medlemsnr: 'memberNumber', nr: 'memberNumber', membernumber: 'memberNumber', member_number: 'memberNumber',
  namn: 'name', name: 'name', 'e-post': 'email', epost: 'email', email: 'email', mail: 'email',
  telefon: 'phone', mobil: 'phone', phone: 'phone', status: 'status',
  'medlem sedan': 'joinedOn', inträdesdatum: 'joinedOn', joinedon: 'joinedOn', joined_on: 'joinedOn',
  anteckningar: 'notes', anteckning: 'notes', notes: 'notes',
};
export interface ImportRow { line: number; data: z.infer<typeof memberBody> | null; errors: string[] }

/** Validerar CSV-text radvis. Ändrar ingenting i databasen. */
export function analyseImport(csv: string, existingNumbers: Set<string>): { rows: ImportRow[]; unknownColumns: string[]; fatal?: string } {
  let table: string[][];
  try { table = parseCsv(csv); } catch (e) { return { rows: [], unknownColumns: [], fatal: (e as Error).message }; }
  if (table.length < 2) return { rows: [], unknownColumns: [], fatal: 'Filen måste ha en rubrikrad och minst en medlem.' };
  const head = table[0]!.map((h) => HEADERS[h.trim().toLowerCase()] ?? null);
  const unknownColumns = table[0]!.filter((_, i) => !head[i]).map((h) => h.trim()).filter(Boolean);
  if (!head.includes('name')) return { rows: [], unknownColumns, fatal: 'Kolumnen "Namn" saknas i rubrikraden.' };
  if (table.length - 1 > IMPORT_MAX_ROWS) return { rows: [], unknownColumns, fatal: `Högst ${IMPORT_MAX_ROWS} rader kan importeras åt gången.` };
  const seen = new Set<string>();
  const rows: ImportRow[] = table.slice(1).map((cells, idx) => {
    const raw: Record<string, string> = {};
    head.forEach((k, i) => { if (k && (cells[i] ?? '').trim() !== '') raw[k] = cells[i]!.trim(); });
    if (raw.status) {
      const s = raw.status.toLowerCase();
      raw.status = ['aktiv', 'active', 'ja'].includes(s) ? 'active' : ['inaktiv', 'inactive', 'nej'].includes(s) ? 'inactive' : raw.status;
    }
    const parsed = memberBody.safeParse(raw);
    const errors = parsed.success ? [] : parsed.error.issues.map((i) => `${String(i.path[0] ?? 'rad')}: ${i.message}`);
    const num = parsed.success ? parsed.data.memberNumber ?? null : null;
    if (num) {
      if (existingNumbers.has(num)) errors.push(`memberNumber: medlemsnumret ${num} finns redan i registret`);
      else if (seen.has(num)) errors.push(`memberNumber: medlemsnumret ${num} förekommer flera gånger i filen`);
      seen.add(num);
    }
    return { line: idx + 2, data: parsed.success && !errors.length ? parsed.data : null, errors };
  });
  return { rows, unknownColumns };
}

export function importRoutes(app: FastifyInstance, { authed, requireMember }: Helpers): void {
  const base = '/workspaces/:wid/association/members/import';
  const body = z.object({ csv: z.string().min(1).max(900_000), skipInvalid: z.boolean().default(false) });

  async function analyse(c: Parameters<typeof loadWorkspaceAccess>[0], wid: string, csv: string) {
    const nums = new Set((await (c as import('pg').PoolClient).query<{ n: string }>('select member_number as n from association_members where workspace_id = $1 and member_number is not null', [wid])).rows.map((r) => r.n));
    return analyseImport(csv, nums);
  }

  app.post(`${base}/preview`, { preHandler: authed }, async (req) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = body.parse(req.body);
    await requireMember(req, wid, ['owner', 'admin']);
    return withWorkspace(wid, async (c) => {
      const { mode, max, used } = await modeFor(c, wid);
      if (!canRead(mode)) throw NOT_AVAILABLE();
      const a = await analyse(c, wid, b.csv);
      if (a.fatal) return { fatal: a.fatal };
      const valid = a.rows.filter((r) => r.data).length;
      return {
        total: a.rows.length, valid, invalid: a.rows.length - valid, unknownColumns: a.unknownColumns,
        wouldExceedLimit: max !== null && used + valid > max, canImport: canCreate(mode), access: { mode, max, used },
        errors: a.rows.filter((r) => r.errors.length).slice(0, 100).map((r) => ({ line: r.line, errors: r.errors })),
        sample: a.rows.filter((r) => r.data).slice(0, 5).map((r) => r.data),
      };
    });
  });

  app.post(base, { preHandler: authed }, async (req, reply) => {
    const { wid } = z.object({ wid: uuid }).parse(req.params);
    const b = body.parse(req.body);
    await requireMember(req, wid, ['owner', 'admin']);
    const res = await withWorkspace(wid, async (c) => {
      await c.query('select id from workspaces where id = $1 for update', [wid]);
      const { mode, max, used } = await modeFor(c, wid);
      if (!canRead(mode)) throw NOT_AVAILABLE();
      if (!canWrite(mode)) throw READ_ONLY();
      const a = await analyse(c, wid, b.csv);
      if (a.fatal) throw conflict('IMPORT_INVALID', a.fatal);
      const good = a.rows.filter((r) => r.data);
      const bad = a.rows.length - good.length;
      if (bad > 0 && !b.skipInvalid) throw conflict('IMPORT_INVALID', `${bad} rader har fel. Rätta filen eller välj att hoppa över felaktiga rader. Inget har importerats.`, { invalid: bad });
      if (!canCreate(mode) || (max !== null && used + good.length > max)) {
        throw conflict('LIMIT_EXCEEDED', `Importen skulle ge ${used + good.length} medlemmar och överskrida gränsen${max !== null ? ` (${max})` : ''}. Inget har importerats.`, { limit: 'max_members', max, used, importing: good.length });
      }
      for (const r of good) {
        const m = r.data!;
        await c.query(
          `insert into association_members (workspace_id, member_number, name, email, phone, status, joined_on, notes, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [wid, m.memberNumber ?? null, m.name, m.email ?? null, m.phone ?? null, m.status ?? 'active', m.joinedOn ?? null, m.notes ?? null, req.customer!.userId]);
      }
      await evaluateLimits(c, wid);
      await audit(c, { requestId: req.id }, { action: 'association.member.imported', workspaceId: wid, userId: req.customer!.userId, meta: { imported: good.length, skipped: bad, by: 'customer' } });
      return { imported: good.length, skipped: bad };
    });
    return reply.status(201).send(res);
  });
}
