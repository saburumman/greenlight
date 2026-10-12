-- Greenlight — migration: Reporting cache (REPORTING_SPEC.md §2.2)
--
-- Relational cache of Jira issues, worklogs and status transitions that the
-- Reporting module reads (hours only; never story points), plus the sync-run
-- log and one settings row. The server runs these same statements itself at
-- startup when DATABASE_URL is set, so applying this by hand is optional —
-- it is here for a database role that is not allowed to CREATE at runtime.
-- Idempotent and additive: it never touches or deletes an existing row.
--
--   psql "$DATABASE_URL" -f supabase/migrations/0003_reporting_cache.sql

create table if not exists reporting_issues (
  issue_key text primary key,
  summary text not null default '',
  issue_type text not null default 'Task',
  parent_key text, epic_key text, epic_name text,
  service text, component text, squad text,
  labels text[] not null default '{}',
  priority text, fix_version text, release text,
  status text not null default 'Unknown',
  status_category text not null default 'To Do',
  assignee_id text, assignee_name text, reporter_name text,
  sprints jsonb not null default '[]'::jsonb,
  sprint_count integer not null default 0,
  created_at timestamptz, started_at timestamptz, completed_at timestamptz,
  due_date date,
  original_estimate_h numeric(10,2), remaining_estimate_h numeric(10,2),
  logged_h numeric(10,2) not null default 0,
  is_blocked boolean not null default false,
  blocked_days numeric(8,2) not null default 0,
  external_dependency_id text,
  was_reopened boolean not null default false,
  reopen_count integer not null default 0,
  variance_h numeric(10,2), variance_pct numeric(10,2),
  estimate_accuracy_band text not null default 'Unestimated',
  cycle_time_days numeric(8,2), lead_time_days numeric(8,2), age_days numeric(8,2),
  is_overdue boolean not null default false,
  synced_at timestamptz not null default now()
);
create index if not exists idx_reporting_issues_epic on reporting_issues (epic_key);
create index if not exists idx_reporting_issues_assignee on reporting_issues (assignee_id);
create index if not exists idx_reporting_issues_category on reporting_issues (status_category);
create index if not exists idx_reporting_issues_completed on reporting_issues (completed_at);

create table if not exists reporting_worklogs (
  worklog_id text primary key,
  issue_key text not null,
  author_id text, author_name text,
  started_at timestamptz,
  time_spent_h numeric(10,2) not null default 0,
  comment text not null default ''
);
create index if not exists idx_reporting_worklogs_issue on reporting_worklogs (issue_key);
create index if not exists idx_reporting_worklogs_author on reporting_worklogs (author_id, started_at);

create table if not exists reporting_status_transitions (
  id bigserial primary key,
  issue_key text not null,
  from_status text, to_status text,
  changed_at timestamptz not null,
  changed_by text
);
create index if not exists idx_reporting_transitions_issue on reporting_status_transitions (issue_key, changed_at);

create table if not exists reporting_sync_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  issues_synced integer not null default 0,
  worklogs_synced integer not null default 0,
  status text not null default 'running',
  error text
);

create table if not exists reporting_settings (
  id smallint primary key default 1,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint reporting_settings_singleton check (id = 1)
);
