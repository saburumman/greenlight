// "Know the Team" API — a small, editable roster, independent of releases
// and independent of the auth system entirely: this is display-only data
// (name, role, bio, specialties, tools, optional links/photo), never a
// role or account. The one exception is the opt-in `statisticsAccess` flag,
// which only decides who is shown the Statistics page. Mirrors routes/testData.js's
// style — a plain top-level collection, simple REST verbs, no new patterns.
//
// Auth: every request here already passed requireAuth (see index.js /
// auth/middleware.js) — identity for createdBy always comes from the
// verified session (req.authUser.name), never from the request body.

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");

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
  // Who may open the Statistics page. Opt-in (a member without the key has no
  // access). Only set when the request actually carries a boolean, so an
  // edit from a client that doesn't know about it can never switch someone's
  // access off (PUT merges these fields over the existing record).
  if (body && typeof body.statisticsAccess === "boolean") clean.statisticsAccess = body.statisticsAccess;
  // Extra names this person goes by in Jira (when it spells them differently
  // from `name`), used to match Jira's "QA Assigned" field to them. Same
  // "only when sent" rule, so an older client can't wipe them.
  if (body && (Array.isArray(body.jiraNames) || typeof body.jiraNames === "string")) {
    clean.jiraNames = cleanStringList(body.jiraNames);
  }
  return { clean };
}

router.get("/", asyncHandler(async (req, res) => {
  res.json(await db.team.list());
}));

router.post("/", asyncHandler(async (req, res) => {
  const result = validateAndClean(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const member = {
    id,
    statisticsAccess: false,
    ...result.clean,
    seeded: false,
    createdBy: (req.authUser && req.authUser.name) || "Unknown",
    createdAt: now,
    updatedAt: now,
  };
  await db.team.set(id, member);
  res.status(201).json(member);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const m = await db.team.get(req.params.id);
  if (!m) return notFound(res);
  res.json(m);
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
  for (const m of all) {
    if (m.id !== existing.id && m.linkedEmail === email) {
      await db.team.set(m.id, { ...m, linkedEmail: null });
    }
  }

  const updated = { ...existing, linkedEmail: linked ? email : null };
  await db.team.set(existing.id, updated);
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
  res.json(merged);
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const existing = await db.team.get(req.params.id);
  if (!existing) return notFound(res);
  await db.team.delete(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
