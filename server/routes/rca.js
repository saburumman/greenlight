// RCA (Root Cause Analysis) API.
//
//   GET    /api/rca            the analyses (?release=<id>&status=&q=<words>&sort=newest|oldest&page=&pageSize=),
//                              plus `releases` — every release in Release Monitor, for the dropdown/filter
//   POST   /api/rca            add one         { releaseId, issue, cause, correctiveAction, preventiveAction, status? }
//   PUT    /api/rca/:id        edit one        (same body)
//   DELETE /api/rca/:id        delete one
//
// Permissions (permissions.js): rca.view / rca.create / rca.edit / rca.delete.
// Who wrote or changed an RCA always comes from the verified session (resolved to a
// Know the Team member when linked) — never from the request body. Changes are
// written to the Audit Log by the server; the audit text names the release but
// never contains the RCA's own text.

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const logic = require("../rcaLogic");
const { asyncHandler } = require("../asyncHandler");
const { requirePermission } = require("../accessControl");
const { recordEvents } = require("../auditWriter");
const { resolveActor } = require("../assignmentLogic");

const router = express.Router();
const MAX_PAGE_SIZE = 100;

function notFound(res) {
  return res.status(404).json({ error: "RCA not found." });
}

async function releaseIndex() {
  const releases = await db.releases.list(); // newest first
  return { list: releases, byId: new Map(releases.map((r) => [r._id, r])) };
}

router.get("/", requirePermission("rca.view"), asyncHandler(async (req, res) => {
  const [{ list: releases, byId }, team, all] = await Promise.all([releaseIndex(), db.team.list(), db.rcas.list()]);
  const teamById = new Map(team.map((m) => [m.id, m]));
  const releaseId = String(req.query.release || "").trim();
  const q = String(req.query.q || "").slice(0, 200);
  const status = logic.STATUSES.includes(req.query.status) ? req.query.status : "";
  const oldestFirst = req.query.sort === "oldest";
  const rows = all // the store returns newest first
    .filter((r) => !releaseId || r.releaseId === releaseId)
    .map((r) => logic.publicRca(r, byId, teamById))
    .filter((p) => (!status || p.status === status) && logic.matchesSearch(p, q));
  if (oldestFirst) rows.reverse();
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || 10));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1)); // out of range -> nearest page
  // Releases that already have an RCA but were deleted still appear in the filter
  // (under their saved label) so their analyses stay reachable.
  const deleted = new Map();
  for (const r of all) if (!byId.has(r.releaseId) && !deleted.has(r.releaseId)) deleted.set(r.releaseId, { id: r.releaseId, label: (r.releaseLabel || "Deleted release") + " (deleted)", deleted: true });
  res.json({
    rcas: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
    pages,
    statuses: logic.STATUSES,
    releases: releases.map(logic.releaseOption),
    deletedReleases: Array.from(deleted.values()),
  });
}));

router.post("/", requirePermission("rca.create"), asyncHandler(async (req, res) => {
  const { clean, errors } = logic.validateInput(req.body);
  let release = null;
  if (!errors.releaseId) {
    release = await db.releases.get(clean.releaseId);
    if (!release) errors.releaseId = "That release doesn’t exist any more — pick another.";
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
  const team = await db.team.list();
  const actor = resolveActor(req.authUser, team);
  const now = new Date().toISOString();
  const rec = logic.buildRecord({ id: crypto.randomUUID(), clean, release, actor, now });
  await db.rcas.set(rec.id, rec);
  await recordEvents(db, actor, [{
    action: "RCA_CREATED", entityType: "RCA", entityId: rec.id,
    details: "Added an RCA for " + rec.releaseLabel,
    meta: { releaseId: rec.releaseId },
  }], now);
  const { byId } = await releaseIndex();
  res.status(201).json(logic.publicRca(rec, byId, new Map(team.map((m) => [m.id, m]))));
}));

router.put("/:id", requirePermission("rca.edit"), asyncHandler(async (req, res) => {
  const existing = await db.rcas.get(req.params.id);
  if (!existing) return notFound(res);
  const { clean, errors } = logic.validateInput(req.body);
  let release = null;
  if (!errors.releaseId) {
    release = await db.releases.get(clean.releaseId);
    // Keeping the release an RCA already points at is always allowed — even if that
    // release was deleted since (the saved label stands in for it).
    if (!release && clean.releaseId !== existing.releaseId) errors.releaseId = "That release doesn’t exist any more — pick another.";
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
  const team = await db.team.list();
  const teamById = new Map(team.map((m) => [m.id, m]));
  const newStatus = clean.status || existing.status || logic.DEFAULT_STATUS;
  const changed = logic.TEXT_FIELDS.some(([k]) => existing[k] !== clean[k]) || existing.releaseId !== clean.releaseId || (existing.status || logic.DEFAULT_STATUS) !== newStatus;
  if (!changed) {
    const { byId } = await releaseIndex();
    return res.json(logic.publicRca(existing, byId, teamById));
  }
  const actor = resolveActor(req.authUser, team);
  const now = new Date().toISOString();
  const rec = {
    ...existing,
    releaseId: clean.releaseId,
    releaseLabel: release ? logic.releaseLabel(release) : existing.releaseLabel,
    issue: clean.issue, cause: clean.cause, correctiveAction: clean.correctiveAction, preventiveAction: clean.preventiveAction,
    status: newStatus,
    updatedBy: { id: actor.id || null, name: actor.name || "Unknown" },
    updatedAt: now,
  };
  await db.rcas.set(rec.id, rec);
  await recordEvents(db, actor, [{
    action: "RCA_UPDATED", entityType: "RCA", entityId: rec.id,
    details: "Edited the RCA for " + rec.releaseLabel,
    meta: { releaseId: rec.releaseId },
  }], now);
  const { byId } = await releaseIndex();
  res.json(logic.publicRca(rec, byId, teamById));
}));

router.delete("/:id", requirePermission("rca.delete"), asyncHandler(async (req, res) => {
  const existing = await db.rcas.get(req.params.id);
  if (!existing) return notFound(res);
  await db.rcas.delete(existing.id);
  const team = await db.team.list();
  await recordEvents(db, resolveActor(req.authUser, team), [{
    action: "RCA_DELETED", entityType: "RCA", entityId: existing.id,
    details: "Deleted the RCA for " + (existing.releaseLabel || "a release"),
    meta: { releaseId: existing.releaseId },
  }]);
  res.json({ ok: true });
}));

module.exports = router;
