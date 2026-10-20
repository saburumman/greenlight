-- Greenlight — migration: Related Test Accounts (links between Test Data records)
--
-- One row per link. The document (labels, who/when) is JSONB like the other
-- collections; the two account ids are real columns with foreign keys to
-- test_data ON DELETE CASCADE, so deleting a Test Data account removes its links
-- and the database refuses a link to an account that doesn't exist. Existing
-- test_data rows are not touched. The server creates this table itself the first
-- time relationships are used; applying this by hand is optional. Idempotent
-- and additive.
--
--   psql "$DATABASE_URL" -f supabase/migrations/0005_test_account_relationships.sql

create table if not exists test_account_relationships (
  id uuid primary key,
  account_a_id uuid not null references test_data(id) on delete cascade,
  account_b_id uuid not null references test_data(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint test_account_relationships_not_self check (account_a_id <> account_b_id)
);
comment on table test_account_relationships is 'Links between Test Data accounts: A lists B as relationshipType, B lists A as inverseRelationshipType (null = one-way) — see server/testAccountRelationships.js.';
create index if not exists idx_test_account_relationships_a on test_account_relationships (account_a_id);
create index if not exists idx_test_account_relationships_b on test_account_relationships (account_b_id);
