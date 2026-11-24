-- Betalning (avsnitt 10): leverantörens pris-ID per plan, faktureringsuppgifter (MOMS-1), fakturaspegling (PAY-5/PAY-7) och idempotens för webhooks (PAY-4).
alter table plans add column yearly_price_minor int check (yearly_price_minor is null or yearly_price_minor >= 0);
alter table plans add column provider_price_monthly text;
alter table plans add column provider_price_yearly text;
update plans set yearly_price_minor = monthly_price_minor * 10 where not is_trial; -- platshållare: två månader gratis vid årsbetalning
alter table subscriptions add column billing_interval text check (billing_interval is null or billing_interval in ('month','year'));

create table workspace_billing_profiles (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  company_name text not null,
  org_number text,
  vat_id text,
  country char(2) not null check (country ~ '^[A-Z]{2}$'),
  address_line text not null,
  postal_code text not null,
  city text not null,
  billing_email text not null,
  updated_at timestamptz not null default now()
);

-- Fakturaunderlag sparas i 7 år och raderas aldrig automatiskt. Medvetet ingen FK mot workspaces så att underlaget överlever en eventuell arbetsyteradering.
create table invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  provider_invoice_id text not null unique,
  number text,
  status text not null,
  amount_minor int not null,
  tax_minor int not null default 0,
  currency text not null,
  hosted_url text,
  pdf_url text,
  period_start timestamptz,
  period_end timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index invoices_ws_idx on invoices (workspace_id, created_at desc);

-- En rad per mottagen webhook (endast ID:n, ingen payload – den kan innehålla personuppgifter).
create table billing_events (
  provider_event_id text primary key,
  type text not null,
  workspace_id uuid,
  outcome text not null,
  received_at timestamptz not null default now()
);
