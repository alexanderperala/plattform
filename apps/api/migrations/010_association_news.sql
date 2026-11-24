-- Föreningsportal: nyheter (utkast/publicerad). Samma RLS-mönster som medlemsregistret (D20).
create table association_news (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  body text not null default '',
  status text not null default 'draft' check (status in ('draft','published')),
  pinned boolean not null default false,
  published_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'published' or published_at is not null)
);
create index association_news_ws_idx on association_news (workspace_id, status, pinned desc, published_at desc);
alter table association_news enable row level security;
alter table association_news force row level security;
create policy association_news_tenant on association_news
  using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
