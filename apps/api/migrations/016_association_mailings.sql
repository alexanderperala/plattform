-- Medlemsutskick: utskick (utkast/skickat), logg över mottagare (vem som fått vad) och avanmälan per medlem. RLS enligt D20.
-- Avanmälningslänken lagras i egen kolumn: payload maskeras (tokens döljs) och skulle ge en trasig List-Unsubscribe-header.
alter table notification_outbox add column unsubscribe_url text;
alter table association_members add column email_opt_out boolean not null default false;
alter table association_members add column email_opt_out_at timestamptz;

create table association_mailings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  subject text not null,
  body text not null,
  status text not null default 'draft' check (status in ('draft','sent')),
  recipient_count int,
  created_by uuid references users(id) on delete set null,
  sent_by uuid references users(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'sent') = (sent_at is not null))
);
create unique index association_mailings_ws_id_uq on association_mailings (workspace_id, id);
create index association_mailings_ws_idx on association_mailings (workspace_id, created_at desc);

create table association_mailing_recipients (
  workspace_id uuid not null,
  mailing_id uuid not null,
  member_id uuid not null,
  primary key (mailing_id, member_id),
  foreign key (workspace_id, mailing_id) references association_mailings (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references association_members (workspace_id, id) on delete cascade
);

do $$ declare t text; begin
  foreach t in array array['association_mailings','association_mailing_recipients'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I on %I using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t || '_tenant', t);
  end loop;
end $$;
