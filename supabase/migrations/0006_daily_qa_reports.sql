-- Greenlight — migration: Daily QA Report
--
-- One report per Know the Team member per report date (Asia/Amman). The report
-- is JSONB like the other collections; the owner and the date are real columns
-- under a UNIQUE constraint, so the database itself refuses a second report for
-- the same person and day even if two requests race. There is deliberately NO
-- foreign key to the team table: removing someone from Know the Team must not
-- erase the reports they already submitted (their name is stored on the report).
--
-- daily_qa_reminders holds one row per day the 3:45 PM Slack reminder was sent,
-- so a restart (or a second server instance) can't send it twice.
--
-- The server creates both tables itself the first time the Daily QA Report is
-- used; applying this by hand is optional. Idempotent and additive.
--
--   psql "$DATABASE_URL" -f supabase/migrations/0006_daily_qa_reports.sql

create table if not exists daily_qa_reports (
  id uuid primary key,
  team_member_id text not null,
  report_date text not null check (report_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_qa_reports_one_per_member_per_day unique (team_member_id, report_date)
);
comment on table daily_qa_reports is 'Daily QA Report: today / tomorrow / blockers per team member per Amman date, plus the Slack delivery outcome (data.slack) — see server/dailyReportLogic.js.';
create index if not exists idx_daily_qa_reports_member_date on daily_qa_reports (team_member_id, report_date desc);

create table if not exists daily_qa_reminders (
  report_date text primary key,
  claimed_at timestamptz not null default now()
);
