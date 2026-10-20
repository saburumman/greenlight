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

module.exports = { releases, regressionModules, auditLog, testData, testAccountRelationships, team, atlassianTokens };
