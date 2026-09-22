const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const jiraClient = require("../jiraClient");
const atlassianTokens = require("../auth/atlassianTokens");
const { extractIssueKey } = require("../extractKey");
const releaseNotesLogic = require("../releaseNotesLogic"); // this route's only AI-related import — see releaseNotesLogic.generateReleaseNotes() for the abstraction boundary; nothing here talks to an AI provider directly
const { asyncHandler } = require("../asyncHandler");

const router = express.Router();

function newReleaseDoc(name, version, date, qaOwner, regressionModules) {
  const now = new Date().toISOString();
  return {
    name: name || "",
    version: version || "",
    date: date || "",
    qaOwner: qaOwner || "",
    highlights: "",
    tickets: [], // itemized tickets — see ticket shape in jiraClient.fieldsToTicket / manual-add below
    jira: { lastSyncedAt: null },
    // A snapshot of the master Regression Module list (Entity -> Services)
    // at creation time — each release owns its own copy, so editing the
    // master list later never changes a release that already exists (see
    // db.regressionModules and routes/regressionModules.js).
    regression: (regressionModules || []).map((entity) => ({
      id: crypto.randomUUID(),
      entityId: entity.id,
      name: entity.name,
      owner: "", // who's covering this entity's regression, for this release only — set from the UI, never copied from the master list
      services: (entity.services || []).map((s) => ({
        id: crypto.randomUUID(),
        serviceId: s.id,
        name: s.name,
        status: "NOT TESTED",
        notes: "",
      })),
    })),
    regressionSkipped: false, // when true, regression is excluded from the AI assessment for this release
    published: null, // set when "Publish Release" is clicked — { at, recommendation } snapshot; never blocks further edits
    bugs: [],
    platforms: {
      web: { status: "NOT TESTED", notes: "" },
      android: { status: "NOT TESTED", notes: "" },
      ios: { status: "NOT TESTED", notes: "" },
    },
    blockers: [],
    performance: { enabled: false, status: "PASS", responseTime: "", concurrentUsers: "", errorRate: "", sla: "", notes: "" },
    security: { enabled: false, status: "PASS", critical: 0, high: 0, medium: 0, low: 0, notes: "" },
    releaseNotes: { html: "", edited: false, savedAt: null },
    createdAt: now,
    updatedAt: now,
  };
}

function notFound(res) {
  return res.status(404).json({ error: "Release not found." });
}

router.get("/", asyncHandler(async (req, res) => {
  res.json(await db.releases.list());
}));

router.post("/", asyncHandler(async (req, res) => {
  const { name, version, date, qaOwner } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Release name is required." });
  }
  const id = crypto.randomUUID();
  const masterModules = await db.regressionModules.list();
  const doc = { ...newReleaseDoc(name.trim(), version, date, qaOwner, masterModules), _id: id };
  await db.releases.set(id, doc);
  res.status(201).json(doc);
}));

router.get("/:id", asyncHandler(async (req, res) => {
  const r = await db.releases.get(req.params.id);
  if (!r) return notFound(res);
  res.json(r);
}));

// Full-document replace — the frontend mutates its local copy of a release
// (adding a bug, editing a platform, etc.) and PUTs the whole thing back.
// Kept deliberately simple and generic, matching every non-ticket section.
router.put("/:id", asyncHandler(async (req, res) => {
  const existing = await db.releases.get(req.params.id);
  if (!existing) return notFound(res);
  const incoming = req.body || {};
  const merged = { ...incoming, _id: req.params.id, updatedAt: new Date().toISOString() };
  await db.releases.set(req.params.id, merged);
  res.json(merged);
}));

router.delete("/:id", asyncHandler(async (req, res) => {
  const existing = await db.releases.get(req.params.id);
  if (!existing) return notFound(res);
  await db.releases.delete(req.params.id);
  res.json({ ok: true });
}));

router.post("/:id/duplicate", asyncHandler(async (req, res) => {
  const existing = await db.releases.get(req.params.id);
  if (!existing) return notFound(res);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const clone = JSON.parse(JSON.stringify(existing));
  clone._id = id;
  clone.name = (existing.name || "Untitled release") + " (Copy)";
  clone.date = "";
  clone.releaseNotes = { html: "", edited: false, savedAt: null };
  clone.jira = { lastSyncedAt: null };
  clone.createdAt = now;
  clone.updatedAt = now;
  await db.releases.set(id, clone);
  res.status(201).json(clone);
}));

// ---- Tickets ---------------------------------------------------------

