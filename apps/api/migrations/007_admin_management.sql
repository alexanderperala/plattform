-- Adminhantering: nya four-eyes-åtgärder och engångstoken för kontoinställning.
alter table approval_requests drop constraint approval_requests_action_check;
alter table approval_requests add constraint approval_requests_action_check
  check (action in ('workspace.close','user.delete','admin.create','admin.change_role','admin.enable','admin.reset_mfa'));

create table admin_setup_tokens (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references platform_admins(id) on delete cascade,
  token_hash text not null unique,
  purpose text not null check (purpose in ('invite','mfa_reset')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index admin_setup_tokens_admin_idx on admin_setup_tokens (admin_id) where used_at is null;
