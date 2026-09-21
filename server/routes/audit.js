// Audit Log API — an append-only record of meaningful actions. Every
// request here has already passed requireAuth (see auth/middleware.js), so
// identity always comes from the verified session (req.authUser); any
// client-supplied sessionId/userName is ignored — a signed-in user can't
// spoof someone else's name. The guest-identity branch below is dead code
// now that login is mandatory (kept only as a defensive fallback in case
// req.authUser is ever missing) — there is no unauthenticated path anymore.

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");

const router = express.Router();

// Keep this list in sync with the action constants used on the client
// (public/app.js, near the logAudit() helper).
const VALID_ACTIONS = new Set([
  "RELEASE_CREATED",
  "RELEASE_UPDATED",
  "TICKET_ADDED",
  "TICKET_UPDATED",
  "JIRA_SYNCED",
  "REGRESSION_UPDATED",
  "KNOWN_BUG_ADDED",
  "KNOWN_BUG_UPDATED",
  "BLOCKER_ADDED",
  "BLOCKER_UPDATED",
  "PLATFORM_UPDATED",
  "PERFORMANCE_UPDATED",
  "SECURITY_UPDATED",
  "AI_ASSESSMENT_GENERATED",
  "RELEASE_NOTES_GENERATED",
  "RELEASE_NOTES_UPDATED",
  "TEST_DATA_CREATED",
  "TEST_DATA_UPDATED",
  "TEST_DATA_COPIED",
  "TEST_DATA_DELETED",
  "TEAM_MEMBER_ADDED",
  "TEAM_MEMBER_UPDATED",
  "TEAM_MEMBER_DELETED",
]);

// GET /api/audit — every audit record, newest first.
router.get("/", asyncHandler(async (req, res) => {
  res.json(await db.auditLog.list());
}));

// POST /api/audit — append one audit record. Called by the client's
// logAudit() helper right after a meaningful, already-successful action.
// Fields are trusted as display text only, and are length-capped rather
// than validated strictly, since this is activity tracking, not a system
// of record.
router.post("/", asyncHandler(async (req, res) => {
  const body = req.body || {};
  const action = String(body.action || "").trim();
  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: "Unknown or missing audit action." });
  }
  // req.authUser (set by requireAuth) always wins over whatever the client
  // sent — that's the whole point of gating this with real sign-in.
  const identity = req.authUser
    ? { sessionId: req.authUser.accountId, userName: req.authUser.name }
    : {
        sessionId: body.sessionId ? String(body.sessionId).slice(0, 200) : null,
        // Missing/invalid guest session (cleared storage, private browsing,
        // etc.) never blocks the audit record — it just falls back to a
        // plain "Unknown" label rather than failing the request.
        userName: body.userName && String(body.userName).trim() ? String(body.userName).trim().slice(0, 200) : "Unknown",
      };
  const entry = {
    id: body.id && typeof body.id === "string" ? body.id.slice(0, 100) : crypto.randomUUID(),
    sessionId: identity.sessionId,
    userName: identity.userName,
    action,
    entityType: body.entityType ? String(body.entityType).slice(0, 100) : "",
    entityId: body.entityId ? String(body.entityId).slice(0, 200) : "",
    details: body.details ? String(body.details).slice(0, 500) : "",
    createdAt: new Date().toISOString(),
  };
  const saved = await db.auditLog.append(entry);
  res.status(201).json(saved);
}));

module.exports = router;
