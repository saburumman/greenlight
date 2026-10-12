// Reporting API (SANAD PMO Reporting Module — see REPORTING_SPEC.md).
//
// EVERY route in this file — and every route added in later phases (report
// data, Excel/CSV downloads) — sits behind requirePageAccess("reporting"),
// which re-reads the team on each request. Nothing in this module may be
// mounted outside this router.
//
// Phase 1: sync settings, sync status, start a sync.
// Phases 2-4: the report itself (JSON for the page), Excel / CSV downloads, the
// dependency tracker and saved report presets.

const express = require("express");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");
const { requirePageAccess } = require("../pageAccess");
const { resolveActor } = require("../assignmentLogic");
const { recordEvents } = require("../auditWriter");
const crypto = require("crypto");
const service = require("../reportingService");
const { SyncError } = require("../reportingSync");
const engine = require("../reportingEngine");
const exporter = require("../reportingExport");
const { validateDependency, validatePresetName, STATUSES } = require("../reportingDependencies");

const IN_APP_ROWS = 500; // rows of each long table shown on the page (downloads carry everything)
const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

const router = express.Router();
router.use(requirePageAccess("reporting"));

// The cache lives in Postgres only. Without DATABASE_URL the page still opens
// (so the access screen works) but data routes explain what is missing.
function needPostgres(req, res, next) {
  if (service.isAvailable()) return next();
  res.status(501).json({
    code: "NEEDS_POSTGRES",
    error: "Reporting keeps its data in the Postgres database. Set DATABASE_URL (Supabase) to use it.",
  });
}

async function actorFor(req) {
  return resolveActor(req.authUser, await db.team.list());
}

// What the browser may see of the settings (never the resume checkpoint etc.).
function publicSettings(s) {
  const st = s.state || {};
  return {
    scope: s.scope,
    mappings: s.mappings,
    blockedStatuses: s.blockedStatuses,
    auto: {
      enabled: !!(s.auto && s.auto.enabled),
      intervalMinutes: (s.auto && s.auto.intervalMinutes) || 360,
      ownerName: (s.auto && s.auto.accountName) || null,
    },
    lastSyncedAt: st.lastSyncedAt || null,
    lastFullAt: st.lastFullAt || null,
  };
}

function runView(r) {
  if (!r) return null;
  return {
    id: String(r.id),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    issues: r.issues_synced,
    worklogs: r.worklogs_synced,
    error: r.error || null,
  };
}

// GET /api/reporting/ping — proves the caller has access; the page calls it
// on open so a revoked user is switched to the no-access state at once.
router.get("/ping", (req, res) => {
  res.json({ ok: true, phase: 4, dataLayerReady: service.isAvailable() });
});

// GET /api/reporting/settings
router.get("/settings", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  res.json(publicSettings(await service.getStore().getSettings()));
}));

// PUT /api/reporting/settings — scope, mappings, blocked statuses, auto-sync.
router.put("/settings", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  const store = service.getStore();
  const current = await store.getSettings();
  const { clean, error } = service.validateSettings(req.body, req.authUser, current);
  if (error) return res.status(400).json({ error });
  const before = current.auto || {};
  const next = await store.saveSettings(clean);
  const actor = await actorFor(req);
  const bits = [];
  if (clean.scope) bits.push("scope");
  if (clean.mappings) bits.push("mappings");
  if (clean.blockedStatuses) bits.push("blocked statuses");
  if (clean.auto) {
    const was = !!before.enabled, now = !!(next.auto && next.auto.enabled);
    bits.push(was === now ? "automatic sync interval" : now ? "automatic sync turned on" : "automatic sync turned off");
  }
  await recordEvents(db, actor, [{
    action: "REPORT_SETTINGS_UPDATED",
    entityType: "reporting",
    entityId: "settings",
    details: "Updated Reporting sync settings: " + (bits.join(", ") || "no changes") + ".",
    meta: { page: "reporting" },
  }]);
  res.json(publicSettings(next));
}));

// GET /api/reporting/sync/status
router.get("/sync/status", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  const store = service.getStore();
  await store.markStaleRuns(30 * 60 * 1000);
  const [settings, runs, counts] = await Promise.all([store.getSettings(), store.listRuns(10), store.counts()]);
  const running = runs.find((r) => r.status === "running") || null;
  res.json({
    postgres: true,
    running: !!running,
    current: runView(running),
    lastRun: runView(runs[0]),
    runs: runs.map(runView),
    counts,
    scopeLimited: !!String((settings.scope && settings.scope.jql) || "").trim(),
    lastSyncedAt: (settings.state && settings.state.lastSyncedAt) || null,
    auto: publicSettings(settings).auto,
  });
}));