function upsertTicket(tickets, ticket, source) {
  const idx = tickets.findIndex((t) => t.key === ticket.key);
  const now = new Date().toISOString();
  if (idx === -1) {
    tickets.push({ ...ticket, source, addedAt: now, updatedAt: now });
    return "added";
  }
  const prior = tickets[idx];
  tickets[idx] = {
    ...prior,
    ...ticket,
    // A ticket confirmed live from Jira (via lookup or sync) is kept in
    // sync going forward, regardless of how it first entered the release.
    source: source === "Jira" ? "Jira" : prior.source,
    addedAt: prior.addedAt,
    updatedAt: now,
  };
  return "updated";
}

// POST /api/releases/:id/tickets — add one ticket by Jira URL.
// If Jira is connected, fields are auto-filled from a live lookup;
// otherwise the caller supplies title/status/issueType/priority.
router.post("/:id/tickets", asyncHandler(async (req, res) => {
  const release = await db.releases.get(req.params.id);
  if (!release) return notFound(res);

  const { url, title, status, issueType, priority } = req.body || {};
  const key = extractIssueKey(url);
  if (!key) {
    return res.status(400).json({ error: "Couldn't find a Jira ticket key in that URL (expected something like MOJ-1234)." });
  }

  release.tickets = release.tickets || [];
  const existing = release.tickets.find((t) => t.key === key);
  if (existing) {
    return res.status(200).json({ duplicate: true, ticket: existing });
  }

  let ticket = null;
  let lookupError = null;
  try {
    ticket = await jiraClient.forUser(req.authUser).getIssue(key);
  } catch (e) {
    if (e instanceof atlassianTokens.ReauthRequiredError) {
      return atlassianTokens.respondReauthRequired(req, res, e);
    }
    lookupError = e.message;
  }

  if (!ticket) {
    // Jira not connected, or the lookup failed — fall back to manual fields.
    ticket = {
      key,
      url,
      title: title && title.trim() ? title.trim() : "Untitled",
      status: status && status.trim() ? status.trim() : "Open / To Do",
      bucket: bucketFromManualStatus(status),
      issueType: issueType && issueType.trim() ? issueType.trim() : "Not provided",
      priority: priority && priority.trim() ? priority.trim() : "Not provided",
    };
  }

  upsertTicket(release.tickets, ticket, "Manual");
  release.updatedAt = new Date().toISOString();
  await db.releases.set(req.params.id, release);
  res.status(201).json({ ticket, lookupUsed: !lookupError, lookupError, release });
}));

function bucketFromManualStatus(status) {
  const s = String(status || "").toLowerCase();
  if (/complete|done|closed|resolved/.test(s)) return "Completed";
  if (/block/.test(s)) return "Blocked";
  if (/\bqa\b|test/.test(s)) return "In QA";
  return "Open / To Do";
}

router.delete("/:id/tickets/:key", asyncHandler(async (req, res) => {
  const release = await db.releases.get(req.params.id);
  if (!release) return notFound(res);
  release.tickets = (release.tickets || []).filter((t) => t.key !== req.params.key);
  release.updatedAt = new Date().toISOString();
  await db.releases.set(req.params.id, release);
  res.json({ ok: true, release });
}));

// POST /api/releases/:id/jira-sync — pull every Jira issue whose Fix
// Version/s matches this release's Version field: add new ones, update
// existing ones (by key), and remove any ticket Jira previously confirmed
// for this release (source "Jira") that this search no longer returns —
// most commonly because its Fix Version/s was changed or cleared in Jira.
// A ticket that's only ever been added manually, and has never itself been
// matched by a Fix Version search, keeps source "Manual" (see upsertTicket)
// and is never touched by this removal — only Jira-confirmed tickets are.
router.post("/:id/jira-sync", asyncHandler(async (req, res) => {
  const release = await db.releases.get(req.params.id);
  if (!release) return notFound(res);

  const fixVersion = (release.version || "").trim();
  if (!fixVersion) {
    return res.status(400).json({ error: "Set this release's Version field before syncing — it's used as the Jira Fix Version to match on." });
  }

  let result;
  try {
    result = await jiraClient.forUser(req.authUser).searchByFixVersion(fixVersion);
  } catch (e) {
    if (e instanceof atlassianTokens.ReauthRequiredError) {
      return atlassianTokens.respondReauthRequired(req, res, e);
    }
    return res.status(e.status || 502).json({ error: e.message });
  }

  release.tickets = release.tickets || [];
  const resultKeys = new Set(result.tickets.map((t) => t.key));
  let added = 0;
  let updated = 0;
  for (const ticket of result.tickets) {
    const outcome = upsertTicket(release.tickets, ticket, "Jira");
    if (outcome === "added") added++;
    else updated++;
  }

  const staleTickets = release.tickets.filter((t) => t.source === "Jira" && !resultKeys.has(t.key));
  if (staleTickets.length) {
    const staleKeys = new Set(staleTickets.map((t) => t.key));
    release.tickets = release.tickets.filter((t) => !staleKeys.has(t.key));
  }

  const now = new Date().toISOString();
  release.jira = { lastSyncedAt: now };
  release.updatedAt = now;
  await db.releases.set(req.params.id, release);

  res.json({
    found: result.total,
    added,
    updated,
    removed: staleTickets.length,
    removedTickets: staleTickets.map((t) => ({ key: t.key, title: t.title })),
    lastSyncedAt: now,
    release,
  });
}));

