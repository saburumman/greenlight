-- Daily QA Report: days a team member was absent (not counted as missed).
-- The app also creates this table automatically on first use.
create table if not exists daily_qa_absences (
  id uuid primary key,
  team_member_id text not null,
  absent_date text not null check (absent_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  data jsonb not null,
  created_at timestamptz not null default now(),
  constraint daily_qa_absences_one_per_member_per_day unique (team_member_id, absent_date)
);
comment on table daily_qa_absences is 'Days a team member marked themselves absent on the Daily QA Report page — not counted as missed in Statistics.';