// POST /api/reporting/sync {mode: "incremental"|"full"} — starts a background
// sync under the CALLER's own Atlassian authorization and returns at once.
router.post("/sync", needPostgres, asyncHandler(async (req, res) => {
  const mode = req.body && req.body.mode === "full" ? "full" : "incremental";
  try {
    await service.preflight();
  } catch (e) {
    if (e instanceof SyncError) return res.status(e.code === "BUSY" ? 409 : 400).json({ code: e.code, error: e.message });
    throw e;
  }
  const actor = await actorFor(req);
  service.launchSync({
    accountId: req.authUser.accountId,
    mode,
    onDone: (err, result) => {
      recordEvents(db, actor, [{
        action: "REPORT_SYNC_RUN",
        entityType: "reporting",
        entityId: "sync",
        details: err
          ? "Reporting sync (" + mode + ") failed."
          : "Reporting sync (" + mode + ") finished: " + result.issues + " issues, " + result.worklogs + " worklogs.",
        meta: { page: "reporting" },
      }]).catch(() => {});
    },
  });
  res.status(202).json({ started: true, mode });
}));

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
async function buildFor(req, rawFilters) {
  await service.ready();
  const store = service.getStore();
  const [data, settings, actor] = await Promise.all([store.loadReportData(), store.getSettings(), actorFor(req)]);
  const report = engine.buildReport({
    ...data,
    sync: { lastSyncedAt: (settings.state && settings.state.lastSyncedAt) || null },
    filters: rawFilters,
    now: Date.now(),
    generatedBy: (actor && actor.name) || (req.authUser && req.authUser.displayName) || "",
    jiraSiteUrl: process.env.JIRA_SITE_URL || "",
  });
  return { report, data };
}

// GET /api/reporting/filters — the values the filter bar offers, plus presets.
router.get("/filters", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  const store = service.getStore();
  const [data, settings] = await Promise.all([store.loadReportData(), store.getSettings()]);
  res.json({
    options: engine.filterOptions(data.issues, data.worklogs),
    presets: settings.presets || [],
    cachedIssues: data.issues.length,
    lastSyncedAt: (settings.state && settings.state.lastSyncedAt) || null,
    timezone: engine.TZ,
  });
}));

// POST /api/reporting/report {filters} — every sheet and chart as JSON.
router.post("/report", needPostgres, asyncHandler(async (req, res) => {
  const { report } = await buildFor(req, req.body && req.body.filters);
  res.set("Cache-Control", "no-store");
  res.json(engine.capRows(report, IN_APP_ROWS, 50));
}));

function filterSummary(report) {
  return report.meta.filters.length ? report.meta.filters.join("; ") : "no filters";
}

// POST /api/reporting/export/xlsx {filters} — the whole workbook.
router.post("/export/xlsx", needPostgres, asyncHandler(async (req, res) => {
  const { report } = await buildFor(req, req.body && req.body.filters);
  const buf = await exporter.buildWorkbook(report);
  const actor = await actorFor(req);
  await recordEvents(db, actor, [{
    action: "REPORT_EXPORTED", entityType: "reporting", entityId: "xlsx",
    details: "Exported the Excel workbook (" + report.meta.issueCount + " tickets; " + filterSummary(report) + ").",
    meta: { page: "reporting" },
  }]);
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": 'attachment; filename="' + exporter.xlsxFileName(report) + '"',
    "Cache-Control": "no-store",
  });
  res.send(buf);
}));

// POST /api/reporting/export/csv {filters, sheet} — one sheet as CSV (UTF-8 with BOM).
router.post("/export/csv", needPostgres, asyncHandler(async (req, res) => {
  const { report } = await buildFor(req, req.body && req.body.filters);
  const sheet = report.sheets.find((s) => s.id === (req.body && req.body.sheet));
  if (!sheet) return res.status(400).json({ error: "Unknown sheet." });
  const csv = exporter.buildCsv(report, sheet.id);
  const actor = await actorFor(req);
  await recordEvents(db, actor, [{
    action: "REPORT_EXPORTED", entityType: "reporting", entityId: "csv:" + sheet.id,
    details: "Exported the " + sheet.name + " sheet as CSV (" + report.meta.issueCount + " tickets; " + filterSummary(report) + ").",
    meta: { page: "reporting" },
  }]);
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="' + exporter.csvFileName(report, sheet) + '"',
    "Cache-Control": "no-store",
  });
  res.send(csv);
}));

// ---------------------------------------------------------------------------
// Dependency tracker
// ---------------------------------------------------------------------------
function depId(req, res) {
  const id = String(req.params.id || "");
  if (!/^\d{1,15}$/.test(id)) { res.status(400).json({ error: "Invalid dependency id." }); return null; }
  return id;
}

