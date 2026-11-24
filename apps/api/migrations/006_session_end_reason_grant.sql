-- Supportsession kan avslutas när kunden återkallar sitt godkännande.
alter table support_access_sessions drop constraint support_access_sessions_ended_reason_check;
alter table support_access_sessions add constraint support_access_sessions_ended_reason_check
  check (ended_reason in ('manual','expired','admin_session_revoked','grant_revoked'));
