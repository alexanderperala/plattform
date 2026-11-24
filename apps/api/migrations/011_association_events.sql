-- Föreningsportal: kalender/aktiviteter med deltagare ur medlemsregistret. RLS enligt D20.
create table association_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  description text not null default '',
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  capacity int check (capacity is null or capacity >= 1),
  status text not null default 'draft' check (status in ('draft','published')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at >= starts_at)
);
create unique index association_events_ws_id_uq on association_events (workspace_id, id);
create unique index association_members_ws_id_uq on association_members (workspace_id, id);
create index association_events_ws_start_idx on association_events (workspace_id, starts_at);

-- Deltagare är medlemmar ur registret. Raderas medlemmen försvinner anmälan (inga kvarlevande personkopplingar).
create table association_event_attendees (
  event_id uuid not null,
  member_id uuid not null,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (event_id, member_id),
  -- Sammansatta nycklar: en anmälan kan aldrig koppla ihop en aktivitet och en medlem från olika arbetsytor, ens vid en bugg
  foreign key (workspace_id, event_id) references association_events (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references association_members (workspace_id, id) on delete cascade
);
create index association_event_attendees_member_idx on association_event_attendees (member_id);

alter table association_events enable row level security;
alter table association_events force row level security;
create policy association_events_tenant on association_events
  using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
alter table association_event_attendees enable row level security;
alter table association_event_attendees force row level security;
create policy association_event_attendees_tenant on association_event_attendees
  using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
