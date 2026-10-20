// Test Data API — a reusable QA data library, independent of any release
// (see db.js's testData collection). Deliberately mirrors routes/releases.js's
// style: a plain top-level collection, simple REST verbs, no new patterns.
//
// This is NOT a test-management system — no test cases, no executions, no
// relationship to releases. It's a flat list of reusable records (National
// ID + the scenarios/entities/tags/notes that describe what it's good for)
// that a QA engineer can search and reuse while working any release.
//
// Related Test Accounts (links between records — see
// testAccountRelationships.js) live in their own collection and are served
// from /relationships and /:id/relationships below; each account stays an
// independent record. Link changes are audited by the server itself.
//
// Auth: every request here already passed requireAuth (see index.js /
// auth/middleware.js) — identity for createdBy always comes from the
// verified session (req.authUser.name), never from the request body.

const express = require("express");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");
const { resolveActor } = require("../assignmentLogic");
const { recordEvents } = require("../auditWriter");
const rel = require("../testAccountRelationships");

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
function matchesExportFilters(t, q, entQ, tagQ, relatedIds) {
  if (relatedIds && !relatedIds.has(t.id)) return false;
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
    const relatedToQ = String(req.query.relatedTo || "").trim().toLowerCase();
    const allRecords = await db.testData.list();
    // "Related to <National ID>" — only the accounts directly linked to the
    // account(s) with exactly that National ID (same rule as the on-screen filter).
    let relatedIds = null;
    if (relatedToQ) {
      const focus = new Set(allRecords.filter((t) => String(t.nationalId).toLowerCase() === relatedToQ).map((t) => t.id));
      relatedIds = new Set();
      if (focus.size) {
        const { ok } = rel.splitOrphans(await db.testAccountRelationships.list(), new Set(allRecords.map((t) => t.id)));
        for (const r of ok) {
          if (focus.has(r.accountAId)) relatedIds.add(r.accountBId);
          if (focus.has(r.accountBId)) relatedIds.add(r.accountAId);
        }
      }
    }
    const records = allRecords.filter((t) => matchesExportFilters(t, q, entQ, tagQ, relatedIds));

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
    if (q || entQ || tagQ || relatedToQ) nameBits.push("filtered");
    nameBits.push(new Date().toISOString().slice(0, 10));
    const filename = nameBits.join("-") + ".xlsx";

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
}));

// ---- Related Test Accounts ---------------------------------------------
// Declared before the /:id routes so "relationships" is never read as an :id.

async function currentActor(req) {
  return resolveActor(req.authUser, await db.team.list());
}

// Every link whose two accounts still exist, plus the account lookup. Links
// that somehow point at a missing account are dropped from the result and
// cleaned up, so a broken reference can never reach the client.
async function loadRelationshipContext() {
  const [all, accounts] = await Promise.all([db.testAccountRelationships.list(), db.testData.list()]);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const { ok, orphans } = rel.splitOrphans(all, new Set(accountsById.keys()));
  for (const o of orphans) {
    db.testAccountRelationships.delete(o.id).catch((e) => console.error("orphan relationship cleanup failed:", e && e.message));
  }
  return { rels: ok, accountsById };
}

function nid(accountsById, id) {
  const a = accountsById.get(id);
  return a ? a.nationalId : "(deleted account)";
}
// "<B> is <label> of <A>" — A is the account the primary label is written on.
function describeLink(r, accountsById) {
  return (
    nid(accountsById, r.accountBId) + " is " + r.relationshipType + " of " + nid(accountsById, r.accountAId) +
    (r.inverseRelationshipType ? " (inverse: " + r.inverseRelationshipType + ")" : "")
  );
}
function relEvent(action, r, accountsById, extra) {
  return {
    action,
    entityType: "TestAccountRelationship",
    entityId: r.id,
    details: (extra ? extra + " — " : "") + describeLink(r, accountsById),
    meta: {
      accountAId: r.accountAId,
      accountBId: r.accountBId,
      relationshipType: r.relationshipType,
      inverseRelationshipType: r.inverseRelationshipType || null,
    },
  };
}

router.get("/relationships", asyncHandler(async (req, res) => {
  const { rels } = await loadRelationshipContext();
  res.json(rels);
}));

