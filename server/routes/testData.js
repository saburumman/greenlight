// Test Data API — a reusable QA data library, independent of any release
// (see db.js's testData collection). Deliberately mirrors routes/releases.js's
// style: a plain top-level collection, simple REST verbs, no new patterns.
//
// This is NOT a test-management system — no test cases, no executions, no
// relationship to releases. It's a flat list of reusable records (National
// ID + the scenarios/entities/tags/notes that describe what it's good for)
// that a QA engineer can search and reuse while working any release.
//
// Auth: every request here already passed requireAuth (see index.js /
// auth/middleware.js) — identity for createdBy always comes from the
// verified session (req.authUser.name), never from the request body.

const express = require("express");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");

const router = express.Router();

function notFound(res) {
  return res.status(404).json({ error: "Test data record not found." });
}

// ---- Validation / normalization -------------------------------------
//
// National ID is stored and compared as trimmed text (never numeric) so
// leading zeros are preserved. Supported Scenarios, Entities, and Tags are
// all free-text lists — trimmed, de-duped, blanks dropped — with at least
// one Entity required (used to group/filter records); Notes is the only
// optional field.

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
  const nationalId = String((body && body.nationalId) || "").trim();
  if (!nationalId) return { error: "National ID is required." };
  const supportedScenarios = cleanStringList(body && body.supportedScenarios);
  if (!supportedScenarios.length) return { error: "At least one supported scenario is required." };
  // Accepts multiple entities per record (an array, or a comma-separated
  // string from an older client) — same free-text-list handling as
  // Supported Scenarios/Tags, just with a minimum of one required.
  const entities = cleanStringList(body && body.entities);
  if (!entities.length) return { error: "At least one entity is required." };
  const tags = cleanStringList(body && body.tags);
  const notes = String((body && body.notes) || "").trim();
  return { clean: { nationalId, supportedScenarios, entities, tags, notes } };
}

// Existing record with the same National ID (trimmed, exact match) — used
// to warn about accidental duplicates rather than silently creating one.
// `excludeId` lets an update check without colliding with itself.
async function findDuplicate(nationalId, excludeId) {
  const all = await db.testData.list();
  return all.find((t) => t.nationalId === nationalId && t.id !== excludeId) || null;
}

router.get("/", asyncHandler(async (req, res) => {
  res.json(await db.testData.list());
}));

router.post("/", asyncHandler(async (req, res) => {
  const result = validateAndClean(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const dup = await findDuplicate(result.clean.nationalId, null);
  if (dup) {
    return res.status(409).json({
      error: "A test data record with this National ID already exists.",
      existingId: dup.id,
    });
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const record = {
    id,
    ...result.clean,
    createdBy: (req.authUser && req.authUser.name) || "Unknown",
    createdAt: now,
    updatedAt: now,
  };
  await db.testData.set(id, record);
  res.status(201).json(record);
}));

// Bulk create — backs the "Import Test Data" flow (client parses a CSV
// export, the user fills in whatever's required and missing — see
// buildTestDataImportDraft() in app.js — then this commits everything in
// one request). Each record goes through the exact same validation as a
// single POST /, and a National ID that already exists (in the store, or
// earlier in this same batch) is skipped rather than failing the whole
// batch — the client already filters out IDs it knows about, but this is
// the authoritative check, same duplicate rule as the single-record route.
router.post("/bulk", asyncHandler(async (req, res) => {
  const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
  if (!records.length) return res.status(400).json({ error: "No records to import." });
  if (records.length > 2000) return res.status(400).json({ error: "Too many records in one import (max 2000)." });

  const created = [];
  const skipped = [];
  const seenInBatch = new Set();
  const now = new Date().toISOString();

  for (const raw of records) {
    const result = validateAndClean(raw);
    if (result.error) {
      skipped.push({ nationalId: (raw && raw.nationalId) || "", reason: result.error });
      continue;
    }
    const { clean } = result;
    if (seenInBatch.has(clean.nationalId) || (await findDuplicate(clean.nationalId, null))) {
      skipped.push({ nationalId: clean.nationalId, reason: "A test data record with this National ID already exists." });
      continue;
    }
    seenInBatch.add(clean.nationalId);
    created.push({
      id: crypto.randomUUID(),
      ...clean,
      createdBy: (req.authUser && req.authUser.name) || "Unknown",
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const record of created) {
    await db.testData.set(record.id, record);
  }
  res.status(201).json({ created, skipped });
}));

// Same predicate as the client's filterTestData() in app.js, kept in sync
// by hand — used only by the export route below, so export honors
// whatever search/entity/tag filters are active on screen when it's
// downloaded (no filters active = every record).
function matchesExportFilters(t, q, entQ, tagQ) {
  if (entQ && !(t.entities || []).some((en) => en.toLowerCase().indexOf(entQ) > -1)) return false;
  if (tagQ && !(t.tags || []).some((tg) => tg.toLowerCase().indexOf(tagQ) > -1)) return false;
  if (!q) return true;
  const hay = [t.nationalId, (t.supportedScenarios || []).join(" "), (t.entities || []).join(" "), (t.tags || []).join(" "), t.notes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.indexOf(q) > -1;
}

// Placed before GET /:id so "export" is never swallowed as an :id.
router.get("/export", asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const entQ = String(req.query.entity || "").trim().toLowerCase();
    const tagQ = String(req.query.tag || "").trim().toLowerCase();
    const allRecords = await db.testData.list();
    const records = allRecords.filter((t) => matchesExportFilters(t, q, entQ, tagQ));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Release Monitor";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Test Data");
    sheet.columns = [
      { header: "National ID", key: "nationalId", width: 20 },
      { header: "Supported Scenarios", key: "supportedScenarios", width: 44 },
      { header: "Entities", key: "entities", width: 28 },
      { header: "Tags", key: "tags", width: 22 },
      { header: "Notes", key: "notes", width: 44 },
      { header: "Created By", key: "createdBy", width: 18 },
      { header: "Created At", key: "createdAt", width: 20 },
    ];
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9EEF6" } };
    records.forEach((t) => {
      sheet.addRow({
        nationalId: t.nationalId,
        supportedScenarios: (t.supportedScenarios || []).join(", "),
        entities: (t.entities || []).join(", "),
        tags: (t.tags || []).join(", "),
        notes: t.notes || "",
        createdBy: t.createdBy || "",
        createdAt: t.createdAt ? new Date(t.createdAt).toLocaleString() : "",
      });
    });
    sheet.autoFilter = { from: "A1", to: "G1" };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const nameBits = ["test-data"];
    if (q || entQ || tagQ) nameBits.push("filtered");
    nameBits.push(new Date().toISOString().slice(0, 10));
    const filename = nameBits.join("-") + ".xlsx";

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const t = await db.testData.get(req.params.id);
  if (!t) return notFound(res);
  res.json(t);
}));

router.put("/:id", asyncHandler(async (req, res) => {
  const existing = await db.testData.get(req.params.id);
  if (!existing) return notFound(res);
  const result = validateAndClean(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const dup = await findDuplicate(result.clean.nationalId, existing.id);
  if (dup) {
    return res.status(409).json({
      error: "Another test data record already uses this National ID.",
      existingId: dup.id,
    });
  }
  const merged = {
    ...existing,
    ...result.clean,
    id: existing.id,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await db.testData.set(existing.id, merged);
  res.json(merged);
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const existing = await db.testData.get(req.params.id);
  if (!existing) return notFound(res);
  await db.testData.delete(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
