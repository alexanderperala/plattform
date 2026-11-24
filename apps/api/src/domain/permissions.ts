// Behörighetsmatrisen. Måste överensstämma med tabellen i docs/kravspecifikation-v0.4.md
// (verifieras av test/permissions.test.ts).
export const ROLES = [
  'platform_owner', 'superadmin', 'support_admin', 'billing_admin', 'technical_admin', 'readonly_admin',
] as const;
export type Role = (typeof ROLES)[number];

const ROLE_CODE: Record<string, Role> = {
  PO: 'platform_owner', SA: 'superadmin', SU: 'support_admin', BI: 'billing_admin', TE: 'technical_admin', RO: 'readonly_admin',
};

export interface Requirement { reason: boolean; reauth: boolean; fourEyes: boolean }

// [behörighet, roller, krav] där krav: O = orsak, R = åter-autentisering, 4 = fyra-ögon
const TABLE: Array<[string, string, string]> = [
  ['dashboard.view',          'PO SA SU BI TE RO', ''],
  ['workspaces.view',         'PO SA SU BI TE RO', ''],
  ['workspaces.update',       'PO SA SU', 'O'],
  ['workspaces.notes',        'PO SA SU BI', ''],
  ['workspaces.suspend',      'PO SA', 'O R'],
  ['workspaces.close',        'PO SA', 'O R 4'],
  ['users.view',              'PO SA SU TE RO', ''],
  ['users.account_actions',   'PO SA SU', 'O'],
  ['users.lock',              'PO SA SU', 'O'],
  ['users.delete',            'PO SA', 'O R 4'],
  ['entitlements.view',       'PO SA SU BI TE RO', ''],
  ['entitlements.manage',     'PO SA', 'O R'],
  ['flags.manage',            'PO SA TE', 'O'],
  ['subscriptions.view',      'PO SA SU BI RO', ''],
  ['subscriptions.manage',    'PO SA BI', 'O R'],
  ['billing.view',            'PO SA BI', ''],
  ['billing.refund',          'PO SA BI', 'O R 4'],
  ['support.view',            'PO SA SU BI TE RO', ''],
  ['support.manage',          'PO SA SU', ''],
  ['support.access_readonly', 'PO SA SU', 'O'],
  ['support.access_assisted', 'PO SA SU', 'O R'],
  ['logs.view',               'PO SA SU TE RO', ''],
  ['audit.view',              'PO SA TE RO', ''],
  ['analytics.view',          'PO SA BI RO', ''],
  ['messaging.send_single',   'PO SA SU', 'O'],
  ['messaging.send_bulk',     'PO SA', 'O R 4'],
  ['settings.manage',         'PO SA', 'O R'],
  ['approvals.decide',        'PO SA', 'R'],
  ['admins.manage',           'PO', 'O R 4'],
  ['data.purge',              'PO', 'O R 4'],
];

export type Permission = (typeof TABLE)[number][0];
export const PERMISSIONS = TABLE.map((t) => t[0]);

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<string>> = Object.fromEntries(
  ROLES.map((r) => [r, new Set(TABLE.filter((t) => t[1].split(' ').map((c) => ROLE_CODE[c]).includes(r)).map((t) => t[0]))]),
) as unknown as Record<Role, ReadonlySet<string>>;

export const REQUIREMENTS: Record<string, Requirement> = Object.fromEntries(
  TABLE.map(([p, , req]) => {
    const flags = req.split(' ');
    return [p, { reason: flags.includes('O'), reauth: flags.includes('R'), fourEyes: flags.includes('4') }];
  }),
);

export const hasPermission = (role: Role, permission: string): boolean => ROLE_PERMISSIONS[role].has(permission);
export const permissionsFor = (role: Role): string[] => [...ROLE_PERMISSIONS[role]];
export const isPermission = (p: string): boolean => p in REQUIREMENTS;
