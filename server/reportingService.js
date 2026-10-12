// Wiring for the Reporting sync: the shared Postgres store, one background
// sync at a time, settings validation, and the optional scheduler.
//
// Jira authorization is the app's existing per-user model (see
// reportingJira.js): a manual sync runs as the person who pressed the button;
// the scheduler runs as the person who switched "Sync automatically" on
// (their own stored Atlassian authorization — if it lapses, the automatic
// sync reports that they need to sign in again; it never borrows another
// user's token).

const pgPool = require("./db/pgPool");
const jiraClient = require("./jiraClient");
const { createReportingStore } = require("./reportingStore");
const { createJiraHttp } = require("./reportingJira");
const { runSync, SyncError } = require("./reportingSync");

const MAPPING_KEYS = ["service", "component", "squad"];
const SIMPLE_SOURCES = new Set(["none", "component", "label", "project"]);

function isAvailable() { return pgPool.isConfigured(); }

let store = null;
function getStore() {
  if (!store) store = createReportingStore(pgPool.getPool());
  return store;
}
let schemaPromise = null;
function ready() {
  if (!schemaPromise) schemaPromise = getStore().ensureSchema().catch((e) => { schemaPromise = null; throw e; });
  return schemaPromise;
}

// ---- settings validation (pure) ----
function cleanMapping(m, key) {
  if (m === undefined) return { value: undefined };
  if (!m || typeof m !== "object") return { error: key + " mapping is invalid." };
  const source = String(m.source || "none").trim();
  if (!SIMPLE_SOURCES.has(source) && !(source.indexOf("field:") === 0 && source.length > 6 && source.length <= 80)) {
    return { error: key + ': source must be one of none, component, label, project or "field:<Jira field name>".' };
  }
  const map = {};
  const src = m.map && typeof m.map === "object" && !Array.isArray(m.map) ? m.map : {};
  const keys = Object.keys(src);
  if (keys.length > 200) return { error: key + " mapping has too many entries (max 200)." };
  for (const k of keys) {
    const from = String(k).trim(), to = String(src[k] == null ? "" : src[k]).trim();
    if (!from || !to) continue;
    if (from.length > 120 || to.length > 120) return { error: key + " mapping values are too long." };
    map[from] = to;
  }
  return { value: { source, map, passthrough: m.passthrough !== false } };
}

// body = what the browser sent; current = stored settings. Returns {clean} (a
// patch of the user-editable parts) or {error}. The auto-sync owner is NEVER
// taken from the body: it's the caller, set only when auto goes off → on.
function validateSettings(body, authUser, current) {
  const b = body || {};
  const clean = {};
  if (b.scope !== undefined) {
    const jql = String((b.scope && b.scope.jql) || "").trim();
    if (jql.length > 2000) return { error: "The scope JQL is too long (max 2000 characters)." };
    clean.scope = { jql };
  }
  if (b.mappings !== undefined) {
    if (!b.mappings || typeof b.mappings !== "object") return { error: "mappings is invalid." };
    const out = { ...(current.mappings || {}) };
    for (const k of MAPPING_KEYS) {
      const r = cleanMapping(b.mappings[k], k);
      if (r.error) return { error: r.error };
      if (r.value !== undefined) out[k] = r.value;
    }
    clean.mappings = out;
  }
  if (b.blockedStatuses !== undefined) {
    const list = Array.isArray(b.blockedStatuses) ? b.blockedStatuses : String(b.blockedStatuses || "").split(",");
    const seen = new Set(); const out = [];
    for (const raw of list) {
      const v = String(raw == null ? "" : raw).trim();
      if (!v || seen.has(v.toLowerCase())) continue;
      if (v.length > 60) return { error: "A blocked status name is too long." };
      seen.add(v.toLowerCase()); out.push(v);
      if (out.length > 20) return { error: "Too many blocked statuses (max 20)." };
    }
    clean.blockedStatuses = out;
  }
  if (b.auto !== undefined) {
    const a = b.auto || {};
    const cur = current.auto || {};
    const auto = { ...cur };
    if (a.intervalMinutes !== undefined) {
      const n = Number(a.intervalMinutes);
      if (!Number.isInteger(n) || n < 30 || n > 10080) return { error: "The automatic sync interval must be between 30 minutes and 7 days." };
      auto.intervalMinutes = n;
    }
    if (a.enabled !== undefined) {
      if (typeof a.enabled !== "boolean") return { error: "auto.enabled must be true or false." };
      if (a.enabled && !cur.enabled) {
        if (!authUser || !authUser.accountId) return { error: "Sign in with Atlassian to turn on automatic sync." };
        auto.accountId = authUser.accountId; auto.accountName = authUser.name || "a team member";
      }
      if (!a.enabled) { auto.accountId = null; auto.accountName = null; }
      auto.enabled = a.enabled;
    }
    clean.auto = auto;
  }
  return { clean };
}

