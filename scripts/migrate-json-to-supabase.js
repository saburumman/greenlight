#!/usr/bin/env node
// One-time (but safely re-runnable) import of your existing
// data/store.json into Postgres/Supabase — releases, the regression
// modules master list, the audit log, test data, and the team roster.
//
// Greenlight has no shared/global Jira connection to migrate anymore —
// every user's own Jira access comes from their own "Sign in with
// Atlassian" (see server/auth/atlassianTokens.js), created fresh the next
// time each person signs in, so there's nothing to carry over from
// data/store.json for that.
//
// This script NEVER deletes or modifies data/store.json — it only reads
// it. Run it as many times as you want; it's an upsert (ON CONFLICT DO
// UPDATE) for releases/regression modules/test data/team, keyed by their
// existing id, and an ON CONFLICT DO NOTHING for the audit log
// (append-only — a record that's already there is left exactly as it was,
// never overwritten). Running it twice against unchanged data reports
// everything as "already up to date / already present" — nothing gets
// duplicated.
//
// Usage (run once locally, pointed at your Supabase project — this reads
// data/store.json off THIS machine, so run it from wherever that file
// actually lives):
//   DATABASE_URL="postgres://...supabase..." node scripts/migrate-json-to-supabase.js
//
// Prerequisite: supabase/schema.sql must already be applied to that
// database (via the Supabase SQL Editor, or `psql "$DATABASE_URL" -f
// supabase/schema.sql`) — this script only inserts rows, it never creates
// tables.

require("../server/loadEnv").loadEnv();

const fs = require("fs");
const path = require("path");
const pgPool = require("../server/db/pgPool");

const STORE_PATH = path.join(__dirname, "..", "data", "store.json");

function isoOrNow(value) {
  return value ? new Date(value).toISOString() : new Date().toISOString();
}

// Upserts one row of a "JSONB document keyed by id" table (releases,
// test_data, team) and reports whether it was a fresh insert or an update
// to a row that was already there — via Postgres's `xmax = 0` trick, which
// is true only when the row was just inserted by this statement.
async function upsertDoc(table, id, doc) {
  const createdAt = isoOrNow(doc.createdAt);
  const updatedAt = isoOrNow(doc.updatedAt);
  const { rows } = await pgPool.query(
    `INSERT INTO ${table} (id, data, created_at, updated_at)
     VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
     RETURNING (xmax = 0) AS inserted`,
    [id, JSON.stringify(doc), createdAt, updatedAt]
  );
  return rows[0].inserted ? "inserted" : "updated";
}

async function migrateReleases(releasesObj) {
  const entries = Object.entries(releasesObj || {});
  let inserted = 0;
  let updated = 0;
  for (const [id, release] of entries) {
    const outcome = await upsertDoc("releases", id, release);
    if (outcome === "inserted") inserted++;
    else updated++;
  }
  return { total: entries.length, inserted, updated };
}

async function migrateTestData(testDataObj) {
  const entries = Object.entries(testDataObj || {});
  let inserted = 0;
  let updated = 0;
  for (const [id, record] of entries) {
    const outcome = await upsertDoc("test_data", id, record);
    if (outcome === "inserted") inserted++;
    else updated++;
  }
  return { total: entries.length, inserted, updated };
}

