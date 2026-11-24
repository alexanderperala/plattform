-- Flipperturneringar: spelare, maskiner, steg (kval, matchplay, Swiss, serie, enkel/dubbel utslagning), grupper/matcher, spel och poäng.
-- RLS enligt D20 och sammansatta FK mot korsläckage mellan arbetsytor.
alter table tournaments drop constraint tournaments_format_check;
alter table tournaments add constraint tournaments_format_check check (format in ('round_robin','single_elimination','groups_knockout','pinball'));

create table pinball_players (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  tournament_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  seed int not null check (seed >= 1),
  withdrawn boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, tournament_id) references tournaments (workspace_id, id) on delete cascade
);
create unique index pinball_players_ws_id_uq on pinball_players (workspace_id, id);
create unique index pinball_players_name_uq on pinball_players (tournament_id, lower(name));

create table pinball_machines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  tournament_id uuid not null,
  name text not null check (length(name) between 1 and 100),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, tournament_id) references tournaments (workspace_id, id) on delete cascade
);
create unique index pinball_machines_ws_id_uq on pinball_machines (workspace_id, id);
create unique index pinball_machines_name_uq on pinball_machines (tournament_id, lower(name));

create table pinball_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  tournament_id uuid not null,
  no int not null check (no >= 1),
  kind text not null check (kind in ('best_game','matchplay','swiss','round_robin','single_elim','double_elim')),
  name text not null check (length(name) between 1 and 100),
  config jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','running','finished')),
  current_round int not null default 0,
  final_ranking jsonb,
  rng_seed int not null default floor(random() * 2147483647)::int,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, tournament_id) references tournaments (workspace_id, id) on delete cascade,
  unique (tournament_id, no)
);
create unique index pinball_stages_ws_id_uq on pinball_stages (workspace_id, id);

-- En grupp = en match/ett bord med 1–4 spelare. Matchplay/Swiss/serie: spelarna sparas i pinball_group_players.
-- Utslagning: bracket_key anger plats i grafen och spelarna räknas ut ur resultaten (inga rader tills de är kända).
create table pinball_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  stage_id uuid not null,
  round int not null check (round >= 0),
  slot int not null check (slot >= 0),
  bracket_key text,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, stage_id) references pinball_stages (workspace_id, id) on delete cascade
);
create unique index pinball_groups_ws_id_uq on pinball_groups (workspace_id, id);
create index pinball_groups_stage_idx on pinball_groups (stage_id, round, slot);

create table pinball_group_players (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  group_id uuid not null,
  player_id uuid not null,
  seat int not null check (seat >= 1),
  primary key (group_id, player_id),
  foreign key (workspace_id, group_id) references pinball_groups (workspace_id, id) on delete cascade,
  foreign key (workspace_id, player_id) references pinball_players (workspace_id, id) on delete cascade
);

create table pinball_games (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  group_id uuid not null,
  game_no int not null check (game_no >= 1),
  machine_id uuid,
  status text not null default 'pending' check (status in ('pending','playing','done')),
  updated_at timestamptz not null default now(),
  unique (group_id, game_no),
  foreign key (workspace_id, group_id) references pinball_groups (workspace_id, id) on delete cascade,
  foreign key (workspace_id, machine_id) references pinball_machines (workspace_id, id) on delete set null (machine_id)
);
create unique index pinball_games_ws_id_uq on pinball_games (workspace_id, id);

create table pinball_scores (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  game_id uuid not null,
  player_id uuid not null,
  score bigint not null check (score >= 0),
  placement int not null check (placement >= 1),
  points numeric(8,2) not null default 0,
  primary key (game_id, player_id),
  foreign key (workspace_id, game_id) references pinball_games (workspace_id, id) on delete cascade,
  foreign key (workspace_id, player_id) references pinball_players (workspace_id, id) on delete cascade
);

create table pinball_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  stage_id uuid not null,
  player_id uuid not null,
  machine_id uuid not null,
  score bigint not null check (score >= 0),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, stage_id) references pinball_stages (workspace_id, id) on delete cascade,
  foreign key (workspace_id, player_id) references pinball_players (workspace_id, id) on delete cascade,
  foreign key (workspace_id, machine_id) references pinball_machines (workspace_id, id) on delete cascade
);
create index pinball_attempts_stage_idx on pinball_attempts (stage_id, player_id);

do $$ declare t text; begin
  foreach t in array array['pinball_players','pinball_machines','pinball_stages','pinball_groups','pinball_group_players','pinball_games','pinball_scores','pinball_attempts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy %I on %I using (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) with check (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t || '_tenant', t);
  end loop;
end $$;