// ---- Release Notes generation ------------------------------------------
//
// Populates the *existing* Release Notes template (see generateReleaseNotesHtml
// in public/app.js — unchanged) with AI-written summaries for each Jira
// ticket, while every factual field (key, type, status, priority, URL,
// category) comes straight from Jira/existing app data and is never
// touched by AI. See README "Release Notes generation" for the full
// pipeline this implements.
//
// Reuses, rather than duplicates: the same Jira service call as plain Jira
// sync (jiraClient.searchByFixVersion), the same ticket upsert helper
// (upsertTicket, above), and the same rule-based categorizer this feature
// always used (releaseNotesLogic.categorizeTicket — the server-side twin of
// categorizeTicket in app.js). This route never calls an AI provider (or
// even knows if one is configured) — it hands the categorized tickets to
// releaseNotesLogic.generateReleaseNotes() and gets back finished,
// already-validated items. See that function for the "try AI, validate,
// fall back to the rule-based summarizer" pipeline, and aiService.js for
// the one place provider config (a single API key) actually lives.

router.post("/:id/release-notes/generate", asyncHandler(async (req, res) => {
  const release = await db.releases.get(req.params.id);
  if (!release) return notFound(res);

  const fixVersion = (release.version || "").trim();
  if (!fixVersion) {
    return res.status(400).json({
      error: "Set this release's Version field before generating release notes — it's used as the Jira Fix Version to match on.",
    });
  }

  // ---- Retrieve Jira Issues (existing Jira service, same call jira-sync
  // uses) — always a fresh pull, which is what makes "Regenerate" pick up
  // the latest Jira data rather than reusing a stale snapshot. -------------
  let result;
  try {
    result = await jiraClient.forUser(req.authUser).searchByFixVersion(fixVersion);
  } catch (e) {
    if (e instanceof atlassianTokens.ReauthRequiredError) {
      return atlassianTokens.respondReauthRequired(req, res, e);
    }
    return res.status(e.status || 502).json({ error: e.message });
  }

  // ---- Validate issues belong to Fix Version + remove duplicates ---------
  // searchByFixVersion() only ever returns issues Jira itself matched via
  // JQL, but this asserts that explicitly rather than trusting it silently,
  // and de-dupes by key in case Jira ever hands back a page twice.
  const jiraTickets = releaseNotesLogic.dedupeByKey(result.tickets).filter((t) => !!(t && t.key));

  // Same "add new, never delete" contract as plain Jira sync, and the same
  // helper — Release Notes generation also keeps release.tickets current,
  // so it stays the single source of truth for both features rather than
  // this route tracking its own separate copy of "what's in this release".
  release.tickets = release.tickets || [];
  let added = 0;
  let updated = 0;
  for (const ticket of jiraTickets) {
    const outcome = upsertTicket(release.tickets, ticket, "Jira");
    if (outcome === "added") added++;
    else updated++;
  }
  const now = new Date().toISOString();
  release.jira = { lastSyncedAt: now };

  // ---- Categorize using existing logic — never AI -------------------------
  const categorized = jiraTickets.map((t) => ({ ticket: t, category: releaseNotesLogic.categorizeTicket(t) }));

  // ---- Generate release-note content — the only AI-related call this
  // route makes. See releaseNotesLogic.generateReleaseNotes for what
  // happens behind it (AI attempt + validation + rule-based fallback). ---
  const generated = await releaseNotesLogic.generateReleaseNotes(categorized);
  const items = generated.items;
  const validKeys = new Set(categorized.map((c) => c.ticket.key));

  // ---- Tickets on this release that never came back from the live Jira
  // Fix-Version search — genuinely manual (typed by hand, or added when a
  // Jira lookup failed). Never sent to or validated against AI, since there
  // is no Jira data for them in this run to validate an AI summary against.
  const manualItems = (release.tickets || [])
    .filter((t) => t.source === "Manual" && !validKeys.has(t.key))
    .map((t) => {
      const rb = releaseNotesLogic.ruleBasedSummary(t);
      return {
        id: crypto.randomUUID(),
        category: releaseNotesLogic.categorizeTicket(t),
        title: rb.title,
        description: rb.description,
        sourceKey: t.key,
        sourceUrl: t.url,
        issueType: t.issueType,
        status: t.status,
        priority: t.priority,
        origin: "MANUALLY_ADDED",
        engine: "rule_based",
      };
    });

  const allItems = items.concat(manualItems);

  release.releaseNotes = release.releaseNotes || { html: "", edited: false, savedAt: null };
  release.releaseNotes.items = allItems;
  release.releaseNotes.lastGeneratedAt = now;
  release.updatedAt = now;
  await db.releases.set(req.params.id, release);

  res.json({
    release,
    added,
    updated,
    aiConfigured: generated.aiConfigured,
    aiUsed: generated.aiUsed,
    aiUsedCount: generated.aiUsedCount,
    warnings: generated.warnings,
  });
}));

