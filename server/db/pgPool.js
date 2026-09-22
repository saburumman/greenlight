// Single shared `pg` connection pool, used by server/db/pgStore.js
// (releases/regressionModules/auditLog/testData/team/atlassianTokens)
// whenever DATABASE_URL is set — see server/db.js for how the JSON-file vs.
// Postgres backend is chosen.
//
// Kept deliberately tiny: one pool, one ssl rule, one query helper. No ORM,
// no query builder — the rest of this app's near-zero-dependency style.

const { Pool } = require("pg");

function isConfigured() {
  return !!process.env.DATABASE_URL;
}

let pool = null;

// Supabase's pooled connection strings require TLS, and the certificate
// chain isn't always in Node's default trust store, so this follows the
// common Supabase/Node guidance of connecting with `rejectUnauthorized:
// false` (still encrypted in transit, just not verifying the CA chain) —
// the practical, "don't fight your own DB connection" default. Set
// DATABASE_SSL=disable for a local/self-hosted Postgres with no TLS at all
// (e.g. testing against `psql` on localhost).
function sslConfig() {
  if (process.env.DATABASE_SSL === "disable") return false;
  return { rejectUnauthorized: false };
}

function getPool() {
  if (!isConfigured()) {
    throw new Error("DATABASE_URL is not set — getPool() should only be called when the Postgres backend is selected.");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig(),
    });
    // A background connection error (e.g. the DB briefly drops) must not
    // crash the whole process — pg's Pool emits 'error' on idle clients and
    // the default Node behavior for an unhandled EventEmitter error is to
    // throw. Individual queries still fail/reject normally and are handled
    // by each route's own error handling (see server/asyncHandler.js).
    pool.on("error", (err) => {
      console.error("Unexpected error on idle Postgres client:", err.message);
    });
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { isConfigured, getPool, query };
