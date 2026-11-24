-- S1: assisterad support. Kundens godkännande (scope 'assisted') anger tillåtna åtgärder.
alter table support_access_sessions add column actions int not null default 0;
alter table support_access_grants add constraint support_grants_assisted_actions_chk
  check (scope <> 'assisted' or (cardinality(allowed_actions) > 0 and allowed_actions <@ array['change_setting','enable_permission','configure_feature']::text[]));