// ---- running a sync in the background (one at a time) ----
let current = null; // { mode, startedAt }
function isRunningHere() { return !!current; }

function memoAuth(accountId) {
  let memo = null;
  return async () => {
    if (memo && Date.now() - memo.at < 30000) return memo.v;
    const v = await jiraClient.resolveAuth({ accountId });
    memo = { v, at: Date.now() };
    return v;
  };
}

// Fire-and-forget. Config problems are checked up front by the caller;
// anything that goes wrong later is recorded on the sync run itself.
function launchSync({ accountId, mode, onDone }) {
  const s = getStore();
  current = { mode, startedAt: Date.now() };
  const http = createJiraHttp({ getAuth: memoAuth(accountId) });
  runSync({ store: s, http }, { mode })
    .then((res) => onDone && onDone(null, res))
    .catch((err) => { console.error("reporting sync failed:", err && err.message); onDone && onDone(err); })
    .finally(() => { current = null; });
}

// Pre-flight shared by the route and the scheduler.
async function preflight() {
  await ready();
  const s = getStore();
  const settings = await s.getSettings();
  if (!String((settings.scope && settings.scope.jql) || "").trim()) throw new SyncError("Set the sync scope (a JQL filter) in Reporting settings first.", "NO_SCOPE");
  await s.markStaleRuns(30 * 60 * 1000);
  if (current || (await s.getRunning())) throw new SyncError("A sync is already running.", "BUSY");
  return settings;
}

// ---- scheduler ----
let timer = null;
async function schedulerTick(nowMs, audit) {
  await ready();
  const s = getStore();
  const settings = await s.getSettings();
  const a = settings.auto || {};
  if (!a.enabled || !a.accountId || !(settings.scope && settings.scope.jql)) return "off";
  if (current) return "busy";
  const last = (await s.listRuns(1))[0];
  if (last && last.status === "running") return "busy";
  const lastStart = last ? new Date(last.started_at).getTime() : 0;
  if (nowMs - lastStart < (a.intervalMinutes || 360) * 60000) return "not-due";
  const st = settings.state || {};
  const mode = !st.lastFullAt || nowMs - Date.parse(st.lastFullAt) > 7 * 86400000 ? "full" : "incremental";
  try { await preflight(); } catch (e) { return "blocked"; }
  if (audit) await audit({ id: null, name: "Scheduled sync (" + (a.accountName || "team member") + ")" }, mode);
  launchSync({ accountId: a.accountId, mode });
  return "started";
}
function startScheduler(audit, everyMs) {
  if (!isAvailable() || timer) return;
  timer = setInterval(() => { schedulerTick(Date.now(), audit).catch((e) => console.error("reporting scheduler:", e.message)); }, everyMs || 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { isAvailable, getStore, ready, validateSettings, launchSync, preflight, isRunningHere, schedulerTick, startScheduler };
