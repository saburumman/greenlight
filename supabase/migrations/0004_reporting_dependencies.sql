-- Greenlight — migration: Reporting dependency tracker (REPORTING_SPEC.md §4, sheet 9)
--
-- What government entities and vendors owe the programme (what is needed, who
-- owns the follow-up, when it was promised, status). Jira tickets are linked to a
-- row through reporting_issues.external_dependency_id (a sync never overwrites
-- that link). The server creates this table itself at startup; applying this by
-- hand is optional. Idempotent and additive.
--
--   psql "$DATABASE_URL" -f supabase/migrations/0004_reporting_dependencies.sql

create table if not exists reporting_dependencies (
  id bigserial primary key,
  entity text not null,
  vendor text not null default '',
  needed text not null default '',
  owner_name text not null default '',
  promised_date date,
  status text not null default 'Requested',
  last_contact_date date,
  next_followup_date date,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reporting_dependencies_status check (status in ('Requested','In progress','Received','Cancelled'))
);