// Create one or several links from account :id to other accounts. Each link is
// validated independently (self-link, missing account, duplicate…); the ones
// that pass are saved and the rest are reported back, nothing is dropped
// silently.
router.post("/:id/relationships", asyncHandler(async (req, res) => {
  const selfId = req.params.id;
  const links = Array.isArray(req.body && req.body.links) ? req.body.links : [];
  if (!links.length) return res.status(400).json({ error: "Choose at least one account to link." });
  if (links.length > 50) return res.status(400).json({ error: "Too many links in one request (max 50)." });
  const { rels, accountsById } = await loadRelationshipContext();
  if (!accountsById.has(selfId)) return notFound(res);
  const actor = await currentActor(req);
  const now = new Date().toISOString();
  const working = rels.slice();
  const created = [];
  const skipped = [];
  for (const link of links) {
    const v = rel.validateLinkRequest(selfId, link, accountsById, working);
    if (v.error) {
      skipped.push({ otherId: (link && link.otherId) || "", reason: v.error, status: v.status || 400 });
      continue;
    }
    const record = rel.buildRecord(v.clean, crypto.randomUUID(), actor, now);
    await db.testAccountRelationships.set(record.id, record);
    working.push(record);
    created.push(record);
  }
  await recordEvents(db, actor, created.map((r) => relEvent("TEST_ACCOUNT_RELATIONSHIP_CREATED", r, accountsById)), now);
  if (!created.length) {
    return res.status(skipped[0].status === 409 ? 409 : 400).json({ error: skipped[0].reason, skipped });
  }
  res.status(201).json({ created, skipped });
}));

// Edit one link from the point of view of `perspectiveId` (either account in
// it): { perspectiveId, relationshipType, inverseRelationshipType } where
// relationshipType = what the OTHER account is to the perspective account.
router.put("/relationships/:relId", asyncHandler(async (req, res) => {
  const { rels, accountsById } = await loadRelationshipContext();
  const existing = rels.find((r) => r.id === req.params.relId);
  if (!existing) return res.status(404).json({ error: "Relationship not found." });
  const perspectiveId = String((req.body && req.body.perspectiveId) || "");
  const v = rel.validateUpdateRequest(existing, perspectiveId, req.body, rels);
  if (v.error) return res.status(v.status || 400).json({ error: v.error });
  if (rel.sameLabels(existing, v.clean)) return res.json(existing);
  const actor = await currentActor(req);
  const now = new Date().toISOString();
  const merged = {
    ...existing,
    accountAId: v.clean.accountAId,
    accountBId: v.clean.accountBId,
    relationshipType: v.clean.relationshipType,
    inverseRelationshipType: v.clean.inverseRelationshipType,
    isReciprocal: !!v.clean.inverseRelationshipType,
    updatedAt: now,
    updatedBy: actor.name,
    updatedByMemberId: actor.id || null,
  };
  await db.testAccountRelationships.set(merged.id, merged);
  await recordEvents(db, actor, [relEvent("TEST_ACCOUNT_RELATIONSHIP_UPDATED", merged, accountsById, "was: " + describeLink(existing, accountsById))], now);
  res.json(merged);
}));

// Removes the link only — both accounts are left exactly as they were.
router.delete("/relationships/:relId", asyncHandler(async (req, res) => {
  const { rels, accountsById } = await loadRelationshipContext();
  const existing = rels.find((r) => r.id === req.params.relId);
  if (!existing) return res.status(404).json({ error: "Relationship not found." });
  await db.testAccountRelationships.delete(existing.id);
  await recordEvents(db, await currentActor(req), [relEvent("TEST_ACCOUNT_RELATIONSHIP_DELETED", existing, accountsById)]);
  res.json({ ok: true });
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
  // Links to this account go with it (each is audited) — the linked accounts
  // themselves stay. Snapshot first so the audit text can still name both ends.
  const { rels, accountsById } = await loadRelationshipContext();
  const touching = rels.filter((r) => rel.involves(r, existing.id));
  await db.testAccountRelationships.deleteForAccount(existing.id);
  await db.testData.delete(req.params.id);
  if (touching.length) {
    await recordEvents(
      db,
      await currentActor(req),
      touching.map((r) => relEvent("TEST_ACCOUNT_RELATIONSHIP_DELETED", r, accountsById, "account deleted"))
    );
  }
  res.json({ ok: true });
}));

module.exports = router;
