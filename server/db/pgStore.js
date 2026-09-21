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
const auditLog = {
  async list() {
    const { rows } = await pgPool.query(
      `SELECT id, session_id, user_name, action, entity_type, entity_id, details, created_at
       FROM audit_log ORDER BY created_at DESC`
    );
    return rows.map(rowToAuditEntry);
  },
  async append(entry) {
    const { rows } = await pgPool.query(
      `INSERT INTO audit_log (id, session_id, user_name, action, entity_type, entity_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, session_id, user_name, action, entity_type, entity_id, details, created_at`,
      [
        entry.id,
        entry.sessionId || null,
        entry.userName || "Unknown",
        entry.action,
        entry.entityType || "",
        entry.entityId || "",
        entry.details || "",
        isoOrNow(entry.createdAt),
      ]
    );
    if (rows.length) return rowToAuditEntry(rows[0]);
    // Idempotency guard, same contract as jsonStore: a retried request with
    // the same id returns the record that's already there instead of
    // duplicating (or erroring on the primary-key conflict).
    const existing = await pgPool.query(`SELECT id, session_id, user_name, action, entity_type, entity_id, details, created_at FROM audit_log WHERE id = $1`, [entry.id]);
    return existing.rows.length ? rowToAuditEntry(existing.rows[0]) : entry;
  },
};

function rowToAuditEntry(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    userName: row.user_name,
    action: row.action,
    entityType: row.entity_type || "",
    entityId: row.entity_id || "",
    details: row.details || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

module.exports = { releases, regressionModules, auditLog, testData, team };
