-- Turneringssystem: turneringar (serie), lag och matcher. RLS enligt D20, sammansatta FK mot korsläckage.
create table tournaments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  format text not null default 'round_robin' check (format in ('round_robin')),
  double_round boolean not null default false,
  status text not null default 'draft' check (status in ('draft','running','finished')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index tournaments_ws_id_uq on tournaments (workspace_id, id);

create table tournament_teams (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  tournament_id uuid not null,
  name text not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, tournament_id) references tournaments (workspace_id, id) on delete cascade
);
create unique index tournament_teams_ws_id_uq on tournament_teams (workspace_id, id);
create unique index tournament_teams_name_uq on tournament_teams (tournament_id, lower(name));

create table tournament_matches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  tournament_id uuid not null,
  round int not null check (round >= 1),
  home_team_id uuid not null,
  away_team_id uuid not null,
  home_score int check (home_score is null or home_score between 0 and 999),
  away_score int check (away_score is null or away_score between 0 and 999),
  reported_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (home_team_id <> away_team_id),
  check ((home_score is null) = (away_score is null)),
  foreign key (workspace_id, tournament_id) references tournaments (workspace_id, id) on delete cascade,
  foreign key (workspace_id, home_team_id) references tournament_teams (workspace_id, id) on delete cascade,
  foreign key (workspace_id, away_team_id) references tournament_teams (workspace_id, id) on delete cascade
);
create index tournament_matches_t_idx on tournament_matches (tournament_id, round);

do $$ declare t text; begin
  foreach t in array array['tournaments','tournament_teams','tournament_matches'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I on %I using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t || '_tenant', t);
  end loop;
end $$;
