// Postgres-backed persistence layer (Supabase or any standard Postgres) —
// selected by server/db.js whenever DATABASE_URL is set. Exposes the exact
// same interface as server/db/jsonStore.js (list/get/set/delete/append),
// so nothing above this file (the route handlers) needs to know which
// backend is active.
//
// Design choice: `releases`, `testData`, and `team` each keep their full
// existing JSON document shape untouched, stored whole in a `data JSONB`
// column keyed by the app's own UUID `id` — per the migration brief, this
// preserves the existing nested structure (tickets, regression entities/
// services, bugs, platforms, etc.) instead of flattening it into a
// relational schema it was never designed for. `regressionModules` is a
// single reusable master list (not a per-id collection), so it's stored as
// one JSONB row. `auditLog` records are already flat, so that one *is* a
// normal relational table with typed columns — see supabase/schema.sql for
// the full DDL this expects to already exist (this file only ever reads/
// writes rows; it never creates tables or seeds default data — see
// scripts/seed-defaults.js for that, run manually and separately so a
// server restart in production can never overwrite real data).

const pgPool = require("./pgPool");
const { ALL_PERMISSIONS } = require("../permissions");

function isoOrNow(value) {
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

// Shared list-sort: newest-created first, falling back to updatedAt — the
// exact same rule server/db/jsonStore.js has always used. Sorting here in
// JS (rather than `ORDER BY` in SQL) keeps behavior byte-identical across
// both backends, including how it handles legacy rows missing either field.
function sortNewestFirst(items) {
  return items.slice().sort((a, b) =>
    String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || ""))
  );
}

// ---- Generic helpers for the three "JSONB document keyed by id" tables
// (releases, test_data, team) — they're identical in shape, so one set of
// functions backs all three list/get/set/delete implementations below.

async function docList(table) {
  const { rows } = await pgPool.query(`SELECT data FROM ${table}`);
  return sortNewestFirst(rows.map((r) => r.data));
}

async function docGet(table, id) {
  const { rows } = await pgPool.query(`SELECT data FROM ${table} WHERE id = $1`, [id]);
  return rows.length ? rows[0].data : null;
}

