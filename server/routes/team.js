// "Know the Team" API — a small, editable roster, independent of releases
// and independent of the auth system: this is the QA team's identity (name,
// role, bio, specialties, tools, optional links/photo) — assignments,
// statistics, audit and reports all point at a member by its stable id. It is
// never an account or a permission. An application USER (a Jira account with a
// role) is linked to a member by that id — see rbacService.js; who may do what
// is decided by permissions, not by anything on the card. (The old per-card
// `statisticsAccess` / `reportingAccess` flags are kept in the data for
// rollback but no longer control anything and are never sent to the browser.)
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
const { requirePermission, can } = require("../accessControl");
const rbac = require("../rbacService");
const { HttpError } = require("../httpError");

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

// What the browser gets for a card: never the legacy access flags or the
// legacy email link; instead whether the card is linked to an application user
// and whether that user is the caller (so the page can offer "This is me").
// Who the linked user is — their name — is only for people with users.view.
function publicMember(m, linkedUser, req) {
  if (!m) return m;
  const { statisticsAccess, reportingAccess, linkedEmail, ...rest } = m;
  const out = { ...rest, linked: !!linkedUser, linkedToMe: !!(linkedUser && req.access && linkedUser.id === req.access.user.id) };
  if (linkedUser && can(req, "users.view")) { out.linkedUserId = linkedUser.id; out.linkedUserName = linkedUser.displayName || linkedUser.accountId; }
  return out;
}
async function decorate(members, req) {
  const users = await db.appUsers.list();
  const byMember = new Map(users.filter((u) => u.teamMemberId).map((u) => [u.teamMemberId, u]));
  return members.map((m) => publicMember(m, byMember.get(m.id), req));
}
async function decorateOne(member, req) {
  return (await decorate([member], req))[0];
}

router.get("/", requirePermission("team.view"), asyncHandler(async (req, res) => {
  res.json(await decorate(await db.team.list(), req));
}));

router.post("/", requirePermission("team.manage"), asyncHandler(async (req, res) => {
  const result = validateAndClean(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const member = {
    id,
    ...result.clean,
    seeded: false,
    createdBy: (req.authUser && req.authUser.name) || "Unknown",
    createdAt: now,
    updatedAt: now,
  };
  await db.team.set(id, member);
  res.status(201).json(await decorateOne(member, req));
}));

router.get("/:id", requirePermission("team.view"), asyncHandler(async (req, res) => {
  const m = await db.team.get(req.params.id);
  if (!m) return notFound(res);
  res.json(await decorateOne(m, req));
}));

// Links (or unlinks) the CALLING user's own application user to a Know the
// Team entry — the self-service "This is me" pointer behind "My Regression",
// the Daily QA Report and attribution in the audit log. The link is stored on
// the USER (rbacService.linkSelf: a stable Team Member id, one user per
// member, enforced by the database) — never derived from an email address, and
// the caller can only ever link THEMSELVES: the identity comes from the
// verified session, never from the request body. A card another user already
// holds can't be taken over; an administrator unlinks or re-links people under
// Administration → Users. Linking changes no permissions.
router.put("/:id/link-me", asyncHandler(async (req, res) => {
  const existing = await db.team.get(req.params.id);
  if (!existing) return notFound(res);
  const linked = !!(req.body && req.body.linked);
  if (linked) {
    await rbac.linkSelf(req.access, existing.id);
  } else {
    if (req.access.user.teamMemberId !== existing.id) {
      throw new HttpError(403, "Only the person linked to this card can remove its link here — an administrator can unlink people under Administration → Users.", "NOT_YOURS");
    }
    await rbac.linkSelf(req.access, null);
  }
  res.json(await decorateOne(existing, req));
}));

// RETIRED: Statistics / Reporting access used to be a switch on the card. It
// is now the statistics.view / reporting.view permission, given through a role
// or a per-user override under Administration → Users.
router.put("/:id/access/:page", (req, res) => {
  res.status(410).json({ error: "Page access is now managed under Administration → Users (roles and permissions).", code: "MOVED" });
});

router.put("/:id", requirePermission("team.manage"), asyncHandler(async (req, res) => {
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
  res.json(await decorateOne(merged, req));
}));

router.delete("/:id", requirePermission("team.manage"), asyncHandler(async (req, res) => {
  const existing = await db.team.get(req.params.id);
  if (!existing) return notFound(res);
  // A card that is linked to an application user keeps that link (and the
  // history that points at the card) — unlink it first, deliberately.
  const holder = (await db.appUsers.list()).find((u) => u.teamMemberId === existing.id);
  if (holder) {
    return res.status(409).json({ error: "This card is linked to " + (holder.displayName || "an application user") + ". Unlink it first (Administration → Users), then remove the card.", code: "LINKED" });
  }
  await db.team.delete(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
