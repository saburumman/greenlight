// "Know the Team" API — a small, editable roster, independent of releases
// and independent of the auth system entirely: this is display-only data
// (name, role, bio, specialties, tools, optional links/photo), never a
// role or account. The one exception is the opt-in access flags
// (`statisticsAccess`, `reportingAccess`) that decide who may open the
// restricted Statistics / Reporting pages — see pageAccess.js. They are NEVER
// read from a normal create/edit body: they change only through
// PUT /:id/access/:page, which enforces who may change them and audits it.
// Mirrors routes/testData.js's
// style — a plain top-level collection, simple REST verbs, no new patterns.
//
// Auth: every request here already passed requireAuth (see index.js /
// auth/middleware.js) — identity for createdBy always comes from the
// verified session (req.authUser.name), never from the request body.

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");
const { resolveActor } = require("../assignmentLogic");
const { recordEvents } = require("../auditWriter");
const access = require("../pageAccess");

const router = express.Router();

// Data-URL photos only (no file uploads / multipart handling needed — the
// client resizes/compresses the image client-side before sending it), and
// capped well under the server's 2mb JSON body limit so one oversized photo
// can't bloat the whole store.
const MAX_PHOTO_LENGTH = 400000; // ~300KB decoded
const PHOTO_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/;

function notFound(res) {
  return res.status(404).json({ error: "Team member not found." });
}

