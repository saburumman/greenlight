-- RCA page: root-cause analyses, plus a tiny key/value table for one-time
-- upgrade markers. Additive and idempotent. The app also creates both tables
-- automatically on first use.
create table if not exists rcas (
  id uuid primary key,
  release_id text,           -- the release that caused the issue (no foreign key: deleting a release keeps its RCAs)
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_rcas_release on rcas (release_id);
create index if not exists idx_rcas_created_at on rcas (created_at desc);
comment on table rcas is 'Root-cause analyses: the issue, the cause, the corrective and preventive actions, and the release that caused it. Stored whole as JSONB like the other collections.';

create table if not exists app_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table app_meta is 'One-time upgrade markers (e.g. which new permissions were already added to the built-in roles).';
