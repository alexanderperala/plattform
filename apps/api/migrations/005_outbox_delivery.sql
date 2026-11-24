-- Leverans av e-post (S1): omförsök med backoff och spårning av försök.
alter table notification_outbox
  add column next_attempt_at timestamptz not null default now(),
  add column last_attempt_at timestamptz,
  add column message_id text;
drop index if exists outbox_status_idx;
create index outbox_due_idx on notification_outbox (next_attempt_at) where status = 'pending';
create index outbox_status_idx on notification_outbox (status, created_at);
-- Kommentar som skickats till kund: spåra mottagare
alter table support_case_comments add column sent_to text;
