-- 0008 — Users, roles & permissions (RBAC).
--
-- ADDITIVE ONLY: four new tables, nothing existing is altered or dropped, no
-- row of releases / regression / test data / team / audit_log / reports is
-- touched. The app also creates these tables by itself on first use; this
-- file is the same DDL for people who prefer to run it by hand.
--
-- Prerequisite: the `team` table (schema.sql). app_users.team_member_id is a
-- real foreign key to it with ON DELETE SET NULL, so removing a Team Member
-- card can never delete a user or any history.
--
-- Built-in roles (Super Admin, Admin, QA Lead, QA Engineer, Viewer) are not
-- inserted here: the server creates them on first start (idempotent), because
-- their permission lists live in server/permissions.js next to the code that
-- enforces them. Existing people are migrated by the app the first time they
-- sign in (see README → "Users, roles & permissions → Existing users").
--
-- ROLLBACK (only if you must go back to the previous release): see
-- 0008_users_roles_permissions_rollback.sql. The previous release ignores these
-- tables entirely, so simply deploying it again is also safe — the tables just
-- stay unused.

create table if not exists app_roles (
  id uuid primary key,
  system_key text unique,
  name text not null check (length(btrim(name)) > 0),
  description text not null default '',
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_app_roles_name on app_roles (lower(btrim(name)));
comment on table app_roles is 'Roles (built-in and custom). A role is a named set of permissions; permission keys are defined in server/permissions.js.';

create table if not exists app_role_permissions (
  role_id uuid not null references app_roles(id) on delete cascade,
  permission text not null,
  primary key (role_id, permission)
);

create table if not exists app_users (
  id uuid primary key,
  jira_account_id text not null,
  display_name text not null default '',
  email text,
  avatar_url text,
  role_id uuid references app_roles(id) on delete restrict,
  status text not null default 'PENDING' check (status in ('PENDING','ACTIVE','INACTIVE')),
  team_member_id uuid references team(id) on delete set null,
  legacy_adopted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz,
  status_changed_at timestamptz,
  constraint uq_app_users_jira_account unique (jira_account_id),
  constraint app_users_active_needs_role check (status <> 'ACTIVE' or role_id is not null)
);
create unique index if not exists uq_app_users_team_member on app_users (team_member_id) where team_member_id is not null;
create index if not exists idx_app_users_role on app_users (role_id);
comment on table app_users is 'Application users — one row per Jira accountId (never email or name). Holds the role, status and the stable link to a Know the Team member. No credentials or Jira tokens are stored here (those stay in atlassian_tokens).';

create table if not exists app_user_permission_overrides (
  user_id uuid not null references app_users(id) on delete cascade,
  permission text not null,
  effect text not null check (effect in ('allow','deny')),
  expires_at timestamptz,
  reason text,
  created_by text,
  created_at timestamptz not null default now(),
  primary key (user_id, permission)
);
comment on table app_user_permission_overrides is 'Per-user exceptions to the role: ALLOW adds a permission, DENY removes it (DENY always wins). Optional expiry for temporary access.';
