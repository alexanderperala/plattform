-- Utslagning: nytt format, matchplats i bracketen, vinnare, och tomma platser (väntar på tidigare omgång).
alter table tournaments drop constraint tournaments_format_check;
alter table tournaments add constraint tournaments_format_check check (format in ('round_robin','single_elimination'));
alter table tournament_matches alter column home_team_id drop not null;
alter table tournament_matches alter column away_team_id drop not null;
alter table tournament_matches add column position int check (position is null or position >= 0);
alter table tournament_matches add column winner_team_id uuid;
alter table tournament_matches add foreign key (workspace_id, winner_team_id) references tournament_teams (workspace_id, id) on delete cascade;
create unique index tournament_matches_slot_uq on tournament_matches (tournament_id, round, position) where position is not null;
