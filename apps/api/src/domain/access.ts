// Effektiv åtkomst (avsnitt 4.4 i kravspecifikationen). Ren funktion utan I/O.
export type WorkspaceStatus = 'Active' | 'Suspended' | 'Closed';
export type SubscriptionStatus = 'Trialing' | 'Active' | 'PastDue' | 'Paused' | 'CanceledAtPeriodEnd' | 'Expired';
export type EntitlementStatus = 'Enabled' | 'Disabled' | 'Suspended' | 'LimitExceeded';
export type AccessMode = 'full' | 'limited' | 'read_only' | 'export_only' | 'none';

// Från minst till mest restriktivt
export const ACCESS_ORDER: AccessMode[] = ['full', 'limited', 'read_only', 'export_only', 'none'];
const worse = (a: AccessMode, b: AccessMode): AccessMode =>
  ACCESS_ORDER.indexOf(a) >= ACCESS_ORDER.indexOf(b) ? a : b;

export interface SubscriptionFacts {
  status: SubscriptionStatus;
  trialEndsAt?: Date | null;
  currentPeriodEnd?: Date | null;
  pastDueSince?: Date | null;
  graceDays: number;
}
export interface EntitlementFacts { status: EntitlementStatus; expiresAt?: Date | null }

/** Statusen efter hänsyn till utgångna datum, även om bakgrundsjobbet inte hunnit köra (KRAV-S2). */
export function effectiveSubscriptionStatus(s: SubscriptionFacts, now: Date): SubscriptionStatus {
  if (s.status === 'Trialing' && s.trialEndsAt && s.trialEndsAt <= now) return 'Expired';
  if (s.status === 'CanceledAtPeriodEnd' && s.currentPeriodEnd && s.currentPeriodEnd <= now) return 'Expired';
  return s.status;
}

export function graceEndsAt(s: SubscriptionFacts): Date | null {
  if (!s.pastDueSince) return null;
  return new Date(s.pastDueSince.getTime() + s.graceDays * 86_400_000);
}

export function subscriptionAccess(s: SubscriptionFacts, now: Date): AccessMode {
  switch (effectiveSubscriptionStatus(s, now)) {
    case 'Trialing':
    case 'Active':
    case 'CanceledAtPeriodEnd':
      return 'full';
    case 'PastDue': {
      const end = graceEndsAt(s);
      return end && end <= now ? 'read_only' : 'full';
    }
    case 'Paused':
      return 'read_only';
    case 'Expired':
      return 'none';
  }
}

export function entitlementAccess(e: EntitlementFacts | null, now: Date): AccessMode {
  if (!e) return 'none';
  const status: EntitlementStatus = e.expiresAt && e.expiresAt <= now ? 'Disabled' : e.status;
  switch (status) {
    case 'Enabled': return 'full';
    case 'LimitExceeded': return 'limited';
    case 'Suspended': return 'read_only';
    case 'Disabled': return 'none';
  }
}

export function workspaceAccess(status: WorkspaceStatus): AccessMode {
  return status === 'Closed' ? 'export_only' : status === 'Suspended' ? 'read_only' : 'full';
}

/** Det mest restriktiva läget av arbetsyta, abonnemang och produktlicens gäller. */
export function resolveAccess(input: {
  workspaceStatus: WorkspaceStatus;
  subscription: SubscriptionFacts | null;
  entitlement: EntitlementFacts | null;
  now?: Date;
}): AccessMode {
  const now = input.now ?? new Date();
  let mode: AccessMode = workspaceAccess(input.workspaceStatus);
  mode = worse(mode, input.subscription ? subscriptionAccess(input.subscription, now) : 'none');
  mode = worse(mode, entitlementAccess(input.entitlement, now));
  return mode;
}

export const canRead = (m: AccessMode): boolean => m === 'full' || m === 'limited' || m === 'read_only';
export const canWrite = (m: AccessMode): boolean => m === 'full' || m === 'limited';
/** 'limited' tillåter ändring av befintliga objekt men inte skapande i den överskridna dimensionen. */
export const canCreate = (m: AccessMode): boolean => m === 'full';
