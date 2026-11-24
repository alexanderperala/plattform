-- Föreningsportal: medlemsregister. Första produkttabellen, därmed första tabellen med Row-Level Security (D3).
create table association_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  member_number text,
  name text not null,
  email text,
  phone text,
  status text not null default 'active' check (status in ('active','inactive')),
  joined_on date,
  notes text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index association_members_number_uq on association_members (workspace_id, member_number) where member_number is not null;
create index association_members_ws_name_idx on association_members (workspace_id, lower(name));
create index association_members_name_trgm on association_members using gin (lower(name) gin_trgm_ops);

-- Fail closed: utan satt arbetsyta (app.workspace_id) ser och skriver man ingenting. FORCE gör att även tabellägaren omfattas.
-- Flaggan app.system används bara av serverns egna interna räkningar (t.ex. användning mot gränser).
alter table association_members enable row level security;
alter table association_members force row level security;
create policy association_members_tenant on association_members
  using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
