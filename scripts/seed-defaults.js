#!/usr/bin/env node
// Seeds the starter Regression Module master list and the starter "Know
// the Team" roster into Postgres — the exact same starter data
// server/db/jsonStore.js has always auto-created the first time
// data/store.json didn't exist yet.
//
// This is a separate, manual, explicit step (never run automatically by
// the server on startup) precisely because starting the server must never
// recreate or overwrite real production data — see server/db/pgStore.js's
// comment for why regressionModules.list()/team.list() just return []
// against an empty table instead of auto-seeding like the JSON-file
// backend does.
//
// Safe to run more than once: it only ever inserts when the corresponding
// table is still completely empty, and never touches a table that already
// has a row — whether that row came from this script or from a real
// migration (scripts/migrate-json-to-supabase.js). If your data/store.json
// already had real (or even just previously-seeded) regressionModules/team
// data, the migration script brings that across and this script becomes a
// no-op for both tables — which is exactly the point: it never clobbers
// what's already there.
//
// Usage:
//   DATABASE_URL="postgres://..." node scripts/seed-defaults.js

require("../server/loadEnv").loadEnv();

const { DEFAULT_REGRESSION_MODULES, buildDefaultTeam } = require("../server/db/jsonStore");
const pgPool = require("../server/db/pgPool");

async function main() {
  if (!pgPool.isConfigured()) {
    console.error("DATABASE_URL is not set — nothing to seed. Set it and re-run.");
    process.exit(1);
  }

  console.log("Seeding default data into Postgres (only into tables that are still empty)...\n");

  // ---- Regression modules (singleton row, id = 1) ----------------------
  const existingModules = await pgPool.query(`SELECT 1 FROM regression_modules WHERE id = 1`);
  if (existingModules.rows.length) {
    console.log("  regression_modules: already has data — left untouched.");
  } else {
    await pgPool.query(
      `INSERT INTO regression_modules (id, data, updated_at) VALUES (1, $1::jsonb, now())`,
      [JSON.stringify(DEFAULT_REGRESSION_MODULES)]
    );
    console.log(`  regression_modules: seeded ${DEFAULT_REGRESSION_MODULES.length} starter entities.`);
  }

  // ---- Team (per-row table — "empty" means zero rows) -------------------
  const existingTeam = await pgPool.query(`SELECT count(*)::int AS n FROM team`);
  if (existingTeam.rows[0].n > 0) {
    console.log(`  team: already has ${existingTeam.rows[0].n} member(s) — left untouched.`);
  } else {
    const starterTeam = Object.values(buildDefaultTeam());
    for (const member of starterTeam) {
      await pgPool.query(
        `INSERT INTO team (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [member.id, JSON.stringify(member), member.createdAt, member.updatedAt]
      );
    }
    console.log(`  team: seeded ${starterTeam.length} starter member(s).`);
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nSeeding failed:", e.message);
  process.exit(1);
});
