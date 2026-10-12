// The Reporting sync (REPORTING_SPEC.md §2): Jira → Postgres cache.
// Read-only against Jira. Dependencies (store, http) are injected so the whole
// flow can be tested without Jira or a network.
//
//  full         every issue the scope JQL returns (no scope = every issue the
//               signed-in user can read); afterwards anything the
//               scope no longer returns is removed.
//  incremental  only issues updated since the last good sync (with a safety
//               overlap); each re-fetched issue gets its worklogs and status
//               history rebuilt, so edited/deleted worklogs are picked up.
//               (Jira's own `updated` moves on every worklog change.)
//
// Resumable: after every page a checkpoint (the search cursor + counters) is
// saved; a sync that died mid-way continues from it if it is recent and the
// scope hasn't changed.

const logic = require("./reportingLogic");
const jira = require("./reportingJira");

class SyncError extends Error {
  constructor(message, code) { super(message); this.name = "SyncError"; this.code = code || "SYNC_FAILED"; }
}

const STALE_RUN_MS = 30 * 60 * 1000;
const RESUME_MAX_AGE_MS = 20 * 60 * 1000;
const INCREMENTAL_OVERLAP_MS = 26 * 3600 * 1000; // covers any Jira user time-zone offset

const BASE_FIELDS = [
  "summary", "issuetype", "parent", "status", "assignee", "reporter", "priority", "labels", "components",
  "fixVersions", "created", "duedate", "resolutiondate", "timeoriginalestimate", "timeestimate", "timespent",
  "worklog", "project",
];

// With no scope set the sync covers every issue the signed-in user can read.
// Jira's search refuses a query with no restriction at all, so this harmless
// always-true date clause stands in for "everything".
const ALL_ISSUES_JQL = 'created >= "1990-01-01"';

function stripOrderBy(jql) { return String(jql || "").replace(/\s+order\s+by\s+[\s\S]*$/i, "").trim(); }

function jqlTimestamp(ms) { // "yyyy-MM-dd HH:mm" (UTC reading; the overlap absorbs tz offsets)
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}

function buildJql(scope, mode, lastSyncedAt) {
  const base = stripOrderBy(scope);
  if (mode === "incremental" && lastSyncedAt) {
    return "(" + base + ') AND updated >= "' + jqlTimestamp(Date.parse(lastSyncedAt) - INCREMENTAL_OVERLAP_MS) + '" ORDER BY key ASC';
  }
  return "(" + base + ") ORDER BY key ASC";
}

// Jira field name → id for the few custom fields the cache needs.
function resolveFieldIds(fieldList, settings) {
  const byName = new Map();
  for (const f of fieldList || []) if (f && f.name) byName.set(String(f.name).trim().toLowerCase(), f.id);
  const customFieldIds = {};
  for (const key of ["service", "component", "squad"]) {
    const src = settings.mappings && settings.mappings[key] && settings.mappings[key].source;
    if (src && src.indexOf("field:") === 0) {
      const nm = src.slice(6).trim().toLowerCase();
      if (byName.has(nm)) customFieldIds[nm] = byName.get(nm);
    }
  }
  return {
    fieldIds: { sprint: byName.get("sprint") || null, epicLink: byName.get("epic link") || null, flagged: byName.get("flagged") || null },
    customFieldIds,
  };
}

