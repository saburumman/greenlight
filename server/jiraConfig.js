// Your Jira connection details (base URL, auth type, API token). This is
// deliberately separate from server/db.js's collections — it's connection
// config, not app data — but it has the exact same "where does this
// actually persist" problem: without DATABASE_URL it's a local file
// (data/jira-config.json, on THIS machine only), and with DATABASE_URL it's
// a single row in Postgres. That matters for Render specifically: Render's
// filesystem is ephemeral, so a file-only version of this would silently
// lose your Jira connection on every deploy/restart — same class of data
// loss the release/test-data/team migration exists to avoid. So this file
// picks a backend the same way server/db.js does.
//
// The API token never goes back to the browser either way — routes/jira.js
// only ever returns whether a connection is configured, plus non-secret
// fields (base URL, account name); see publicView() below.

const fs = require("fs");
const path = require("path");
const pgPool = require("./db/pgPool");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(DATA_DIR, "jira-config.json");

// ---- JSON-file backend (no DATABASE_URL) -------------------------------

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function loadFromFile() {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    return null;
  }
}

async function saveToFile(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

async function clearFromFile() {
  ensureDir();
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
}

// ---- Postgres backend (DATABASE_URL set) -------------------------------
// Single-row table, same "one JSONB blob" pattern as regression_modules in
// server/db/pgStore.js — see supabase/schema.sql for the DDL.

async function loadFromDb() {
  const { rows } = await pgPool.query(`SELECT data FROM jira_config WHERE id = 1`);
  return rows.length ? rows[0].data : null;
}

async function saveToDb(config) {
  await pgPool.query(
    `INSERT INTO jira_config (id, data, updated_at)
     VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [JSON.stringify(config)]
  );
}

async function clearFromDb() {
  await pgPool.query(`DELETE FROM jira_config WHERE id = 1`);
}

// ---- Public interface — identical either way ---------------------------

/**
 * config: {
 *   baseUrl: "https://yourcompany.atlassian.net",
 *   authType: "cloud" | "token",   // cloud = email + API token (Basic auth); token = PAT (Bearer), for Server/Data Center
 *   email: "you@company.com",       // required for authType "cloud"
 *   apiToken: "...",
 *   apiVersion: "3" | "2"           // Jira REST API version; Cloud is 3, many Server/DC instances are 2
 * }
 */
async function load() {
  return pgPool.isConfigured() ? loadFromDb() : loadFromFile();
}

async function save(config) {
  return pgPool.isConfigured() ? saveToDb(config) : saveToFile(config);
}

async function clear() {
  return pgPool.isConfigured() ? clearFromDb() : clearFromFile();
}

// Never expose the token — this is what's safe to send to the browser.
async function publicView() {
  const cfg = await load();
  if (!cfg) return { configured: false };
  return {
    configured: true,
    baseUrl: cfg.baseUrl,
    authType: cfg.authType,
    email: cfg.authType === "cloud" ? cfg.email : undefined,
  };
}

module.exports = { load, save, clear, publicView };
