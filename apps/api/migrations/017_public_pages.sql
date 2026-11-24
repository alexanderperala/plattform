-- Publika sidor (opt-in). public_pages är medvetet en plattformstabell utan RLS: den slås upp via den publika adressen (slug) innan arbetsytan är känd.
-- Den innehåller inga personuppgifter, bara inställningar och när/vem som bekräftade ansvaret för publiceringen.
create table public_pages (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$'),
  enabled boolean not null default false,
  show_news boolean not null default true,
  consent_at timestamptz,
  consent_by uuid references users(id) on delete set null,
  consent_version text,
  updated_at timestamptz not null default now()
);
-- Varje turnering är avstängd från publik visning tills en admin uttryckligen slår på den.
alter table tournaments add column is_public boolean not null default false;
