-- Gruppslutspel (fyra spelare, de bästa går vidare) som ny stegtyp.
alter table pinball_stages drop constraint pinball_stages_kind_check;
alter table pinball_stages add constraint pinball_stages_kind_check check (kind in ('best_game','matchplay','swiss','round_robin','single_elim','double_elim','group_knockout'));