async function docSet(table, id, doc) {
  const createdAt = isoOrNow(doc && doc.createdAt);
  const updatedAt = isoOrNow(doc && doc.updatedAt);
  await pgPool.query(
    `INSERT INTO ${table} (id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [id, JSON.stringify(doc), createdAt, updatedAt]
  );
  return doc;
}

async function docDelete(table, id) {
  await pgPool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
}

const releases = {
  list: () => docList("releases"),
  get: (id) => docGet("releases", id),
  set: (id, release) => docSet("releases", id, release),
  delete: (id) => docDelete("releases", id),
};

const testData = {
  list: () => docList("test_data"),
  get: (id) => docGet("test_data", id),
  set: (id, record) => docSet("test_data", id, record),
  delete: (id) => docDelete("test_data", id),
};

// Links between Test Data accounts (see server/testAccountRelationships.js).
// The document stays JSONB like its siblings, but the two account ids are also
// real columns with foreign keys to test_data ON DELETE CASCADE, so the
// database itself guarantees a link never points at a deleted account (and
// refuses one to an account that doesn't exist). The table is created on first
// use (idempotent), so a database that hasn't had
// supabase/migrations/0005_test_account_relationships.sql applied by hand keeps
// working; if the role may not create tables the error surfaces on the
// relationship endpoints only — Test Data itself is unaffected.
let relTablePromise = null;
function ensureRelationshipsTable() {
  if (!relTablePromise) {
    relTablePromise = pgPool.query(RELATIONSHIPS_DDL).catch((e) => {
      relTablePromise = null;
      throw e;
    });
  }
  return relTablePromise;
}
const RELATIONSHIPS_DDL = `
create table if not exists test_account_relationships (
  id uuid primary key,
  account_a_id uuid not null references test_data(id) on delete cascade,
  account_b_id uuid not null references test_data(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint test_account_relationships_not_self check (account_a_id <> account_b_id)
);
create index if not exists idx_test_account_relationships_a on test_account_relationships (account_a_id);
create index if not exists idx_test_account_relationships_b on test_account_relationships (account_b_id);
`;
const testAccountRelationships = {
  async list() {
    await ensureRelationshipsTable();
    const { rows } = await pgPool.query(`SELECT data FROM test_account_relationships`);
    return sortNewestFirst(rows.map((r) => r.data));
  },
  async get(id) {
    await ensureRelationshipsTable();
    const { rows } = await pgPool.query(`SELECT data FROM test_account_relationships WHERE id = $1`, [id]);
    return rows.length ? rows[0].data : null;
  },
  async set(id, rel) {
    await ensureRelationshipsTable();
    await pgPool.query(
      `INSERT INTO test_account_relationships (id, account_a_id, account_b_id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         account_a_id = EXCLUDED.account_a_id,
         account_b_id = EXCLUDED.account_b_id,
         data = EXCLUDED.data,
         updated_at = EXCLUDED.updated_at`,
      [id, rel.accountAId, rel.accountBId, JSON.stringify(rel), isoOrNow(rel.createdAt), isoOrNow(rel.updatedAt)]
    );
    return rel;
  },
  async delete(id) {
    await ensureRelationshipsTable();
    await pgPool.query(`DELETE FROM test_account_relationships WHERE id = $1`, [id]);
  },
  async deleteForAccount(accountId) {
    await ensureRelationshipsTable();
    const { rows } = await pgPool.query(
      `DELETE FROM test_account_relationships WHERE account_a_id = $1 OR account_b_id = $1 RETURNING data`,
      [accountId]
    );
    return rows.map((r) => r.data);
  },
};

const team = {
  list: () => docList("team"),
  get: (id) => docGet("team", id),
  set: (id, member) => docSet("team", id, member),
  delete: (id) => docDelete("team", id),
};

// The reusable master list of regression modules — a single row (id = 1),
// same "one JSONB blob" idea as above but with no per-record id. An empty
// table (nothing seeded yet) is a legitimate state here, not an error —
// list() just returns [] rather than auto-creating defaults; see
// scripts/seed-defaults.js for the explicit, one-time seeding step.
const regressionModules = {
  async list() {
    const { rows } = await pgPool.query(`SELECT data FROM regression_modules WHERE id = 1`);
    return rows.length ? rows[0].data : [];
  },
  async set(modules) {
    await pgPool.query(
      `INSERT INTO regression_modules (id, data, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(modules)]
    );
    return modules;
  },
};

// Append-only Audit Log — the one collection whose records were already
// flat (no nested structure), so this is a normal relational table with
// typed columns and a real ORDER BY, rather than a JSONB blob.
//
// Two columns were added when audit records moved from a guest/session id to
// stable Know the Team member ids (see supabase/migrations/0002_*.sql):
//   team_member_id  the team member who acted (null when the signed-in user
//                   hasn't linked themselves to a team member yet)
//   meta            small structured JSONB for events that carry data
//                   (assignedTo / changedBy / previousStatus / newStatus ...)
// ensureAuditColumns() applies exactly those two idempotent ADD COLUMNs the
// first time the audit log is touched, so a database provisioned before this
// change keeps working without a manual step. If the database role isn't
// allowed to ALTER, the store quietly degrades: reads/writes keep working on
// the original columns (the member id is then kept in session_id and `meta`
// is not stored) and the failure is logged once.
let auditColumnsPromise = null;
function ensureAuditColumns() {
  if (!auditColumnsPromise) {
    auditColumnsPromise = pgPool
      .query("ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS team_member_id text, ADD COLUMN IF NOT EXISTS meta jsonb")
      .then(() => true)
      .catch((e) => {
        console.error("  audit_log: couldn't add team_member_id/meta columns (" + e.message + ") — run supabase/migrations/0002_audit_team_member_identity.sql. Falling back to the original columns.");
        return false;
      });
  }
  return auditColumnsPromise;
}

const AUDIT_BASE_COLS = "id, session_id, user_name, action, entity_type, entity_id, details, created_at";
const AUDIT_EXT_COLS = AUDIT_BASE_COLS + ", team_member_id, meta";

const auditLog = {
  async list() {
    const extended = await ensureAuditColumns();
    const { rows } = await pgPool.query(
      `SELECT ${extended ? AUDIT_EXT_COLS : AUDIT_BASE_COLS} FROM audit_log ORDER BY created_at DESC`
    );
    return rows.map(rowToAuditEntry);
  },
  async append(entry) {
    const extended = await ensureAuditColumns();
    const base = [
      entry.id,
      // Legacy column: only filled in when the new team_member_id column
      // isn't available, so the member id is never lost.
      extended ? null : entry.teamMemberId || null,
      entry.userName || "Unknown",
      entry.action,
      entry.entityType || "",
      entry.entityId || "",
      entry.details || "",
      isoOrNow(entry.createdAt),
    ];
    const { rows } = extended
      ? await pgPool.query(
          `INSERT INTO audit_log (${AUDIT_EXT_COLS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${AUDIT_EXT_COLS}`,
          base.concat([entry.teamMemberId || null, entry.meta ? JSON.stringify(entry.meta) : null])
        )
      : await pgPool.query(
          `INSERT INTO audit_log (${AUDIT_BASE_COLS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING
           RETURNING ${AUDIT_BASE_COLS}`,
          base
        );
    if (rows.length) return rowToAuditEntry(rows[0]);
    // Idempotency guard, same contract as jsonStore: a retried request with
    // the same id returns the record that's already there instead of
    // duplicating (or erroring on the primary-key conflict).
    const existing = await pgPool.query(
      `SELECT ${extended ? AUDIT_EXT_COLS : AUDIT_BASE_COLS} FROM audit_log WHERE id = $1`,
      [entry.id]
    );
    return existing.rows.length ? rowToAuditEntry(existing.rows[0]) : entry;
  },
};

function rowToAuditEntry(row) {
  const entry = {
    id: row.id,
    userName: row.user_name,
    action: row.action,
    entityType: row.entity_type || "",
    entityId: row.entity_id || "",
    details: row.details || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
  // team_member_id when the column exists; otherwise (degraded mode) the id
  // was stored in session_id. Old guest-era session ids simply don't match
  // any team member and are ignored by the app.
  entry.teamMemberId = row.team_member_id !== undefined ? row.team_member_id || null : row.session_id || null;
  if (row.meta) entry.meta = row.meta;
  return entry;
}

// Per-user Atlassian OAuth token storage — keyed by accountId, never email
// (see server/auth/atlassianTokens.js, the only other module that touches
// this collection). Real typed columns rather than a JSONB blob, since the
// shape is small, fixed, and never grows nested structure the way
// releases/testData/team do.
const atlassianTokens = {
  async get(accountId) {
    const { rows } = await pgPool.query(
      `SELECT account_id, access_token, refresh_token, expires_at, scope, updated_at
       FROM atlassian_tokens WHERE account_id = $1`,
      [accountId]
    );
    return rows.length ? rowToTokenRecord(rows[0]) : null;
  },
  async set(accountId, record) {
    await pgPool.query(
      `INSERT INTO atlassian_tokens (account_id, access_token, refresh_token, expires_at, scope, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         expires_at = EXCLUDED.expires_at,
         scope = EXCLUDED.scope,
         updated_at = EXCLUDED.updated_at`,
      [
        accountId,
        record.accessToken,
        record.refreshToken || null,
        isoOrNow(record.expiresAt),
        record.scope || "",
        isoOrNow(record.updatedAt),
      ]
    );
    return record;
  },
  async delete(accountId) {
    await pgPool.query(`DELETE FROM atlassian_tokens WHERE account_id = $1`, [accountId]);
  },
};

function rowToTokenRecord(row) {
  return {
    accountId: row.account_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    scope: row.scope || "",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

// Daily QA Reports. The document is JSONB like its siblings, but the owner and
// the report date are real columns under a UNIQUE constraint, so the database
// itself guarantees one report per team member per day even if two requests
// race. No foreign key to `team` on purpose: removing a person from Know the
// Team must not erase the reports they already submitted (the name is stored on
// the report). Tables are created on first use (idempotent) — also available as
// supabase/migrations/0006_daily_qa_reports.sql.
const DAILY_DDL = `
create table if not exists daily_qa_reports (
  id uuid primary key,
  team_member_id text not null,
  report_date text not null check (report_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_qa_reports_one_per_member_per_day unique (team_member_id, report_date)
);
create index if not exists idx_daily_qa_reports_member_date on daily_qa_reports (team_member_id, report_date desc);
create table if not exists daily_qa_absences (
  id uuid primary key,
  team_member_id text not null,
  absent_date text not null check (absent_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  data jsonb not null,
  created_at timestamptz not null default now(),
  constraint daily_qa_absences_one_per_member_per_day unique (team_member_id, absent_date)
);
create table if not exists daily_qa_reminders (
  report_date text primary key,
  claimed_at timestamptz not null default now()
);
`;
let dailyTablePromise = null;
function ensureDailyTables() {
  if (!dailyTablePromise) {
    dailyTablePromise = pgPool.query(DAILY_DDL).catch((e) => {
      dailyTablePromise = null;
      throw e;
    });
  }
  return dailyTablePromise;
}
const dailyReports = {
  async insertIfNew(record) {
    await ensureDailyTables();
    const { rows } = await pgPool.query(
      `INSERT INTO daily_qa_reports (id, team_member_id, report_date, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (team_member_id, report_date) DO NOTHING
       RETURNING data`,
      [record.id, record.teamMemberId, record.reportDate, JSON.stringify(record), isoOrNow(record.createdAt), isoOrNow(record.updatedAt)]
    );
    if (rows.length) return { inserted: true, record: rows[0].data };
    const found = await pgPool.query(
      `SELECT data FROM daily_qa_reports WHERE team_member_id = $1 AND report_date = $2`,
      [record.teamMemberId, record.reportDate]
    );
    return { inserted: false, existing: found.rows.length ? found.rows[0].data : null };
  },
  async get(id) {
    await ensureDailyTables();
    const { rows } = await pgPool.query(`SELECT data FROM daily_qa_reports WHERE id = $1`, [id]);
    return rows.length ? rows[0].data : null;
  },
  async set(id, record) {
    await ensureDailyTables();
    await pgPool.query(
      `UPDATE daily_qa_reports SET data = $2::jsonb, updated_at = $3 WHERE id = $1`,
      [id, JSON.stringify(record), isoOrNow(record.updatedAt)]
    );
    return record;
  },
  async listForMember(memberId, limit) {
    await ensureDailyTables();
    const { rows } = await pgPool.query(
      `SELECT data FROM daily_qa_reports WHERE team_member_id = $1 ORDER BY report_date DESC LIMIT $2`,
      [memberId, limit || 30]
    );
    return rows.map((r) => r.data);
  },
  async listRange(from, to) {
    await ensureDailyTables();
    const { rows } = await pgPool.query(
      `SELECT data FROM daily_qa_reports
        WHERE ($1::text IS NULL OR report_date >= $1) AND ($2::text IS NULL OR report_date <= $2)
        ORDER BY report_date DESC, data->>'memberName' ASC`,
      [from || null, to || null]
    );
    return rows.map((r) => r.data);
  },
  async listAllDates() {
    await ensureDailyTables();
    const { rows } = await pgPool.query(`SELECT team_member_id, report_date FROM daily_qa_reports`);
    return rows.map((r) => ({ teamMemberId: r.team_member_id, reportDate: r.report_date }));
  },
};
const dailyAbsences = {
  async insertIfNew(record) {
    await ensureDailyTables();
    const { rows } = await pgPool.query(
      `INSERT INTO daily_qa_absences (id, team_member_id, absent_date, data, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (team_member_id, absent_date) DO NOTHING RETURNING data`,
      [record.id, record.teamMemberId, record.absentDate, JSON.stringify(record), isoOrNow(record.createdAt)]
    );
    if (rows.length) return { inserted: true, record: rows[0].data };
    const found = await pgPool.query(`SELECT data FROM daily_qa_absences WHERE team_member_id = $1 AND absent_date = $2`, [record.teamMemberId, record.absentDate]);
    return { inserted: false, existing: found.rows.length ? found.rows[0].data : null };
  },
  async remove(memberId, date) {
    await ensureDailyTables();
    const r = await pgPool.query(`DELETE FROM daily_qa_absences WHERE team_member_id = $1 AND absent_date = $2`, [memberId, date]);
    return r.rowCount > 0;
  },
  async find(memberId, date) {
    await ensureDailyTables();
    const { rows } = await pgPool.query(`SELECT data FROM daily_qa_absences WHERE team_member_id = $1 AND absent_date = $2`, [memberId, date]);
    return rows.length ? rows[0].data : null;
  },
  async listForMember(memberId, limit) {
    await ensureDailyTables();
    const { rows } = await pgPool.query(`SELECT data FROM daily_qa_absences WHERE team_member_id = $1 ORDER BY absent_date DESC LIMIT $2`, [memberId, limit || 30]);
    return rows.map((r) => r.data);
  },
  async listRange(from, to) {
    await ensureDailyTables();
    const { rows } = await pgPool.query(
      `SELECT data FROM daily_qa_absences
        WHERE ($1::text IS NULL OR absent_date >= $1) AND ($2::text IS NULL OR absent_date <= $2)
        ORDER BY absent_date DESC, data->>'memberName' ASC`,
      [from || null, to || null]
    );
    return rows.map((r) => r.data);
  },
  async listAllDates() {
    await ensureDailyTables();
    const { rows } = await pgPool.query(`SELECT team_member_id, absent_date FROM daily_qa_absences`);
    return rows.map((r) => ({ teamMemberId: r.team_member_id, absentDate: r.absent_date }));
  },
};
const dailyReminders = {
  async claim(date) {
    await ensureDailyTables();
    const { rows } = await pgPool.query(
      `INSERT INTO daily_qa_reminders (report_date) VALUES ($1) ON CONFLICT (report_date) DO NOTHING RETURNING report_date`,
      [date]
    );
    return rows.length > 0;
  },
  async release(date) {
    await ensureDailyTables();
    await pgPool.query(`DELETE FROM daily_qa_reminders WHERE report_date = $1`, [date]);
  },
};

// ---- Users, roles & permissions (RBAC) --------------------------------
// Unlike the JSONB document tables above, these are properly relational: the
// database itself guarantees the rules the app depends on — one user per Jira
// accountId, one user per Team Member, unique role names, a role can't be
// deleted while users hold it, a user holds at most one role (a single
// role_id column), and permission rows disappear with their role/user.
// A user's Team Member link is a real foreign key to `team(id)` (ON DELETE
// SET NULL — removing a card never deletes the user or any history).
// Tables are created on first use (idempotent) — also available as
// supabase/migrations/0008_users_roles_permissions.sql.
const RBAC_DDL = `
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
`;
let rbacTablePromise = null;
function ensureRbacTables() {
  if (!rbacTablePromise) {
    rbacTablePromise = pgPool.query(RBAC_DDL).catch((e) => {
      rbacTablePromise = null;
      throw e;
    });
  }
  return rbacTablePromise;
}
function rbacError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function mapRbacPgError(e) {
  if (e && e.code === "23505") {
    const c = String(e.constraint || "");
    if (c.includes("app_roles")) return rbacError("DUPLICATE_ROLE_NAME", "A role with that name already exists.");
    if (c.includes("team_member")) return rbacError("TEAM_MEMBER_TAKEN", "That Team Member is already linked to another user.");
    if (c.includes("jira_account")) return rbacError("DUPLICATE_ACCOUNT", "That Jira account is already registered.");
  }
  if (e && e.code === "23503" && String(e.table || "") === "app_users") return rbacError("ROLE_IN_USE", "That role is assigned to users.");
  if (e && e.code === "23503") return rbacError("ROLE_IN_USE", "That role is assigned to users.");
  return e;
}
const iso = (v) => (v ? new Date(v).toISOString() : null);
function rowToRole(r, perms) {
  return {
    id: r.id, systemKey: r.system_key || null, name: r.name, description: r.description || "",
    isSystem: !!r.is_system, isActive: !!r.is_active, createdBy: r.created_by || null,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    // catalogue order (not alphabetical), so both stores return the same order
    permissions: (perms || []).slice().sort((a, b) => { const ia = ALL_PERMISSIONS.indexOf(a), ib = ALL_PERMISSIONS.indexOf(b); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b); }),
  };
}
function rowToUser(r, overrides) {
  return {
    id: r.id, accountId: r.jira_account_id, displayName: r.display_name || "", email: r.email || "",
    avatarUrl: r.avatar_url || "", roleId: r.role_id || null, status: r.status,
    teamMemberId: r.team_member_id || null, legacyAdopted: !!r.legacy_adopted,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), lastLoginAt: iso(r.last_login_at),
    statusChangedAt: iso(r.status_changed_at), overrides: overrides || {},
  };
}
function groupOverrides(rows) {
  const by = new Map();
  for (const o of rows) {
    if (!by.has(o.user_id)) by.set(o.user_id, {});
    by.get(o.user_id)[o.permission] = {
      effect: o.effect, expiresAt: iso(o.expires_at), reason: o.reason || "", createdBy: o.created_by || null, createdAt: iso(o.created_at),
    };
  }
  return by;
}
async function withTx(fn) {
  const client = await pgPool.getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw mapRbacPgError(e);
  } finally {
    client.release();
  }
}
const appRoles = {
  async list() {
    await ensureRbacTables();
    const roles = (await pgPool.query(`SELECT * FROM app_roles`)).rows;
    const perms = (await pgPool.query(`SELECT role_id, permission FROM app_role_permissions`)).rows;
    const by = new Map();
    for (const p of perms) { if (!by.has(p.role_id)) by.set(p.role_id, []); by.get(p.role_id).push(p.permission); }
    return roles.map((r) => rowToRole(r, by.get(r.id)));
  },
  async get(id) {
    await ensureRbacTables();
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
    const { rows } = await pgPool.query(`SELECT * FROM app_roles WHERE id = $1`, [id]);
    if (!rows.length) return null;
    const perms = (await pgPool.query(`SELECT permission FROM app_role_permissions WHERE role_id = $1`, [id])).rows.map((p) => p.permission);
    return rowToRole(rows[0], perms);
  },
  async save(role) {
    await ensureRbacTables();
    await withTx(async (c) => {
      await c.query(
        `INSERT INTO app_roles (id, system_key, name, description, is_system, is_active, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
           is_active = EXCLUDED.is_active, updated_at = EXCLUDED.updated_at`,
        [role.id, role.systemKey || null, role.name, role.description || "", !!role.isSystem, role.isActive !== false,
         role.createdBy || null, isoOrNow(role.createdAt), isoOrNow(role.updatedAt)]
      );
      await c.query(`DELETE FROM app_role_permissions WHERE role_id = $1`, [role.id]);
      if ((role.permissions || []).length) {
        await c.query(
          `INSERT INTO app_role_permissions (role_id, permission) SELECT $1, unnest($2::text[])`,
          [role.id, role.permissions]
        );
      }
    });
    return role;
  },
  async delete(id) {
    await ensureRbacTables();
    try {
      await pgPool.query(`DELETE FROM app_roles WHERE id = $1`, [id]);
    } catch (e) {
      throw mapRbacPgError(e);
    }
  },
};
async function oneUser(where, param) {
  await ensureRbacTables();
  const { rows } = await pgPool.query(`SELECT * FROM app_users WHERE ${where}`, [param]);
  if (!rows.length) return null;
  const ov = groupOverrides((await pgPool.query(`SELECT * FROM app_user_permission_overrides WHERE user_id = $1`, [rows[0].id])).rows);
  return rowToUser(rows[0], ov.get(rows[0].id));
}
const appUsers = {
  async list() {
    await ensureRbacTables();
    const users = (await pgPool.query(`SELECT * FROM app_users`)).rows;
    const ov = groupOverrides((await pgPool.query(`SELECT * FROM app_user_permission_overrides`)).rows);
    return users.map((u) => rowToUser(u, ov.get(u.id)));
  },
  get(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return Promise.resolve(null);
    return oneUser("id = $1", id);
  },
  getByAccountId(accountId) { return oneUser("jira_account_id = $1", accountId); },
  async insertIfNew(user) {
    await ensureRbacTables();
    const { rows } = await pgPool.query(
      `INSERT INTO app_users (id, jira_account_id, display_name, email, avatar_url, role_id, status, team_member_id, legacy_adopted, created_at, updated_at, last_login_at, status_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (jira_account_id) DO NOTHING RETURNING id`,
      [user.id, user.accountId, user.displayName || "", user.email || null, user.avatarUrl || null, user.roleId || null, user.status,
       user.teamMemberId || null, !!user.legacyAdopted, isoOrNow(user.createdAt), isoOrNow(user.updatedAt), user.lastLoginAt || null, user.statusChangedAt || null]
    );
    if (rows.length) {
      for (const [perm, o] of Object.entries(user.overrides || {})) {
        await pgPool.query(
          `INSERT INTO app_user_permission_overrides (user_id, permission, effect, expires_at, reason, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [user.id, perm, o.effect, o.expiresAt || null, o.reason || null, o.createdBy || null, isoOrNow(o.createdAt)]
        );
      }
      return { inserted: true, user };
    }
    return { inserted: false, user: await oneUser("jira_account_id = $1", user.accountId) };
  },
  async save(user) {
    await ensureRbacTables();
    await withTx(async (c) => {
      await c.query(
        `INSERT INTO app_users (id, jira_account_id, display_name, email, avatar_url, role_id, status, team_member_id, legacy_adopted, created_at, updated_at, last_login_at, status_changed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email, avatar_url = EXCLUDED.avatar_url,
           role_id = EXCLUDED.role_id, status = EXCLUDED.status, team_member_id = EXCLUDED.team_member_id,
           legacy_adopted = EXCLUDED.legacy_adopted, updated_at = EXCLUDED.updated_at, last_login_at = EXCLUDED.last_login_at,
           status_changed_at = EXCLUDED.status_changed_at`,
        [user.id, user.accountId, user.displayName || "", user.email || null, user.avatarUrl || null, user.roleId || null, user.status,
         user.teamMemberId || null, !!user.legacyAdopted, isoOrNow(user.createdAt), isoOrNow(user.updatedAt), user.lastLoginAt || null, user.statusChangedAt || null]
      );
      await c.query(`DELETE FROM app_user_permission_overrides WHERE user_id = $1`, [user.id]);
      for (const [perm, o] of Object.entries(user.overrides || {})) {
        await c.query(
          `INSERT INTO app_user_permission_overrides (user_id, permission, effect, expires_at, reason, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [user.id, perm, o.effect, o.expiresAt || null, o.reason || null, o.createdBy || null, isoOrNow(o.createdAt)]
        );
      }
    });
    return user;
  },
};

module.exports = { releases, regressionModules, auditLog, testData, testAccountRelationships, dailyReports, dailyAbsences, dailyReminders, appRoles, appUsers, team, atlassianTokens };