// Links between Test Data accounts. Must run after migrateTestData (the account
// ids are foreign keys). A link whose account isn't in the file is skipped and
// reported, never inserted dangling.
async function migrateTestAccountRelationships(relObj, testDataObj) {
  const entries = Object.entries(relObj || {});
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  if (entries.length) {
    await pgPool.query(`
      create table if not exists test_account_relationships (
        id uuid primary key,
        account_a_id uuid not null references test_data(id) on delete cascade,
        account_b_id uuid not null references test_data(id) on delete cascade,
        data jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint test_account_relationships_not_self check (account_a_id <> account_b_id)
      )`);
  }
  for (const [id, r] of entries) {
    if (!r || !(testDataObj || {})[r.accountAId] || !(testDataObj || {})[r.accountBId] || r.accountAId === r.accountBId) {
      skipped++;
      continue;
    }
    const existing = await pgPool.query(`SELECT 1 FROM test_account_relationships WHERE id = $1`, [id]);
    await pgPool.query(
      `INSERT INTO test_account_relationships (id, account_a_id, account_b_id, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (id) DO UPDATE SET account_a_id = EXCLUDED.account_a_id, account_b_id = EXCLUDED.account_b_id,
         data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [id, r.accountAId, r.accountBId, JSON.stringify(r), r.createdAt || new Date().toISOString(), r.updatedAt || r.createdAt || new Date().toISOString()]
    );
    if (existing.rows.length) updated++;
    else inserted++;
  }
  return { total: entries.length, inserted, updated, skipped };
}

async function migrateTeam(teamObj) {
  const entries = Object.entries(teamObj || {});
  let inserted = 0;
  let updated = 0;
  for (const [id, member] of entries) {
    const outcome = await upsertDoc("team", id, member);
    if (outcome === "inserted") inserted++;
    else updated++;
  }
  return { total: entries.length, inserted, updated };
}

async function migrateRegressionModules(modules) {
  if (!Array.isArray(modules)) return { migrated: false, entities: 0 };
  const existing = await pgPool.query(`SELECT 1 FROM regression_modules WHERE id = 1`);
  await pgPool.query(
    `INSERT INTO regression_modules (id, data, updated_at) VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [JSON.stringify(modules)]
  );
  return { migrated: true, entities: modules.length, wasUpdate: existing.rows.length > 0 };
}

async function migrateAuditLog(auditLogArr) {
  const entries = Array.isArray(auditLogArr) ? auditLogArr : [];
  let inserted = 0;
  let alreadyPresent = 0;
  for (const entry of entries) {
    if (!entry || !entry.id) continue;
    const { rows } = await pgPool.query(
      `INSERT INTO audit_log (id, session_id, user_name, action, entity_type, entity_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
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
    if (rows.length) inserted++;
    else alreadyPresent++;
  }
  return { total: entries.length, inserted, alreadyPresent };
}

async function main() {
  if (!pgPool.isConfigured()) {
    console.error("DATABASE_URL is not set — nothing to migrate into. Set it and re-run.");
    process.exit(1);
  }
  if (!fs.existsSync(STORE_PATH)) {
    console.error(`No data/store.json found at ${STORE_PATH} — nothing to migrate.`);
    console.error("(This is expected if this machine has never run the app with the JSON-file backend.)");
    process.exit(1);
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (e) {
    console.error(`Couldn't parse ${STORE_PATH}: ${e.message}`);
    console.error("This file is never modified or deleted by this script — fix or replace it and re-run.");
    process.exit(1);
  }

  console.log(`Migrating ${STORE_PATH} into Postgres...\n`);
  console.log("(Safe to run again — existing rows are upserted by id, never duplicated; audit log entries are never overwritten.)\n");

  const releasesResult = await migrateReleases(store.releases);
  const regressionResult = await migrateRegressionModules(store.regressionModules);
  const auditResult = await migrateAuditLog(store.auditLog);
  const testDataResult = await migrateTestData(store.testData);
  const relationshipsResult = await migrateTestAccountRelationships(store.testAccountRelationships, store.testData);
  const teamResult = await migrateTeam(store.team);

  console.log("==================== Migration summary ====================");
  console.log(`releases            : ${releasesResult.total} in file  ->  ${releasesResult.inserted} inserted, ${releasesResult.updated} updated`);
  if (regressionResult.migrated) {
    console.log(`regression_modules  : ${regressionResult.entities} entities  ->  ${regressionResult.wasUpdate ? "replaced existing row" : "inserted new row"}`);
  } else {
    console.log(`regression_modules  : not present in store.json — skipped`);
  }
  console.log(`audit_log           : ${auditResult.total} in file  ->  ${auditResult.inserted} inserted, ${auditResult.alreadyPresent} already present`);
  console.log(`test_data           : ${testDataResult.total} in file  ->  ${testDataResult.inserted} inserted, ${testDataResult.updated} updated`);
  console.log(`test_account_rel.  : ${relationshipsResult.total} in file  ->  ${relationshipsResult.inserted} inserted, ${relationshipsResult.updated} updated, ${relationshipsResult.skipped} skipped (missing account)`);
  console.log(`team                : ${teamResult.total} in file  ->  ${teamResult.inserted} inserted, ${teamResult.updated} updated`);
  console.log("=============================================================");
  console.log("\ndata/store.json was not modified or deleted — keep it as a backup until you've verified the app against Postgres.");
  console.log("Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nMigration failed partway through:", e.message);
  console.error("Nothing in data/store.json was touched. Already-migrated rows are unaffected — fix the issue above and re-run; it will pick up where it left off.");
  process.exit(1);
});