// opts: { mode, now?:()=>Date, onProgress?:(info)=>void }
async function runSync(deps, opts) {
  const { store, http } = deps;
  const now = (opts && opts.now) || (() => new Date());
  const onProgress = (opts && opts.onProgress) || (() => {});
  const requested = (opts && opts.mode) === "full" ? "full" : "incremental";

  const settings = await store.getSettings();
  const scope = stripOrderBy(String((settings.scope && settings.scope.jql) || "")) || ALL_ISSUES_JQL;

  await store.markStaleRuns(STALE_RUN_MS);
  if (await store.getRunning()) throw new SyncError("A sync is already running.", "BUSY");

  const state = settings.state || {};
  const mode = requested === "incremental" && !state.lastSyncedAt ? "full" : requested;
  const jql = buildJql(scope, mode, state.lastSyncedAt);
  const startedAt = now();

  let startToken = null;
  let counters = { issues: 0, worklogs: 0 };
  let resumed = false;
  const rs = state.resume;
  if (rs && rs.nextPageToken && rs.mode === mode && rs.jql === jql && startedAt.getTime() - Date.parse(rs.at) < RESUME_MAX_AGE_MS) {
    startToken = rs.nextPageToken; counters = { issues: rs.issues || 0, worklogs: rs.worklogs || 0 }; resumed = true;
  }

  const runId = await store.startRun(startedAt.toISOString());
  try {
    const [fieldList, statusList] = await Promise.all([http.request("/field"), http.request("/status")]);
    const statusIndex = logic.buildStatusIndex(statusList);
    const { fieldIds, customFieldIds } = resolveFieldIds(fieldList, settings);
    const ctx = { statusIndex, fieldIds, customFieldIds, settings, now: startedAt.toISOString() };
    const fields = BASE_FIELDS.slice();
    for (const id of [fieldIds.sprint, fieldIds.epicLink, fieldIds.flagged].concat(Object.values(customFieldIds))) if (id && fields.indexOf(id) < 0) fields.push(id);

    const seen = new Set();
    await jira.searchJql(http, {
      jql, fields, expand: "changelog", pageSize: 100, startToken,
      onPage: async (issues, nextToken) => {
        const items = [];
        for (const raw of issues) {
          seen.add(raw.key);
          // The search response may carry only part of the history / worklogs.
          const cl = raw.changelog;
          if (cl && cl.total != null && (cl.histories || []).length < cl.total) cl.histories = await jira.fetchAllChangelog(http, raw.key);
          const wl = raw.fields && raw.fields.worklog;
          let worklogRaw = (wl && wl.worklogs) || [];
          if (wl && wl.total != null && worklogRaw.length < wl.total) worklogRaw = await jira.fetchAllWorklogs(http, raw.key);
          const { row, transitions } = logic.deriveIssue(raw, ctx);
          items.push({ row, transitions, worklogs: logic.deriveWorklogs(raw.key, worklogRaw) });
        }
        if (items.length) await store.saveIssueBatch(items);
        counters.issues += items.length;
        counters.worklogs += items.reduce((n, i) => n + i.worklogs.length, 0);
        await store.updateRun(runId, counters);
        await store.saveState({ resume: nextToken ? { runId, mode, jql, nextPageToken: nextToken, issues: counters.issues, worklogs: counters.worklogs, at: now().toISOString() } : null });
        onProgress({ runId, mode, issues: counters.issues, worklogs: counters.worklogs });
      },
    });

    let removed = 0;
    // Reconcile removals only on an uninterrupted full pass (a resumed pass
    // didn't see the earlier pages' keys).
    if (mode === "full" && !resumed) removed = await store.deleteIssuesNotIn(seen);
    await store.postProcessEpics();
    const missing = await store.epicKeysMissingName();
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      const names = {};
      await jira.searchJql(http, {
        jql: "key in (" + chunk.map((k) => JSON.stringify(k)).join(",") + ")", fields: ["summary"], pageSize: 100,
        onPage: async (issues) => { for (const e of issues) names[e.key] = (e.fields && e.fields.summary) || ""; },
      });
      await store.setEpicNames(names);
    }

    await store.finishRun(runId, "success", null, counters);
    const patch = { lastSyncedAt: startedAt.toISOString(), resume: null };
    if (mode === "full") patch.lastFullAt = startedAt.toISOString();
    await store.saveState(patch);
    return { runId, status: "success", mode, resumed, removed, issues: counters.issues, worklogs: counters.worklogs };
  } catch (e) {
    await store.finishRun(runId, "failed", e && e.message ? e.message : String(e), counters);
    throw e;
  }
}

module.exports = { runSync, SyncError, ALL_ISSUES_JQL, buildJql, stripOrderBy, jqlTimestamp, resolveFieldIds, BASE_FIELDS };
