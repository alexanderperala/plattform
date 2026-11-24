-- Referensdata som måste finnas i alla miljöer.
-- OBS: priserna är platshållare och ska fastställas av plattformsägaren före Lansering 2.
insert into plans (id, name, monthly_price_minor, currency, is_trial, sort_order) values
  ('trial',    'Provperiod', 0,      'SEK', true,  0),
  ('start',    'Start',      14900,  'SEK', false, 1),
  ('standard', 'Standard',   39900,  'SEK', false, 2),
  ('pro',      'Pro',        89900,  'SEK', false, 3);

insert into plan_entitlements (plan_id, product, limits) values
  ('trial',    'association_portal', '{"max_users":10,"max_members":200,"storage_mb":500}'),
  ('trial',    'tournament_system',  '{"max_users":10,"max_tournaments":3,"storage_mb":500}'),
  ('start',    'association_portal', '{"max_users":5,"max_members":150,"storage_mb":1000}'),
  ('start',    'tournament_system',  '{"max_users":5,"max_tournaments":5,"storage_mb":1000}'),
  ('standard', 'association_portal', '{"max_users":25,"max_members":1000,"storage_mb":10000}'),
  ('standard', 'tournament_system',  '{"max_users":25,"max_tournaments":25,"storage_mb":10000}'),
  ('pro',      'association_portal', '{"max_users":null,"max_members":null,"storage_mb":100000}'),
  ('pro',      'tournament_system',  '{"max_users":null,"max_tournaments":null,"storage_mb":100000}');

insert into feature_flags (key, description, default_enabled) values
  ('association.forum_v2',     'Ny forumupplevelse (beta)', false),
  ('tournament.custom_formats','Egna tävlingsformat (beta)', false);

insert into platform_settings (key, value) values
  ('billing.grace_period_days',                to_jsonb(14)),
  ('trial.default_days',                       to_jsonb(30)),
  ('retention.closed_workspace_days',          to_jsonb(90)),
  ('retention.product_data_months',            to_jsonb(12)),
  ('security.allow_sole_owner_self_approval',  to_jsonb(true));
