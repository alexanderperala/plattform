import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { PERMISSIONS, REQUIREMENTS, ROLES, ROLE_PERMISSIONS, hasPermission } from '../src/domain/permissions.js';
import { adminRoute, enforceDeclaredAccess } from '../src/http/admin/guard.js';

const specPath = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/kravspecifikation-v0.4.md');

/** Läser behörighetsmatrisen ur kravspecifikationen, så att specen och koden inte kan glida isär. */
function parseSpecMatrix(): Map<string, { roles: Set<string>; req: Set<string> }> {
  const md = readFileSync(specPath, 'utf8');
  const block = md.split('<!-- PERMISSION-MATRIX-START -->')[1]!.split('<!-- PERMISSION-MATRIX-END -->')[0]!;
  const roleCols = [...ROLES];
  const out = new Map<string, { roles: Set<string>; req: Set<string> }>();
  for (const line of block.split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|(.+)\|$/.exec(line.trim());
    if (!m) continue;
    const cells = m[2]!.split('|').map((c) => c.trim());
    const roles = new Set(roleCols.filter((_, i) => cells[i] === '✔'));
    const req = new Set((cells[roleCols.length] ?? '').split(/\s+/).filter(Boolean));
    out.set(m[1]!, { roles, req });
  }
  return out;
}

describe('behörighetsmatrisen', () => {
  const spec = parseSpecMatrix();

  it('specens matris och koden innehåller exakt samma behörigheter', () => {
    expect([...spec.keys()].sort()).toEqual([...PERMISSIONS].sort());
  });

  it.each(PERMISSIONS)('%s: roller och krav stämmer med specen', (perm) => {
    const s = spec.get(perm)!;
    const codeRoles = new Set(ROLES.filter((r) => hasPermission(r, perm)));
    expect([...codeRoles].sort()).toEqual([...s.roles].sort());
    const r = REQUIREMENTS[perm]!;
    expect(r.reason).toBe(s.req.has('O'));
    expect(r.reauth).toBe(s.req.has('R'));
    expect(r.fourEyes).toBe(s.req.has('4'));
  });

  it('Support Admin får inte tillgång till betalningar eller destruktiva åtgärder (BEH-1, BEH-2)', () => {
    for (const p of ['billing.view', 'billing.refund', 'subscriptions.manage', 'entitlements.manage', 'workspaces.close', 'workspaces.suspend', 'users.delete', 'data.purge', 'admins.manage', 'settings.manage']) {
      expect(hasPermission('support_admin', p), p).toBe(false);
    }
    expect(hasPermission('support_admin', 'subscriptions.view')).toBe(true); // status, inte betalningar
  });

  it('Read-only Admin har inga skrivande behörigheter', () => {
    const writes = PERMISSIONS.filter((p) => REQUIREMENTS[p]!.reason || REQUIREMENTS[p]!.fourEyes || /manage|decide|send|refund|purge|delete|close|suspend|update|lock|access|notes/.test(p));
    for (const p of writes) expect(hasPermission('readonly_admin', p), p).toBe(false);
  });

  it('endast Platform Owner hanterar administratörer och gallring', () => {
    expect(ROLES.filter((r) => hasPermission(r, 'admins.manage'))).toEqual(['platform_owner']);
    expect(ROLES.filter((r) => hasPermission(r, 'data.purge'))).toEqual(['platform_owner']);
  });

  it('Platform Owner har alla behörigheter', () => {
    expect(ROLE_PERMISSIONS.platform_owner.size).toBe(PERMISSIONS.length);
  });

  it('åtgärder som kräver fyra-ögon kräver även orsak och åter-autentisering', () => {
    for (const p of PERMISSIONS.filter((x) => REQUIREMENTS[x]!.fourEyes)) {
      expect(REQUIREMENTS[p]!.reason && REQUIREMENTS[p]!.reauth, p).toBe(true);
    }
  });
});

describe('fail closed (BEH-3)', () => {
  it('servern vägrar starta om en Superadmin-rutt saknar åtkomstdeklaration', async () => {
    const app = Fastify();
    enforceDeclaredAccess(app);
    expect(() => app.get('/oskyddad', async () => 'hej')).toThrow(/saknar åtkomstdeklaration/);
  });

  it('rutt med deklaration accepteras', async () => {
    const app = Fastify();
    enforceDeclaredAccess(app);
    expect(() => adminRoute(app, { method: 'GET', url: '/ok', access: { perm: 'dashboard.view' } }, async () => 'ok')).not.toThrow();
  });
});
