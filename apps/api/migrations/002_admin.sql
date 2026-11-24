-- Superadmin: egna administratörer, sessioner, audit, godkännanden, support
create table platform_admins (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  role text not null check (role in ('platform_owner','superadmin','support_admin','billing_admin','technical_admin','readonly_admin')),
  password_hash text not null,
  status text not null default 'active' check (status in ('active','disabled')),
  is_break_glass boolean not null default false,
  breakglass_open_until timestamptz,
  mfa_secret_enc text,
  mfa_pending_secret_enc text,
  mfa_enrolled_at timestamptz,
  mfa_last_step bigint,
  failed_count int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index platform_admins_email_uq on platform_admins (lower(email));

create table platform_admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references platform_admins(id) on delete cascade,
  token_hash text not null unique,
  stage text not null check (stage in ('mfa_pending','mfa_enroll','active')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  reauth_at timestamptz,
  revoked_at timestamptz,
  break_glass boolean not null default false,
  ip text,
  user_agent text
);
create index platform_admin_sessions_admin_idx on platform_admin_sessions (admin_id) where revoked_at is null;

create table platform_admin_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references platform_admins(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index platform_admin_recovery_idx on platform_admin_recovery_codes (admin_id) where used_at is null;

create table admin_audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  admin_id uuid,
  admin_email text,
  admin_role text,
  action text not null,
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  workspace_id uuid,
  user_id uuid,
  target_type text,
  target_id text,
  support_case_id uuid,
  reason text,
  before jsonb,
  after jsonb,
  meta jsonb not null default '{}'::jsonb,
  break_glass boolean not null default false,
  self_approved boolean not null default false,
  request_id text,
  ip text
);
create index admin_audit_at_idx on admin_audit_log (at desc);
create index admin_audit_ws_idx on admin_audit_log (workspace_id, at desc);
create index admin_audit_user_idx on admin_audit_log (user_id, at desc);
create index admin_audit_admin_idx on admin_audit_log (admin_id, at desc);
create index admin_audit_action_idx on admin_audit_log (action);

-- Append-only: UPDATE, DELETE och TRUNCATE förbjuds
create function admin_audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'admin_audit_log är append-only (% förbjudet)', tg_op using errcode = 'insufficient_privilege';
end $$;
create trigger admin_audit_log_no_update before update or delete on admin_audit_log
  for each row execute function admin_audit_log_immutable();
create trigger admin_audit_log_no_truncate before truncate on admin_audit_log
  for each statement execute function admin_audit_log_immutable();

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('workspace.close','user.delete')),
  target_type text not null,
  target_id uuid not null,
  workspace_id uuid,
  params jsonb not null default '{}'::jsonb,
  reason text not null,
  requested_by uuid not null references platform_admins(id),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired','executed','failed')),
  decided_by uuid references platform_admins(id),
  decided_at timestamptz,
  decision_reason text,
  executed_at timestamptz,
  result jsonb,
  self_approved boolean not null default false
);
create index approval_requests_status_idx on approval_requests (status, requested_at desc);
create unique index approval_requests_pending_uq on approval_requests (action, target_id) where status = 'pending';

create table support_cases (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  subject text not null,
  description text not null default '',
  category text not null check (category in ('account_login','member_admin','forum_communication','tournament_system','results_scoring','payments','subscription','technical_error','other')),
  priority text not null default 'normal' check (priority in ('low','normal','high','critical')),
  status text not null default 'New' check (status in ('New','InProgress','WaitingCustomer','WaitingInternal','Resolved','Closed')),
  assigned_admin_id uuid references platform_admins(id),
  workspace_id uuid references workspaces(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  requester_email text,
  created_by_admin_id uuid references platform_admins(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index support_cases_status_idx on support_cases (status, updated_at desc);
create index support_cases_ws_idx on support_cases (workspace_id);
create index support_cases_user_idx on support_cases (user_id);

create table support_case_comments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references support_cases(id) on delete cascade,
  author_admin_id uuid references platform_admins(id),
  body text not null,
  internal boolean not null default true,
  created_at timestamptz not null default now()
);
create index support_case_comments_idx on support_case_comments (case_id, created_at);

create table workspace_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  admin_id uuid references platform_admins(id),
  body text not null,
  created_at timestamptz not null default now()
);
create index workspace_notes_idx on workspace_notes (workspace_id, created_at desc);

create table support_access_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  granted_by_user_id uuid not null references users(id),
  scope text not null check (scope in ('personal_data','assisted')),
  allowed_actions text[] not null default '{}',
  support_case_id uuid references support_cases(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index support_access_grants_ws_idx on support_access_grants (workspace_id, expires_at desc);

create table support_access_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references platform_admins(id),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  support_case_id uuid not null references support_cases(id),
  mode text not null check (mode in ('readonly','assisted')),
  reason text not null,
  grant_id uuid references support_access_grants(id),
  personal_data boolean not null default false,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text check (ended_reason in ('manual','expired','admin_session_revoked')),
  views int not null default 0
);
create index support_access_sessions_ws_idx on support_access_sessions (workspace_id, started_at desc);
create index support_access_sessions_admin_idx on support_access_sessions (admin_id, started_at desc);
