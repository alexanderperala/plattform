-- Gruppspel + slutspel: format, antal grupper, hur många som går vidare, gruppnummer på lag och gruppmatcher.
alter table tournaments drop constraint tournaments_format_check;
alter table tournaments add constraint tournaments_format_check check (format in ('round_robin','single_elimination','groups_knockout'));
alter table tournaments add column group_count int check (group_count is null or group_count in (2,4,8));
alter table tournaments add column advance_per_group int check (advance_per_group is null or advance_per_group in (1,2));
alter table tournaments add constraint tournaments_groups_chk check ((format = 'groups_knockout') = (group_count is not null and advance_per_group is not null));
alter table tournament_teams add column group_no int check (group_no is null or group_no >= 1);
alter table tournament_matches add column group_no int check (group_no is null or group_no >= 1);
