// Audit Log API — an append-only, chronological record of meaningful
// actions. Every request here has already passed requireAuth (see
// auth/middleware.js), so identity always comes from the verified session
// (req.authUser) resolved to a Know the Team member — any client-supplied
// name or id is ignored, so a signed-in user can't spoof someone else.
// There is no unauthenticated path and no guest identity.

const express = require("express");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");
const { resolveActor } = require("../assignmentLogic");
const { buildEntry } = require("../auditWriter");
const { hasPageAccess, memberForUser, memberHasAccess, holdsAnyAccess } = require("../pageAccess");

const router = express.Router();

// Keep this list in sync with the action constants used on the client
// (public/app.js, AUDIT_ACTION_LABELS).
const VALID_ACTIONS = new Set([
  "RELEASE_CREATED",
  "RELEASE_UPDATED",
  "TICKET_ADDED",
  "TICKET_UPDATED",
  "TICKET_ASSIGNED",
  "TICKET_REASSIGNED",
  "TICKET_UNASSIGNED",
  "TICKET_QA_ASSIGNED", // legacy (name-based) — still readable on old records
  "TICKET_QA_UNASSIGNED", // legacy
  "JIRA_SYNCED",
  "REGRESSION_UPDATED",
  "REGRESSION_ASSIGNED",
  "REGRESSION_UNASSIGNED",
  "ENTITY_REGRESSION_ASSIGNED",
  "KNOWN_BUG_ADDED",
  "KNOWN_BUG_UPDATED",
  "BLOCKER_ADDED",
  "BLOCKER_UPDATED",
  "INCIDENT_CREATED",
  "INCIDENT_UPDATED",
  "INCIDENT_DELETED",
  "PLATFORM_UPDATED",
  "PERFORMANCE_UPDATED",
  "SECURITY_UPDATED",
  "AI_ASSESSMENT_GENERATED",
  "RELEASE_NOTES_GENERATED",
  "RELEASE_NOTES_UPDATED",
  "MOBILE_RELEASE_NOTE_UPDATED",
  "TEST_DATA_CREATED",
  "TEST_DATA_IMPORTED",
  "TEST_DATA_UPDATED",
  "TEST_DATA_COPIED",
  "TEST_DATA_DELETED",
  "TEST_ACCOUNT_RELATIONSHIP_CREATED",
  "TEST_ACCOUNT_RELATIONSHIP_UPDATED",
  "TEST_ACCOUNT_RELATIONSHIP_DELETED",
  "TEAM_MEMBER_ADDED",
  "TEAM_MEMBER_UPDATED",
  "TEAM_MEMBER_DELETED",
  "TEAM_MEMBER_LINKED",
  "TEAM_MEMBER_UNLINKED",
  "STATISTICS_ACCESS_GRANTED",
  "STATISTICS_ACCESS_REVOKED",
  "REPORTING_ACCESS_GRANTED",
  "REPORTING_ACCESS_REVOKED",
  "REPORT_SYNC_RUN",
  "REPORT_SETTINGS_UPDATED",
  "REPORT_EXPORTED",
  "REPORT_DEPENDENCY_CHANGED",
]);

// Assignment events and regression status changes are written by the SERVER
// when a release is saved (routes/releases.js → diffReleaseActivity), where
// the before/after state and the actor are both known and trustworthy. The
// browser may not post these itself — that would let a client invent
// assignment history. (REGRESSION_UPDATED stays postable: the browser still
// reports notes edits and the skip toggle with it; those carry no meta.)
const SERVER_ONLY_ACTIONS = new Set([
  "TEST_ACCOUNT_RELATIONSHIP_CREATED",
  "TEST_ACCOUNT_RELATIONSHIP_UPDATED",
  "TEST_ACCOUNT_RELATIONSHIP_DELETED",
  "TICKET_ASSIGNED",
  "TICKET_REASSIGNED",
  "TICKET_UNASSIGNED",
  "REGRESSION_ASSIGNED",
  "REGRESSION_UNASSIGNED",
  "ENTITY_REGRESSION_ASSIGNED",
  "TEAM_MEMBER_LINKED",
  "TEAM_MEMBER_UNLINKED",
  "STATISTICS_ACCESS_GRANTED",
  "STATISTICS_ACCESS_REVOKED",
  "REPORTING_ACCESS_GRANTED",
  "REPORTING_ACCESS_REVOKED",
  "REPORT_SYNC_RUN",
  "REPORT_SETTINGS_UPDATED",
  "REPORT_EXPORTED",
  "REPORT_DEPENDENCY_CHANGED",
]);

// Who changed whose access to a restricted page, and Reporting sync/settings
// activity, is only for the people who hold that access — the rest of the team
// doesn't see these events (or even that they exist).
const ACCESS_CHANGE_ACTIONS = new Set([
  "STATISTICS_ACCESS_GRANTED", "STATISTICS_ACCESS_REVOKED",
  "REPORTING_ACCESS_GRANTED", "REPORTING_ACCESS_REVOKED",
]);
const REPORTING_ACTIONS = new Set(["REPORT_SYNC_RUN", "REPORT_SETTINGS_UPDATED", "REPORT_EXPORTED", "REPORT_DEPENDENCY_CHANGED"]);

// GET /api/audit — audit records visible to the caller, newest first.
// The structured `meta` (who changed whose regression, previous/new status…)
// is the raw material of the Statistics page, so it is only returned to people
// with Statistics access; everyone else gets the plain entries.
router.get("/", asyncHandler(async (req, res) => {
  const all = await db.auditLog.list();
  const team = await db.team.list();
  const me = memberForUser(req.authUser, team);
  const holdsAny = holdsAnyAccess(me);
  const holdsReporting = memberHasAccess(me, "reporting");
  const list = all.filter((e) => {
    if (!e) return false;
    if (ACCESS_CHANGE_ACTIONS.has(e.action)) return holdsAny;
    if (REPORTING_ACTIONS.has(e.action)) return holdsReporting;
    return true;
  });
  if (hasPageAccess(req.authUser, team, "statistics")) return res.json(list);
  res.json(list.map((e) => {
    if (!e.meta) return e;
    const { meta, ...rest } = e;
    return rest;
  }));
}));

// POST /api/audit — append one audit record. Called by the client's
// logAudit() helper right after a meaningful, already-successful action.
// Free-text fields are length-capped rather than validated strictly, since
// this is activity tracking, not a system of record.
router.post("/", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const action = String(body.action || "").trim();
  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: "Unknown or missing audit action." });
  }
  if (SERVER_ONLY_ACTIONS.has(action)) {
    return res.status(400).json({ error: "This audit event is recorded by the server." });
  }
  const team = await db.team.list();
  const actor = resolveActor(req.authUser, team);
  // `meta` is deliberately not accepted from the browser (see above).
  const entry = buildEntry(actor, { id: body.id, action, entityType: body.entityType, entityId: body.entityId, details: body.details });
  const saved = await db.auditLog.append(entry);
  res.status(201).json(saved);
}));

module.exports = router;
module.exports.VALID_ACTIONS = VALID_ACTIONS;
module.exports.SERVER_ONLY_ACTIONS = SERVER_ONLY_ACTIONS;