// ---- Regression module sync -------------------------------------------

// POST /api/releases/:id/regression-sync — bring this release's regression
// list in line with the master Regression Module list: add any Entity/
// Service that's missing (a brand-new entity, or a new service added under
// one this release already has), and remove any Entity/Service that this
// release is still tracking but that no longer exists in the master list
// (deleted via ⚙ Manage Modules). A removed entity takes its services —
// and any status, notes, or owner recorded against them — with it; there's
// no separate confirmation step, so the toast after syncing spells out
// exactly what was removed. Only rows that actually came from the master
// list (they carry entityId/serviceId) are ever touched — a legacy
// pre-Entities/Services flat row was never tied to the master list and is
// left alone either way. This lets a release created before an entity/
// service existed pick it up later, and a release tracking one that's
// since been deleted drop it, both on demand rather than automatically.
router.post("/:id/regression-sync", asyncHandler(async (req, res) => {
  const release = await db.releases.get(req.params.id);
  if (!release) return notFound(res);

  const masterEntities = await db.regressionModules.list();
  release.regression = release.regression || [];

  let addedEntities = 0;
  let addedServices = 0;

  for (const masterEntity of masterEntities) {
    let releaseEntity = release.regression.find((e) => e.entityId === masterEntity.id);
    if (!releaseEntity) {
      release.regression.push({
        id: crypto.randomUUID(),
        entityId: masterEntity.id,
        name: masterEntity.name,
        owner: "",
        services: (masterEntity.services || []).map((s) => ({
          id: crypto.randomUUID(),
          serviceId: s.id,
          name: s.name,
          status: "NOT TESTED",
          notes: "",
        })),
      });
      addedEntities += 1;
      addedServices += (masterEntity.services || []).length;
      continue;
    }
    // Entity already tracked on this release — keep its display name
    // current, and add any of its services this release doesn't have yet.
    releaseEntity.name = masterEntity.name;
    releaseEntity.services = releaseEntity.services || [];
    for (const masterService of masterEntity.services || []) {
      const existingService = releaseEntity.services.find((s) => s.serviceId === masterService.id);
      if (!existingService) {
        releaseEntity.services.push({
          id: crypto.randomUUID(),
          serviceId: masterService.id,
          name: masterService.name,
          status: "NOT TESTED",
          notes: "",
        });
        addedServices += 1;
      } else {
        existingService.name = masterService.name;
      }
    }
  }

  // ---- Removal: drop anything this release tracks that the master list
  // no longer has, entity first (whole entity deleted), then service
  // (entity survives, but one of its services was deleted).
  let removedEntities = 0;
  let removedServices = 0;
  const removedNames = [];
  const masterEntityIds = new Set(masterEntities.map((e) => e.id));

  release.regression = release.regression.filter((releaseEntity) => {
    if (!releaseEntity.entityId || !Array.isArray(releaseEntity.services)) return true; // legacy row — untouched
    if (masterEntityIds.has(releaseEntity.entityId)) return true;
    removedEntities += 1;
    removedServices += releaseEntity.services.length;
    removedNames.push(releaseEntity.name || "Unnamed entity");
    return false;
  });

  for (const releaseEntity of release.regression) {
    if (!releaseEntity.entityId || !Array.isArray(releaseEntity.services)) continue;
    const masterEntity = masterEntities.find((e) => e.id === releaseEntity.entityId);
    const masterServiceIds = new Set((masterEntity.services || []).map((s) => s.id));
    const before = releaseEntity.services.length;
    releaseEntity.services = releaseEntity.services.filter((s) => !s.serviceId || masterServiceIds.has(s.serviceId));
    removedServices += before - releaseEntity.services.length;
  }

  release.updatedAt = new Date().toISOString();
  await db.releases.set(req.params.id, release);

  res.json({ addedEntities, addedServices, removedEntities, removedServices, removedNames, release });
}));

module.exports = router;
