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
// configured or fails. Arabic translation prefers Gemini when
// GEMINI_API_KEY is set (better phrasing, same as the rest of this app),
// but always has a real fallback too — MyMemory's free, keyless translation
// API (see translateLinesFree below) — so translation works out of the box
// with no API key at all; see translateBulletsToArabic for the order this
// tries things in.

const aiService = require("./aiService");
const releaseNotesLogic = require("./releaseNotesLogic");

// MyMemory (https://mymemory.translated.net) — a free, keyless machine
// translation API used only as the Arabic-translation fallback when Gemini
// isn't configured (or fails). No account/API key required; the anonymous
// tier is rate-limited (a few thousand words/day per IP) but more than
// enough for a handful of release-note bullets. One request per line —
// there's no batch endpoint — done sequentially since these bullet lists
// are always short (a handful of lines) and this is a background action the
// person already expects to wait a moment for.
const FREE_TRANSLATE_URL = "https://api.mymemory.translated.net/get";

async function translateLineFree(line) {
  const url = `${FREE_TRANSLATE_URL}?${new URLSearchParams({ q: line, langpair: "en|ar" }).toString()}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`couldn't reach the free translation service (${e.message})`);
  }
  if (!res.ok) throw new Error(`free translation service returned an error (${res.status})`);
  const data = await res.json();
  const text = data && data.responseData && data.responseData.translatedText;
  if (!text || (data.responseStatus && Number(data.responseStatus) >= 400)) {
    throw new Error("free translation service returned no usable text");
  }
  return String(text).trim();
}

async function translateLinesFree(lines) {
  const out = [];
  for (const line of lines) {
    out.push(await translateLineFree(line));
  }
  return out;
}

const MAX_BULLET_LEN = 110;
// Google Play's "What's new" field (and, comfortably, Apple's App Store
// "What's New in This Version") caps store release-note text per language
// at 500 characters — this app enforces the same limit on the *whole*
// joined block per language (all bullets + the newlines between them), not
// per bullet. public/app.js hardcodes the same number as MOBILE_NOTE_MAX_LEN
// for the client-side character counter and the textareas' maxlength — keep
// both in sync if this ever changes.
const MAX_BLOCK_LEN = 500;

function truncate(s, max) {
  s = String(s || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// Keeps as many whole bullets as fit — in their original relative order —
// within `limit` total characters counting the "\n" that joins them (the
// same way a plain textarea's .value.length, and the store's own text
// field, counts it). Never truncates a bullet mid-sentence: one that
// wouldn't fit is skipped whole, not cut short, so what's left always reads
// as complete sentences. A skip doesn't stop the scan — a single unusually
// long bullet (most often a longer Arabic translation of a short English
// line) is passed over rather than cutting off every bullet after it, so
// one outlier costs at most itself, not the rest of the list. Returns
// { kept, droppedCount }.
function keepWithinBlockLimit(bullets, limit) {
  const kept = [];
  let total = 0;
  for (const b of bullets) {
    const addLen = b.length + (kept.length ? 1 : 0); // +1 for the joining "\n"
    if (total + addLen > limit) continue; // doesn't fit — skip it, keep checking the rest
    kept.push(b);
    total += addLen;
  }
  return { kept, droppedCount: bullets.length - kept.length };
}

function blockLimitWarning(droppedCount) {
  if (!droppedCount) return null;
  return `${droppedCount} bullet${droppedCount === 1 ? "" : "s"} left out to stay within the store's ${MAX_BLOCK_LEN}-character-per-language limit — add ${droppedCount === 1 ? "it" : "them"} back by hand if you have room, or trim the others first.`;
}

// Combines two possibly-null warning strings into one (or null) — used
// where a result can carry both an AI-fallback warning and a block-limit
// warning at the same time.
function combineWarnings(a, b) {
  return [a, b].filter(Boolean).join(" ") || null;
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

  let bullets, aiUsed, warning;
  if (!aiService.isConfigured()) {
    bullets = items.map(bulletFallbackLine);
    aiUsed = false;
    warning = null;
  } else {
    try {
      const raw = await aiService.generateMobileBullets(items);
      bullets = mapBulletResponse(items, raw);
      aiUsed = true;
      warning = null;
    } catch (e) {
      bullets = items.map(bulletFallbackLine);
      aiUsed = false;
      warning = (e && e.message) || "AI drafting failed — used simple bullets from the ticket titles instead.";
    }
  }

  const { kept, droppedCount } = keepWithinBlockLimit(bullets, MAX_BLOCK_LEN);
  return { bullets: kept, aiUsed, warning: combineWarnings(warning, blockLimitWarning(droppedCount)), empty: false };
}

// The single seam for Arabic translation. Tries Gemini first when
// GEMINI_API_KEY is configured (better, more natural phrasing — same model
// used everywhere else in this app); on any failure there — or when it
// isn't configured at all — falls back to the free, keyless MyMemory API
// above, so translation always produces something rather than requiring an
// API key. Only throws (with a status) if BOTH paths fail, at which point
// there's genuinely nothing to offer and the caller (routes/releases.js)
// surfaces the failure so the person can enter Arabic manually instead.
// Returns { lines, engine, warning } — engine is "gemini" or "mymemory", so
// the caller/UI can tell the person which one actually produced the text
// (worth knowing: MyMemory's phrasing is rougher than Gemini's and deserves
// a closer review pass before it goes into a store submission). `warning`
// is set when the translated block had to be trimmed to fit MAX_BLOCK_LEN
// (see keepWithinBlockLimit) — translated text can run longer or shorter
// than the English it came from, so this is checked independently of the
// English side's own limit.
async function translateBulletsToArabic(lines) {
  let translatedLines = null;
  let engine = null;

  if (aiService.isConfigured()) {
    try {
      const translated = await aiService.translateToArabic(lines);
      if (Array.isArray(translated) && translated.length === lines.length) {
        translatedLines = translated.map((t) => String(t || "").trim()).filter(Boolean);
        engine = "gemini";
      }
      // else: malformed (wrong length) response — fall through to the free
      // translator below rather than failing outright.
    } catch (e) {
      // AI call failed — fall through to the free translator below.
    }
  }

  if (!translatedLines) {
    try {
      translatedLines = (await translateLinesFree(lines)).map((t) => String(t || "").trim()).filter(Boolean);
      engine = "mymemory";
    } catch (e) {
      const err = new Error(`Couldn't translate automatically (${(e && e.message) || "unknown error"}) — enter the Arabic text manually.`);
      err.status = 502;
      throw err;
    }
  }

  const { kept, droppedCount } = keepWithinBlockLimit(translatedLines, MAX_BLOCK_LEN);
  return { lines: kept, engine, warning: blockLimitWarning(droppedCount) };
}

module.exports = {
  MAX_BULLET_LEN,
  MAX_BLOCK_LEN,
  keepWithinBlockLimit,
  bulletFallbackLine,
  buildDraftItems,
  mapBulletResponse,
  linesToBullets,
  draftEnglishBullets,
  translateBulletsToArabic,
};
