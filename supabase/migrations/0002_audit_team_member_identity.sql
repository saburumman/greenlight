-- Greenlight — migration: audit records use Know the Team member ids
--
-- Guest sessions are gone; every audit record now carries the stable id of
-- the Know the Team member who acted (team_member_id), plus an optional
-- structured payload (meta) for events such as regression status changes
-- (assignedTo / changedBy / previousStatus / newStatus).
--
-- The server runs these same two ADD COLUMN statements itself the first time
-- the audit log is used, so applying this by hand is optional — it's here for
-- a database role that isn't allowed to ALTER at runtime. Idempotent and
-- additive: it never touches or deletes an existing row.
--
--   psql "$DATABASE_URL" -f supabase/migrations/0002_audit_team_member_identity.sql

alter table audit_log add column if not exists team_member_id text;
alter table audit_log add column if not exists meta jsonb;
create index if not exists idx_audit_log_team_member on audit_log (team_member_id);
