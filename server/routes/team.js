// "Know the Team" API — a small, editable roster, independent of releases
// and independent of the auth system entirely: this is display-only data
// (name, role, bio, specialties, tools, optional links/photo), never a
// permission, role, or account of any kind. Mirrors routes/testData.js's
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
  return { clean: { name, role, department, bio, specialties, tools, linkedin, github, photo, regression } };
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
