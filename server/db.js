// Persistence backend selector — this is the one seam the whole app talks
// to (`const db = require("../db")` in every route file), and the only
// place that knows two backends exist:
//
//   - DATABASE_URL set      -> server/db/pgStore.js  (Postgres / Supabase)
//   - DATABASE_URL not set  -> server/db/jsonStore.js (local data/store.json)
//
// Both backends export the identical interface — releases/regressionModules/
// auditLog/testData/team, each with the same list/get/set/delete/append
// methods, all async — so no route needs to know or care which one is
// active. This keeps local development (`npm start`, no .env DATABASE_URL)
// working exactly as it always has, with zero setup, while production on
// Render points DATABASE_URL at Supabase.
const backend = process.env.DATABASE_URL ? require("./db/pgStore") : require("./db/jsonStore");

module.exports = backend;
