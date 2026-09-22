-- Greenlight — migration: per-user Atlassian OAuth
--
-- Applies just the schema DELTA from the move to per-user "Sign in with
-- Atlassian": every user now authorizes their own Jira access, so the old
-- single shared Jira connection (jira_config) is retired, and a new
-- per-user token store (atlassian_tokens) replaces it.
--
-- This is already folded into the full supabase/schema.sql (which is
-- idempotent and safe to re-run in full at any time) — this file exists
-- separately for a database that was already provisioned before this
-- change, so you can apply just the delta without re-running the whole
-- schema. Safe to run more than once: every statement is idempotent
-- (IF EXISTS / IF NOT EXISTS) and neither statement touches any other
-- table or any existing row.
--
-- Run once against your Supabase project:
--   psql "$DATABASE_URL" -f supabase/migrations/0001_atlassian_oauth_per_user.sql
-- or paste it into the Supabase SQL Editor.

-- ---------------------------------------------------------------------
-- jira_config — RETIRED. Greenlight no longer has any shared/global Jira
-- credential — every user authorizes Jira access themselves via "Sign in
-- with Atlassian" (see atlassian_tokens below). If this table exists and
-- still has a row in it, that row holds a real Jira API token in
-- plaintext — dropping the table removes it from the database. Safe to
-- run even if this table was never created in your project.
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
