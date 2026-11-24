const TZ = 'Europe/Stockholm';

export const fmtDateTime = (v: string | Date | null | undefined): string =>
  v ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: TZ }).format(new Date(v)) : '–';
export const fmtDate = (v: string | Date | null | undefined): string =>
  v ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeZone: TZ }).format(new Date(v)) : '–';

export function relTime(v: string | Date | null | undefined): string {
  if (!v) return 'aldrig';
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  const abs = Math.abs(s);
  const fut = s < 0;
  const u = abs < 60 ? [abs, 'sek'] : abs < 3600 ? [Math.round(abs / 60), 'min'] : abs < 86400 ? [Math.round(abs / 3600), 'tim'] : [Math.round(abs / 86400), 'dagar'];
  return fut ? `om ${u[0]} ${u[1]}` : `${u[0]} ${u[1]} sedan`;
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export const LABELS = {
  workspaceStatus: { Active: 'Aktiv', Suspended: 'Pausad', Closed: 'Avslutad' },
  subscriptionStatus: { Trialing: 'Provperiod', Active: 'Aktivt', PastDue: 'Förfallen betalning', Paused: 'Pausat', CanceledAtPeriodEnd: 'Uppsagt', Expired: 'Utgånget' },
  entitlementStatus: { Enabled: 'Aktiv', Disabled: 'Inaktiverad', Suspended: 'Avstängd', LimitExceeded: 'Gräns överskriden' },
  access: { full: 'Full åtkomst', limited: 'Begränsad', read_only: 'Skrivskyddad', export_only: 'Endast export', none: 'Ingen åtkomst' },
  product: { association_portal: 'Föreningsportal', tournament_system: 'Turneringssystem' },
  caseStatus: { New: 'Nytt', InProgress: 'Pågående', WaitingCustomer: 'Väntar på kund', WaitingInternal: 'Väntar internt', Resolved: 'Löst', Closed: 'Stängt' },
  priority: { low: 'Låg', normal: 'Normal', high: 'Hög', critical: 'Kritisk' },
  category: {
    account_login: 'Konto och inloggning', member_admin: 'Medlemsadministration', forum_communication: 'Forum och kommunikation', tournament_system: 'Turneringssystem',
    results_scoring: 'Resultat och poängberäkning', payments: 'Betalningar', subscription: 'Abonnemang', technical_error: 'Tekniska fel', other: 'Övrigt',
  },
  role: { platform_owner: 'Platform Owner', superadmin: 'Superadmin', support_admin: 'Support Admin', billing_admin: 'Billing Admin', technical_admin: 'Technical Admin', readonly_admin: 'Read-only Admin' },
  memberRole: { owner: 'Ägare', admin: 'Administratör', member: 'Medlem' },
  userStatus: { active: 'Aktiv', locked: 'Låst', deleted: 'Borttagen' },
  kind: { association: 'Förening', organizer: 'Arrangör', other: 'Annan' },
  approvalStatus: { pending: 'Väntar', approved: 'Godkänd', rejected: 'Avslagen', expired: 'Förfallen', executed: 'Utförd', failed: 'Misslyckades' },
  approvalAction: { 'workspace.close': 'Avsluta arbetsyta', 'user.delete': 'Ta bort användare', 'admin.create': 'Skapa administratör', 'admin.change_role': 'Ändra administratörs roll', 'admin.enable': 'Aktivera administratör', 'admin.reset_mfa': 'Återställ administratörs MFA' },
  severity: { info: 'Info', warning: 'Varning', critical: 'Kritisk' },
  limit: { max_users: 'Användare', max_members: 'Medlemmar', max_tournaments: 'Turneringar', storage_mb: 'Lagring (MB)' },
} as const;

export function label(group: keyof typeof LABELS, v: string | null | undefined): string {
  if (!v) return '–';
  return (LABELS[group] as Record<string, string>)[v] ?? v;
}

export function tone(group: keyof typeof LABELS, v: string | null | undefined): Tone {
  const good = ['Active', 'Enabled', 'full', 'active', 'executed', 'Resolved', 'Closed_case'];
  const warn = ['Suspended', 'Paused', 'PastDue', 'LimitExceeded', 'limited', 'read_only', 'locked', 'pending', 'WaitingCustomer', 'WaitingInternal', 'CanceledAtPeriodEnd', 'warning', 'high'];
  const bad = ['Closed', 'Expired', 'Disabled', 'none', 'export_only', 'deleted', 'failed', 'rejected', 'critical'];
  if (group === 'caseStatus') return v === 'Resolved' || v === 'Closed' ? 'good' : v === 'New' ? 'info' : 'neutral';
  if (group === 'memberRole' || group === 'kind' || group === 'role' || group === 'product' || group === 'category') return 'neutral';
  if (v === 'Trialing' || v === 'info' || v === 'approved') return 'info';
  if (good.includes(v ?? '')) return 'good';
  if (warn.includes(v ?? '')) return 'warn';
  if (bad.includes(v ?? '')) return 'bad';
  return 'neutral';
}

export const AUDIT_LABELS: Record<string, string> = {
  'admin.login': 'Administratörsinloggning', 'admin.locked': 'Administratörskonto låst', 'admin.mfa.enrolled': 'MFA registrerad', 'admin.reauth': 'Åter-autentisering',
  'workspace.update': 'Kunduppgifter ändrade', 'workspace.suspend': 'Arbetsyta pausad', 'workspace.reactivate': 'Arbetsyta återaktiverad', 'workspace.close': 'Arbetsyta avslutad',
  'workspace.note_added': 'Anteckning tillagd', 'workspace.sessions_revoked': 'Kundsessioner återkallade',
  'user.lock': 'Användare låst', 'user.unlock': 'Användare upplåst', 'user.sessions_revoked': 'Användarsessioner återkallade', 'user.password_reset_initiated': 'Lösenordsåterställning skickad',
  'user.verification_sent': 'Verifieringsmejl skickat', 'user.invite_resent': 'Inbjudan skickad igen', 'user.delete': 'Användare borttagen',
  'entitlement.enable': 'Produkt aktiverad', 'entitlement.disable': 'Produkt inaktiverad', 'entitlement.suspend': 'Produkt avstängd', 'entitlement.limits_changed': 'Gränser ändrade',
  'subscription.activate': 'Abonnemang aktiverat', 'subscription.change_plan': 'Plan ändrad', 'subscription.extend_trial': 'Provperiod förlängd', 'subscription.pause': 'Abonnemang pausat',
  'subscription.resume': 'Abonnemang återupptaget', 'subscription.cancel_at_period_end': 'Abonnemang uppsagt', 'subscription.undo_cancel': 'Uppsägning ångrad', 'subscription.expire': 'Abonnemang avslutat',
  'subscription.mark_past_due': 'Markerat som förfallet', 'subscription.expired_auto': 'Abonnemang gick ut (automatiskt)',
  'support.case_created': 'Ärende skapat', 'support.case_updated': 'Ärende uppdaterat', 'support.comment_added': 'Ärendekommentar',
  'support.access.started': 'Supportåtkomst startad', 'support.access.view': 'Supportvy öppnad', 'support.access.ended': 'Supportåtkomst avslutad', 'support.grant.created': 'Kund godkände supportåtkomst', 'flag.default_changed': 'Funktionsflaggans standard ändrad', 'flag.override_changed': 'Flagga överstyrd för kund', 'settings.updated': 'Systeminställning ändrad', 'support.assisted.action': 'Assisterad supportåtgärd utförd', 'support.grant.revoked': 'Kund återkallade godkännande',
  'approval.requested': 'Godkännande begärt', 'approval.approved': 'Godkänt', 'approval.rejected': 'Avslaget', 'approval.expired': 'Godkännande förföll', 'approval.failed': 'Godkänd åtgärd misslyckades',
  'admin.created': 'Administratör skapad', 'admin.role_changed': 'Administratörs roll ändrad', 'admin.disabled': 'Administratör inaktiverad', 'admin.enabled': 'Administratör aktiverad', 'admin.mfa_reset': 'Administratörs MFA återställd', 'admin.setup_completed': 'Administratörskonto aktiverat via länk',
  'breakglass.opened': 'BREAK-GLASS ÖPPNAT', 'breakglass.sealed': 'Break-glass förseglat',
};
export const auditLabel = (a: string): string => AUDIT_LABELS[a] ?? a;