router.get("/dependencies", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  res.json({ statuses: STATUSES, dependencies: await service.getStore().listDependencies() });
}));

router.post("/dependencies", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  const { clean, error } = validateDependency(req.body, false);
  if (error) return res.status(400).json({ error });
  const actor = await actorFor(req);
  const id = await service.getStore().createDependency(clean, actor && actor.name);
  await recordEvents(db, actor, [{ action: "REPORT_DEPENDENCY_CHANGED", entityType: "reporting", entityId: "dependency:" + id, details: "Added dependency: " + clean.entity + (clean.vendor ? " / " + clean.vendor : "") + ".", meta: { page: "reporting" } }]);
  res.status(201).json({ id });
}));

router.put("/dependencies/:id", needPostgres, asyncHandler(async (req, res) => {
  const id = depId(req, res); if (id === null) return;
  await service.ready();
  const { clean, error } = validateDependency(req.body, true);
  if (error) return res.status(400).json({ error });
  const store = service.getStore();
  if (!(await store.updateDependency(id, clean))) return res.status(404).json({ error: "That dependency no longer exists." });
  const actor = await actorFor(req);
  await recordEvents(db, actor, [{ action: "REPORT_DEPENDENCY_CHANGED", entityType: "reporting", entityId: "dependency:" + id, details: "Updated dependency #" + id + (clean.status ? " (status: " + clean.status + ")" : "") + ".", meta: { page: "reporting" } }]);
  res.json({ ok: true });
}));

router.delete("/dependencies/:id", needPostgres, asyncHandler(async (req, res) => {
  const id = depId(req, res); if (id === null) return;
  await service.ready();
  if (!(await service.getStore().deleteDependency(id))) return res.status(404).json({ error: "That dependency no longer exists." });
  const actor = await actorFor(req);
  await recordEvents(db, actor, [{ action: "REPORT_DEPENDENCY_CHANGED", entityType: "reporting", entityId: "dependency:" + id, details: "Removed dependency #" + id + " (linked tickets were unlinked).", meta: { page: "reporting" } }]);
  res.json({ ok: true });
}));

// GET /api/reporting/issues/search?q= — find cached tickets to link.
router.get("/issues/search", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  res.json({ issues: await service.getStore().searchIssues(String(req.query.q || "").slice(0, 100), 15) });
}));

// PUT /api/reporting/issues/:key/dependency {dependencyId|null} — link / unlink a ticket.
router.put("/issues/:key/dependency", needPostgres, asyncHandler(async (req, res) => {
  const key = String(req.params.key || "");
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "Invalid issue key." });
  await service.ready();
  const store = service.getStore();
  const raw = req.body && req.body.dependencyId;
  const dep = raw === null || raw === undefined || raw === "" ? null : String(raw);
  if (dep !== null) {
    if (!/^\d{1,15}$/.test(dep)) return res.status(400).json({ error: "Invalid dependency id." });
    if (!(await store.dependencyExists(dep))) return res.status(404).json({ error: "That dependency no longer exists." });
  }
  if (!(await store.setIssueDependency(key, dep))) return res.status(404).json({ error: key + " is not in the synced data." });
  const actor = await actorFor(req);
  await recordEvents(db, actor, [{ action: "REPORT_DEPENDENCY_CHANGED", entityType: "reporting", entityId: "dependency:" + (dep || "none"), details: (dep ? "Linked " : "Unlinked ") + key + (dep ? " to dependency #" + dep : " from its dependency") + ".", meta: { page: "reporting", ticketKey: key } }]);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Saved report presets (shared by everyone who holds Reporting access)
// ---------------------------------------------------------------------------
router.get("/presets", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  res.json({ presets: await service.getStore().listPresets() });
}));

router.post("/presets", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  const n = validatePresetName(req.body && req.body.name);
  if (n.error) return res.status(400).json({ error: n.error });
  const actor = await actorFor(req);
  const preset = { id: crypto.randomUUID(), name: n.name, filters: engine.normalizeFilters(req.body && req.body.filters), createdBy: (actor && actor.name) || "", createdAt: new Date().toISOString() };
  try {
    res.status(201).json({ presets: await service.getStore().savePreset(preset), preset });
  } catch (e) {
    if (e && e.code === "LIMIT") return res.status(400).json({ error: e.message });
    throw e;
  }
}));

router.delete("/presets/:id", needPostgres, asyncHandler(async (req, res) => {
  await service.ready();
  const list = await service.getStore().deletePreset(String(req.params.id || ""));
  if (!list) return res.status(404).json({ error: "That preset no longer exists." });
  res.json({ presets: list });
}));

module.exports = router;
