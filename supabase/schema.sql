-- Greenlight — Supabase/Postgres schema
--
-- Run this once against your Supabase project (SQL Editor, or
-- `psql "$DATABASE_URL" -f supabase/schema.sql`) before pointing the app at
-- it. Every statement is idempotent (IF NOT EXISTS) so re-running this file
-- is always safe and never touches existing rows.
--
-- This file ONLY creates structure — no tables here are ever seeded or
-- reset by the running application (see server/db/pgStore.js), and this
-- file itself inserts no data. Two separate, explicit steps handle data:
--   - scripts/migrate-json-to-supabase.js  — imports your existing
--     data/store.json (releases, regression modules, audit log, test data,
--     team) into these tables, once, safely re-runnable.
--   - scripts/seed-defaults.js             — the same starter regression
--     module list / starter team db.js used to seed a brand-new
--     data/store.json, but only inserted here if you explicitly run it and
--     only if those tables are still empty. Never required if the
--     migration script above already brought in real data.
--
-- Design: `releases`, `test_data`, and `team` each keep the app's existing
-- JSON document shape untouched in a JSONB `data` column, keyed by the
-- app's own UUID `id` (generated in the route, not by Postgres) — this
-- preserves the existing nested structure (tickets, regression entities/
-- services, bugs, platforms, etc.) instead of flattening it into tables it
-- was never designed for. `regression_modules` is a single reusable value
-- (not a per-id collection), so it's a one-row "singleton" table.
-- `audit_log` records were already flat, so that one is a normal relational
-- table with typed columns. `atlassian_tokens` is per-USER (one row per
-- signed-in Atlassian account, keyed by that account's stable accountId —
-- see server/auth/atlassianTokens.js), which is the opposite of the old
-- single shared `jira_config` connection this replaces.

create extension if not exists pgcrypto; -- for gen_random_uuid(), used only as a defensive default

-- ---------------------------------------------------------------------
-- releases
-- ---------------------------------------------------------------------
create table if not exists releases (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table releases is 'Full release documents (tickets, regression, bugs, platforms, etc.) stored whole as JSONB — see server/db/pgStore.js.';
create index if not exists idx_releases_created_at on releases (created_at desc);
create index if not exists idx_releases_data_gin on releases using gin (data jsonb_path_ops);

-- ---------------------------------------------------------------------
-- regression_modules — single reusable master list (Entity -> Services),
-- one row, id is always 1.
-- ---------------------------------------------------------------------
create table if not exists regression_modules (
  id smallint primary key default 1,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint regression_modules_singleton check (id = 1)
);
comment on table regression_modules is 'The one reusable master Regression Module list (Entity -> Services) new releases are seeded from. Always exactly one row (id = 1).';

-- ---------------------------------------------------------------------
-- audit_log — append-only; already-flat records, so real typed columns.
-- ---------------------------------------------------------------------
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  user_name text not null default 'Unknown',
  action text not null,
  entity_type text not null default '',
  entity_id text not null default '',
  details text not null default '',
  created_at timestamptz not null default now()
);
comment on table audit_log is 'Append-only record of meaningful actions across the app — see server/routes/audit.js for the allowed action list.';
create index if not exists idx_audit_log_created_at on audit_log (created_at desc);
create index if not exists idx_audit_log_entity on audit_log (entity_type, entity_id);

-- ---------------------------------------------------------------------
-- test_data — reusable QA test data library, independent of any release.
-- ---------------------------------------------------------------------
create table if not exists test_data (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table test_data is 'Reusable QA Test Data records (National ID, Supported Scenarios, Entities, Tags, Notes) stored whole as JSONB — see server/db/pgStore.js.';
create index if not exists idx_test_data_created_at on test_data (created_at desc);
create index if not exists idx_test_data_data_gin on test_data using gin (data jsonb_path_ops);

-- ---------------------------------------------------------------------
-- team — "Know the Team" roster, independent of releases and of auth.
-- ---------------------------------------------------------------------
create table if not exists team (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table team is '"Know the Team" roster entries, stored whole as JSONB — see server/db/pgStore.js.';
create index if not exists idx_team_created_at on team (created_at desc);

-- ---------------------------------------------------------------------
-- jira_config — RETIRED. Greenlight no longer has any shared/global Jira
-- credential: every user authorizes Jira access themselves via "Sign in
-- with Atlassian" (see atlassian_tokens below). Dropped rather than left
-- behind so no shared API token can linger in the database after the
-- architecture that used it is gone. Safe to run even if this table was
-- never created in your project.
-- ---------------------------------------------------------------------
drop table if exists jira_config;

-- ---------------------------------------------------------------------
-- atlassian_tokens — each signed-in user's own Jira OAuth 2.0 (3LO) tokens.
-- One row per Atlassian account (keyed by that account's stable accountId,
-- never email — see server/auth/atlassianTokens.js), so every Jira API
-- call the app makes goes out under that specific user's own Atlassian
-- authorization and respects their own Jira permissions. Tokens here are
-- never sent to the browser — protect this table the same way you would
-- any other credential store: Supabase's default Postgres role/RLS setup
-- already keeps it off any public/anon API surface as long as you don't
-- expose this table through Supabase's auto-generated REST API.
-- ---------------------------------------------------------------------
create table if not exists atlassian_tokens (
  account_id text primary key,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz not null,
  scope text not null default '',
  updated_at timestamptz not null default now()
);
comment on table atlassian_tokens is 'Per-user Atlassian OAuth 2.0 (3LO) access/refresh tokens, one row per Atlassian accountId. The only Jira credential store in the app — there is no shared/global Jira connection anymore.';