function cleanStringList(value) {
  const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const v = String(raw == null ? "" : raw).trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function validateAndClean(body) {
  const name = String((body && body.name) || "").trim();
  if (!name) return { error: "Name is required." };
  const role = String((body && body.role) || "").trim();
  // Free text (not a fixed list) — the client groups "Know the Team" by
  // whatever values are actually in use, same pattern as Test Data's
  // Entity/Tags fields. Blank means "no department set" (grouped under
  // "Unassigned" client-side, not enforced here).
  const department = String((body && body.department) || "").trim();
  const bio = String((body && body.bio) || "").trim();
  const specialties = cleanStringList(body && body.specialties);
  const tools = cleanStringList(body && body.tools);
  const linkedin = String((body && body.linkedin) || "").trim();
  const github = String((body && body.github) || "").trim();
  let photo = typeof (body && body.photo) === "string" ? body.photo.trim() : "";
  if (photo) {
    if (!PHOTO_DATA_URL_RE.test(photo)) {
      return { error: "Photo must be a PNG, JPEG or WebP image." };
    }
    if (photo.length > MAX_PHOTO_LENGTH) {
      return { error: "Photo is too large — please use a smaller image." };
    }
  }
  // Whether this person should appear in the Regression section's
  // assignment dropdowns. Client always sends an explicit true/false from
  // its toggle; a record saved before this field existed simply has no
  // `regression` key at all, and the client treats that missing key as
  // eligible (true) for backward compatibility — see regressionOwnerOptions()
  // in public/app.js.
  const regression = !!(body && body.regression);
  const clean = { name, role, department, bio, specialties, tools, linkedin, github, photo, regression };
  // Extra names this person goes by in Jira (when it spells them differently
  // from `name`), used to match Jira's "QA Assigned" field to them. Same
  // "only when sent" rule, so an older client can't wipe them.
  if (body && (Array.isArray(body.jiraNames) || typeof body.jiraNames === "string")) {
    clean.jiraNames = cleanStringList(body.jiraNames);
  }
  return { clean };
}

// Who has which restricted page is not for the whole team to see: people who
// hold any restricted-page access get the flags (they manage them); everyone
// else gets them stripped from other people's cards — only their own card
// keeps its flags, because the page uses that to decide what to show them.
function redactAccess(member, viewer, team) {
  if (!member) return member;
  if (access.holdsAnyAccess(viewer)) return member;
  if (viewer && viewer.id === member.id) return member;
  const out = { ...member };
  for (const p of Object.keys(access.RESTRICTED_PAGES)) delete out[access.RESTRICTED_PAGES[p].field];
  return out;
}
async function viewerOf(req) {
  const team = await db.team.list();
  return { team, viewer: access.memberForUser(req.authUser, team) };
}

router.get("/", asyncHandler(async (req, res) => {
  const { team, viewer } = await viewerOf(req);
  res.json(team.map((m) => redactAccess(m, viewer, team)));
}));

router.post("/", asyncHandler(async (req, res) => {
  const result = validateAndClean(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const member = {
    id,
    statisticsAccess: false,
    reportingAccess: false,
    ...result.clean,
    seeded: false,
    createdBy: (req.authUser && req.authUser.name) || "Unknown",
    createdAt: now,
    updatedAt: now,
  };
  await db.team.set(id, member);
  const v1 = await viewerOf(req);
  res.status(201).json(redactAccess(member, v1.viewer, v1.team));
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const m = await db.team.get(req.params.id);
  if (!m) return notFound(res);
  const v2 = await viewerOf(req);
  res.json(redactAccess(m, v2.viewer, v2.team));
}));

// Links (or unlinks) the CALLING user's own signed-in account to a Know the
// Team entry — this is the server-side "This is me" pointer the client uses
// to resolve "My Regression" (see public/app.js#currentPreparerName /
// myLinkedTeamMemberId), instead of hoping the caller's Atlassian display
// name happens to be spelled identically to the free-text name someone
// picked for them in Know the Team. Deliberately self-service only: the
// linked identity always comes from req.authUser.email (the verified
// session), never from the request body, so nobody can link an account to
// someone else's entry. Setting a new link clears it from any other entry
// previously linked to that same email first, so a person is only ever
// linked to one entry at a time; this never touches any of the member's
// other fields (name, role, bio, ...) or their `seeded`/`updatedAt`
// bookkeeping, so it's safe to call from a one-click UI without disturbing
// anything else about the record.
router.put("/:id/link-me", asyncHandler(async (req, res) => {
  if (!req.authUser || !req.authUser.email) {
    return res.status(401).json({ error: "Sign in required." });
  }
  const existing = await db.team.get(req.params.id);
  if (!existing) return notFound(res);
  const email = String(req.authUser.email).trim().toLowerCase();
  const linked = !!(req.body && req.body.linked);

  const all = await db.team.list();
  const actor = resolveActor(req.authUser, all);
  const heldBy = existing.linkedEmail ? String(existing.linkedEmail).trim().toLowerCase() : "";

  // A card that another account already holds can't be taken over — access
  // (Statistics, Reporting) follows this link, so re-pointing someone else's
  // card at yourself would hand you their permissions. Its holder unlinks it
  // first (or someone who has restricted-page access does, e.g. when the
  // holder has left).
  if (linked && heldBy && heldBy !== email) {
    return res.status(409).json({ error: "This card is already linked to another account. They (or someone with Statistics or Reporting access) need to remove that link first." });
  }
  if (!linked && heldBy && heldBy !== email) {
    const me = access.memberForUser(req.authUser, all);
    if (!access.holdsAnyAccess(me)) {
      return res.status(403).json({ error: "Only the person linked to this card, or someone with Statistics or Reporting access, can remove its link." });
    }
  }

  const events = [];
  // Linking moves the caller's link here (a person is linked to ONE card);
  // removing someone else's stale link must not touch the caller's own card.
  for (const m of linked ? all : []) {
    if (m.id !== existing.id && m.linkedEmail && String(m.linkedEmail).trim().toLowerCase() === email) {
      await db.team.set(m.id, { ...m, linkedEmail: null });
      events.push({ action: "TEAM_MEMBER_UNLINKED", entityType: "TeamMember", entityId: m.id, details: "Sign-in link removed from " + (m.name || "a team member") });
    }
  }

  const updated = { ...existing, linkedEmail: linked ? email : null };
  await db.team.set(existing.id, updated);
  if (linked && heldBy !== email) events.push({ action: "TEAM_MEMBER_LINKED", entityType: "TeamMember", entityId: existing.id, details: "Sign-in linked to " + (existing.name || "a team member") });
  if (!linked && heldBy) events.push({ action: "TEAM_MEMBER_UNLINKED", entityType: "TeamMember", entityId: existing.id, details: "Sign-in link removed from " + (existing.name || "a team member") });
  if (events.length) await recordEvents(db, actor, events);
  res.json(redactAccess(updated, access.memberForUser(req.authUser, all), all));
}));

// Switch one restricted page on/off for one person. Dedicated endpoint (not
// the profile edit) so access can never change by accident, and so the rules
// in pageAccess.canChangePageAccess + the audit trail are always applied.
router.put("/:id/access/:page", asyncHandler(async (req, res) => {
  const cfg = access.pageConfig(req.params.page);
  if (!cfg) return res.status(404).json({ error: "Unknown page." });
  if (!req.body || typeof req.body.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be true or false." });
  }
  const enable = req.body.enabled;
  const target = await db.team.get(req.params.id);
  if (!target) return notFound(res);
  const team = await db.team.list();
  const actorMember = access.memberForUser(req.authUser, team);
  const verdict = access.canChangePageAccess(actorMember, target, team, req.params.page, enable);
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });
  if (verdict.noop) return res.json(target); // already in that state — nothing to save, nothing to audit

  const updated = { ...target, [cfg.field]: enable, updatedAt: new Date().toISOString() };
  await db.team.set(target.id, updated);
  const actor = resolveActor(req.authUser, team);
  await recordEvents(db, actor, [{
    action: cfg.label.toUpperCase() + (enable ? "_ACCESS_GRANTED" : "_ACCESS_REVOKED"),
    entityType: "TeamMember",
    entityId: target.id,
    details: cfg.label + " access " + (enable ? "granted to " : "revoked from ") + (target.name || "a team member"),
    meta: { targetMemberId: target.id, page: req.params.page },
  }]);
  res.json(updated);
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const existing = await db.team.get(req.params.id);
  if (!existing) return notFound(res);
  const result = validateAndClean(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const merged = {
    ...existing,
    ...result.clean,
    id: existing.id,
    // Any real edit — even just retouching a starter entry — retires its
    // "Example" badge, since it's no longer the untouched seed data.
    seeded: false,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await db.team.set(existing.id, merged);
  const v3 = await viewerOf(req);
  res.json(redactAccess(merged, v3.viewer, v3.team));
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const existing = await db.team.get(req.params.id);
  if (!existing) return notFound(res);
  await db.team.delete(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
