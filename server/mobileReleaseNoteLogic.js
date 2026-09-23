// Mobile Release Note — the short, store-facing "What's New" bullets an App
// Store / Play Store submission form requires, in English (en-US) and
// Arabic (ar).
//
// Deliberately separate from Release Notes (releaseNotesLogic.js): that
// feature writes detailed, categorized entries for an internal audience;
// this one writes a handful of short, plain-language customer-facing
// bullets, in the exact tagged format the store submission form expects
// (see routes/releases.js for the two endpoints this backs, and
// public/app.js's formatMobileReleaseNoteBlock for where that tagged block
// is actually assembled — client-side, since it's pure formatting of
// whatever's currently in the two textareas).
//
// Like releaseNotesLogic.js, AI (see aiService.js) is used only to draft or
// translate text, never as the only path: drafting the English bullets
// always has a rule-based fallback (bulletFallbackLine) if AI isn't
// configured or fails. Arabic translation has no safe rule-based
// equivalent, so routes/releases.js requires AI to be configured for that
// step and surfaces a clear error otherwise (see translateBulletsToArabic).

const aiService = require("./aiService");
const releaseNotesLogic = require("./releaseNotesLogic");

const MAX_BULLET_LEN = 110;

function truncate(s, max) {
  s = String(s || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// Non-AI fallback: one plain sentence per item, built from its title and
// category — same honest, never-invented spirit as
// releaseNotesLogic.ticketFallbackSentence, just shorter and in
// store-bullet phrasing rather than Jira-ticket phrasing.
function bulletFallbackLine(item) {
  const title = String((item && item.title) || "this change").replace(/\.$/, "");
  const category = item && item.category;
  let text;
  if (category === "Bug Fix") text = "Fixed: " + title + ".";
  else if (category === "New Feature") text = "New: " + title + ".";
  else if (category === "Improvement") text = "Improved: " + title + ".";
  else text = title + ".";
  return truncate(text, MAX_BULLET_LEN);
}

// Where the draft's source items come from: prefer the already-generated
// Release Notes items (release.releaseNotes.items) — they already have a
// category + written description, so drafting from them needs no extra
// Jira call. Falls back to the release's plain ticket list
// (release.tickets), summarized with the same rule-based categorizer/
// summary Release Notes itself falls back to, for a release that has
// tickets but has never run "Generate Release Notes".
function buildDraftItems(release) {
  const rnItems = (release.releaseNotes && release.releaseNotes.items) || [];
  if (rnItems.length) {
    return rnItems.map((it) => ({ key: it.sourceKey, title: it.title, description: it.description, category: it.category }));
  }
  const tickets = release.tickets || [];
  return tickets.map((t) => {
    const rb = releaseNotesLogic.ruleBasedSummary(t);
    return { key: t.key, title: rb.title, description: rb.description, category: rb.category };
  });
}

// Validates the AI's {key, bullet} response against the real item list —
// same defensive shape as releaseNotesLogic.mapAiResponseToItems: an
// invented/unknown key is dropped, a missing/empty bullet falls back to
// bulletFallbackLine, and every input item is guaranteed exactly one output
// line, in the item's own order (never the AI's order).
function mapBulletResponse(items, rawAiResponse) {
  const byKey = new Map();
  if (Array.isArray(rawAiResponse)) {
    for (const entry of rawAiResponse) {
      if (!entry || typeof entry !== "object" || !entry.key) continue;
      const bullet = typeof entry.bullet === "string" ? truncate(entry.bullet, MAX_BULLET_LEN) : "";
      if (bullet) byKey.set(entry.key, bullet);
    }
  }
  return items.map((it) => byKey.get(it.key) || bulletFallbackLine(it));
}

function linesToBullets(text) {
  return String(text || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// The single seam between this feature and AI for drafting English bullets
// — routes/releases.js calls this and nothing AI-related directly (same
// pattern as releaseNotesLogic.generateReleaseNotes). Always returns a
// usable result: AI attempt + validation, falling back to
// bulletFallbackLine per item on any failure or when AI isn't configured.
async function draftEnglishBullets(release) {
  const items = buildDraftItems(release);
  if (!items.length) {
    return { bullets: [], aiUsed: false, warning: null, empty: true };
  }

  if (!aiService.isConfigured()) {
    return { bullets: items.map(bulletFallbackLine), aiUsed: false, warning: null, empty: false };
  }

  try {
    const raw = await aiService.generateMobileBullets(items);
    return { bullets: mapBulletResponse(items, raw), aiUsed: true, warning: null, empty: false };
  } catch (e) {
    return {
      bullets: items.map(bulletFallbackLine),
      aiUsed: false,
      warning: (e && e.message) || "AI drafting failed — used simple bullets from the ticket titles instead.",
      empty: false,
    };
  }
}

// The single seam for Arabic translation. Unlike draftEnglishBullets, this
// throws (with a status) rather than silently falling back — there is no
// safe rule-based translation, so the caller (routes/releases.js) surfaces
// the failure directly and the person enters Arabic manually instead.
async function translateBulletsToArabic(lines) {
  if (!aiService.isConfigured()) {
    const e = new Error("AI translation isn't configured on this server (GEMINI_API_KEY not set) — enter the Arabic text manually.");
    e.status = 400;
    throw e;
  }
  const translated = await aiService.translateToArabic(lines); // AIError propagates as-is (has .status) on failure
  if (!Array.isArray(translated) || translated.length !== lines.length) {
    const e = new Error("The AI translation response didn't match the number of English bullets — try again.");
    e.status = 502;
    throw e;
  }
  return translated.map((t) => String(t || "").trim()).filter(Boolean);
}

module.exports = {
  MAX_BULLET_LEN,
  bulletFallbackLine,
  buildDraftItems,
  mapBulletResponse,
  linesToBullets,
  draftEnglishBullets,
  translateBulletsToArabic,
};
