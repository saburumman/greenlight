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
// isn't configured (or fails). No account/API key required. The anonymous
// tier is capped at ~5,000 words/day per IP, which a day of testing can
// burn through on its own; MyMemory raises that cap for a request that
// includes a contact email (`de=`, used only so they can reach someone in
// case of abuse — never shown to end users or stored by this app beyond
// the request itself). MYMEMORY_CONTACT_EMAIL sets that email; unset,
// requests go out anonymous-tier as before, still perfectly usable, just
// with a lower daily ceiling. One request per line — there's no batch
// endpoint — done sequentially since these bullet lists are always short
// (a handful of lines) and this is a background action the person already
// expects to wait a moment for.
const FREE_TRANSLATE_URL = "https://api.mymemory.translated.net/get";
const FREE_TRANSLATE_CONTACT_EMAIL = process.env.MYMEMORY_CONTACT_EMAIL || "";

async function translateLineFree(line) {
  const params = { q: line, langpair: "en|ar" };
  if (FREE_TRANSLATE_CONTACT_EMAIL) params.de = FREE_TRANSLATE_CONTACT_EMAIL;
  const url = `${FREE_TRANSLATE_URL}?${new URLSearchParams(params).toString()}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`couldn't reach the free translation service (${e.message})`);
  }
  if (res.status === 429) {
    throw new Error("free translation service's daily quota is used up for now — try again later, or enter the Arabic text manually");
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

// Arabic script ranges (main block + presentation forms/ligatures) — used
// only to decide whether a bullet needs the English cleanup pass below, not
// as a language-detection tool in general.
const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
function containsArabic(s) {
  return ARABIC_RE.test(String(s || ""));
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
// one outlier costs at most itself, not the rest of the list.
//
// `metas`, if given, is a same-length array carried alongside `bullets`
// (e.g. the source item behind each English bullet) — whatever's dropped
// gets its matching entry returned in `droppedMetas`, so a caller can show
// exactly *what* was left out, not just how many. Returns
// { kept, dropped, droppedCount, droppedMetas }.
function keepWithinBlockLimit(bullets, limit, metas) {
  const kept = [];
  const dropped = [];
  const droppedMetas = [];
  let total = 0;
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    const addLen = b.length + (kept.length ? 1 : 0); // +1 for the joining "\n"
    if (total + addLen > limit) {
      // doesn't fit — skip it, keep checking the rest
      dropped.push(b);
      if (metas) droppedMetas.push(metas[i]);
      continue;
    }
    kept.push(b);
    total += addLen;
  }
  return { kept, dropped, droppedCount: dropped.length, droppedMetas };
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

// Non-AI fallback: one plain sentence per item, built straight from its
// title — same honest, never-invented spirit as
// releaseNotesLogic.ticketFallbackSentence, just shorter and in
// store-bullet phrasing rather than Jira-ticket phrasing. No "New:" /
// "Improved:" / "Fixed:" label is added — just the change itself, since a
// store listing reads as plain bullets, not a categorized internal log
// (category is still tracked on the item for other features; it's simply
// not printed here).
function bulletFallbackLine(item) {
  const title = String((item && item.title) || "this change").replace(/\.$/, "");
  return truncate(title + ".", MAX_BULLET_LEN);
}

// A single Arabic-script "word" — one or more Arabic letters/diacritics
// with no whitespace inside — plus any punctuation immediately touching it
// (quotes, parentheses, dashes, commas). Matches greedily so a whole
// Arabic phrase like "بطاقة الموظف" (two words separated by one space) is
// removed as a unit, not word-by-word, and any wrapping quote marks or
// parentheses that only ever enclosed Arabic text go with it.
const ARABIC_PHRASE_RE =
  /["'“”‘’(]*[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿][؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿\s.,،؛?!)"'“”‘’-]*/g;

// Ensures every bullet in the English box is actually English. This app's
// Jira tickets are often titled in Arabic (or a mix of Arabic and English),
// and bulletFallbackLine above just echoes the ticket's own title verbatim
// — so without this, a ticket titled in Arabic would land in the English
// textarea as-is. Gemini is separately instructed to write its bullet in
// English only (see MOBILE_BULLET_SYSTEM_PROMPT in aiService.js), so in
// practice this mainly catches the non-AI fallback path and anything
// Gemini missed — but it's applied uniformly, after either path, so the
// English box is guaranteed Arabic-free regardless of how a bullet was
// produced.
//
// This removes Arabic text rather than translating it: earlier this ran
// the Arabic-only portion through the free MyMemory translator, but that
// depends on reaching an outside service (unreliable from some hosts) and
// on there being any text left to have a meaning worth preserving once a
// ticket title is stripped down to its Arabic half. Deterministic removal
// has no such dependency and always produces something clean; nothing
// else about a bullet's English portion is touched. Returns
// { bullets, strippedCount }.
function ensureEnglishBullets(bullets) {
  const out = [];
  let strippedCount = 0;
  for (const b of bullets) {
    if (!containsArabic(b)) {
      out.push(b);
      continue;
    }
    const cleaned = String(b)
      .replace(ARABIC_PHRASE_RE, " ")
      // leftover empty pairs/brackets and stray punctuation the removal can leave behind
      .replace(/\(\s*\)/g, "")
      .replace(/\{\s*\}/g, "")
      .replace(/["“”‘’]\s*["“”‘’]/g, "")
      .replace(/\s+([.,;:!?])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s\-–—]+|[\s\-–—]+$/g, "")
      .trim();
    const withEnding = cleaned && !/[.!?]$/.test(cleaned) ? cleaned + "." : cleaned;
    out.push(withEnding || "this change.");
    strippedCount++;
  }
  return { bullets: out, strippedCount };
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
    return { bullets: [], aiUsed: false, warning: null, droppedItems: [], empty: true };
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

  const englishResult = ensureEnglishBullets(bullets);
  if (englishResult.strippedCount) {
    const n = englishResult.strippedCount;
    warning = combineWarnings(
      warning,
      `${n} bullet${n === 1 ? "" : "s"} came from an Arabic ticket title and had the Arabic text removed — give ${n === 1 ? "it" : "them"} a look, since the English that's left is only whatever was already in the title.`
    );
  }

  // items stays index-aligned with englishResult.bullets the whole way
  // through (bulletFallbackLine/mapBulletResponse and ensureEnglishBullets
  // both preserve order and produce exactly one bullet per item), so it can
  // be passed straight through as keepWithinBlockLimit's `metas` — whatever
  // gets dropped for length comes back paired with the ticket it came from,
  // for the caller (routes/releases.js, then the UI) to name explicitly
  // rather than just saying "N bullets left out".
  const { kept, droppedMetas } = keepWithinBlockLimit(englishResult.bullets, MAX_BLOCK_LEN, items);
  const droppedItems = droppedMetas.map((it) => ({ key: it && it.key, title: it && it.title }));
  return {
    bullets: kept,
    aiUsed,
    warning: combineWarnings(warning, blockLimitWarning(droppedItems.length)),
    droppedItems,
    empty: false,
  };
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
// English side's own limit. `droppedLines` (part of the same trim) carries
// the original English text of whatever got left out, so the caller can
// say exactly which bullet has no Arabic yet rather than just a count.

// Pairs each translated line with the English source line it came from,
// dropping only the (rare) case where a translator returned nothing for a
// line — keeps the two arrays aligned even though a raw translator
// response can come back shorter than what went in.
function zipNonEmpty(sourceLines, rawTranslated) {
  const lines = [];
  const sources = [];
  rawTranslated.forEach((t, i) => {
    const trimmed = String(t || "").trim();
    if (trimmed) {
      lines.push(trimmed);
      sources.push(sourceLines[i]);
    }
  });
  return { lines, sources };
}

async function translateBulletsToArabic(lines) {
  let translatedLines = null;
  let sourceLines = null;
  let engine = null;

  if (aiService.isConfigured()) {
    try {
      const translated = await aiService.translateToArabic(lines);
      if (Array.isArray(translated) && translated.length === lines.length) {
        const z = zipNonEmpty(lines, translated);
        translatedLines = z.lines;
        sourceLines = z.sources;
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
      const raw = await translateLinesFree(lines);
      const z = zipNonEmpty(lines, raw);
      translatedLines = z.lines;
      sourceLines = z.sources;
      engine = "mymemory";
    } catch (e) {
      const err = new Error(`Couldn't translate automatically (${(e && e.message) || "unknown error"}) — enter the Arabic text manually.`);
      err.status = 502;
      throw err;
    }
  }

  const { kept, droppedMetas } = keepWithinBlockLimit(translatedLines, MAX_BLOCK_LEN, sourceLines);
  return { lines: kept, engine, warning: blockLimitWarning(droppedMetas.length), droppedLines: droppedMetas };
}

module.exports = {
  MAX_BULLET_LEN,
  MAX_BLOCK_LEN,
  keepWithinBlockLimit,
  containsArabic,
  ensureEnglishBullets,
  bulletFallbackLine,
  buildDraftItems,
  mapBulletResponse,
  linesToBullets,
  draftEnglishBullets,
  translateBulletsToArabic,
};
