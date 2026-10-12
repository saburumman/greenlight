// Reporting API (SANAD PMO Reporting Module — see REPORTING_SPEC.md).
//
// EVERY route in this file — and every route added in later phases (report
// data, Excel/CSV downloads) — sits behind requirePageAccess("reporting"),
// which re-reads the team on each request. Nothing in this module may be
// mounted outside this router.
//
// Phase 1: the data layer only — sync settings, sync status, start a sync.
// The reports themselves (sheets, charts, downloads) come in later phases.

const express = require("express");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");
const { requirePageAccess } = require("../pageAccess");
const { resolveActor } = require("../assignmentLogic");
const { recordEvents } = require("../auditWriter");
const service = require("../reportingService");
const { SyncError } = require("../reportingSync");

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
  res.json({ ok: true, phase: 1, dataLayerReady: service.isAvailable() });
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

module.exports = router;
