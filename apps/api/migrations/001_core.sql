-- Gemensam plattformskärna: identitet, arbetsytor, planer, abonnemang, produktlicenser
create extension if not exists pg_trgm;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null,
  phone text,
  password_hash text,
  email_verified_at timestamptz,
  status text not null default 'active' check (status in ('active','locked','deleted')),
  failed_login_count int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));
create index users_name_trgm on users using gin (lower(name) gin_trgm_ops);
create index users_email_trgm on users using gin (lower(email) gin_trgm_ops);

create table user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
create index user_sessions_user_idx on user_sessions (user_id) where revoked_at is null;

create table user_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('password_reset','email_verify','invite')),
  token_hash text not null unique,
  workspace_id uuid,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table login_history (
  id bigint generated always as identity primary key,
  subject_type text not null check (subject_type in ('user','admin')),
  subject_id uuid,
  email_attempted text,
  success boolean not null,
  reason text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index login_history_subject_idx on login_history (subject_type, subject_id, created_at desc);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'association' check (kind in ('association','organizer','other')),
  org_number text,
  country text not null default 'SE',
  vat_id text,
  contact_name text not null,
  contact_email text not null,
  status text not null default 'Active' check (status in ('Active','Suspended','Closed')),
  status_reason text,
  suspended_at timestamptz,
  closed_at timestamptz,
  terms_version text,
  dpa_version text,
  terms_accepted_at timestamptz,
  last_activity_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workspaces_name_trgm on workspaces using gin (lower(name) gin_trgm_ops);
create index workspaces_contact_trgm on workspaces using gin (lower(contact_name) gin_trgm_ops);
create index workspaces_email_trgm on workspaces using gin (lower(contact_email) gin_trgm_ops);
create index workspaces_org_idx on workspaces (org_number);
create index workspaces_status_idx on workspaces (status);
create index workspaces_created_idx on workspaces (created_at desc);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on workspace_members (user_id);

create table plans (
  id text primary key,
  name text not null,
  monthly_price_minor int not null default 0,
  currency text not null default 'SEK',
  is_trial boolean not null default false,
  active boolean not null default true,
  sort_order int not null default 0
);

create table plan_entitlements (
  plan_id text not null references plans(id) on delete cascade,
  product text not null check (product in ('association_portal','tournament_system')),
  limits jsonb not null default '{}'::jsonb,
  features jsonb not null default '{}'::jsonb,
  primary key (plan_id, product)
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references workspaces(id) on delete cascade,
  plan_id text not null references plans(id),
  status text not null check (status in ('Trialing','Active','PastDue','Paused','CanceledAtPeriodEnd','Expired')),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  past_due_since timestamptz,
  grace_period_days int,
  paused_at timestamptz,
  provider_customer_id text,
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_status_idx on subscriptions (status);

create table product_entitlements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  product text not null check (product in ('association_portal','tournament_system')),
  status text not null check (status in ('Enabled','Disabled','Suspended','LimitExceeded')),
  limits_override jsonb not null default '{}'::jsonb,
  source text not null default 'plan' check (source in ('plan','admin_grant','trial')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, product)
);
create index product_entitlements_status_idx on product_entitlements (product, status);

create table feature_flags (
  key text primary key,
  description text not null,
  default_enabled boolean not null default false,
  created_at timestamptz not null default now()
);
create table feature_flag_overrides (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  flag_key text not null references feature_flags(key) on delete cascade,
  enabled boolean not null,
  primary key (workspace_id, flag_key)
);

create table notification_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  user_id uuid,
  to_email text not null,
  template text not null,
  subject text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index outbox_status_idx on notification_outbox (status, created_at);

create table workspace_notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index workspace_notifications_idx on workspace_notifications (workspace_id, created_at desc);

create table system_errors (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  request_id text,
  source text not null default 'api',
  workspace_id uuid,
  user_id uuid,
  admin_id uuid,
  method text,
  route text,
  status_code int,
  code text,
  message text not null,
  details jsonb not null default '{}'::jsonb
);
create index system_errors_at_idx on system_errors (at desc);
create index system_errors_ws_idx on system_errors (workspace_id, at desc);
create index system_errors_user_idx on system_errors (user_id, at desc);

create table platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table purge_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  product text,
  reason text not null check (reason in ('closed_retention','product_retention')),
  eligible_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','purged')),
  created_at timestamptz not null default now(),
  unique (workspace_id, product, reason)
);
