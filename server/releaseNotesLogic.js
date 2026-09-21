// Release Notes — categorization and rule-based summarization.
//
// This is the server-side counterpart of the categorizer that has always
// lived in public/app.js (see summarizeTicket/categorizeTicket there) — same
// regexes, same category names, same "never invent, fall back to a neutral
// honest line" behavior. It's duplicated rather than shared via a module
// because the browser file and this server file can't require() each other,
// but the two must stay in lockstep: if you change the rules here, change
// them there too (and vice versa).
//
// This module answers two questions about a Jira ticket:
//   1. Which Release Notes section does it belong in? (categorizeTicket)
//   2. What's a safe, factual one-line fallback summary if we have nothing
//      better? (ruleBasedSummary) — used when AI generation isn't configured,
//      or as the per-ticket fallback when the AI response for that ticket
//      fails validation (see aiService.js / routes/releases.js).
//
// Categorization is deliberately never done by AI (see routes/releases.js) —
// it's rule-based only, so a ticket's section placement can't drift based on
// model output.
//
// generateReleaseNotes() (bottom of this file) is the ONLY seam between
// Release Notes and AI. routes/releases.js calls that one function and
// nothing else AI-related — it never imports aiService.js or knows what
// provider (if any) is behind it. aiService.js is the one place that talks
// to an actual AI provider and the one place provider config (today: a
// single Gemini API key) lives; swapping providers, or running with none
// configured at all, never touches this file or routes/releases.js.

const aiService = require("./aiService"); // the configured AI provider — see generateReleaseNotes() below for the only place this is used

const TICKET_BUGFIX_RE = /\b(fix(?:e[sd])?|bug|crash(?:e[sd])?|error|defect|broken|fails?|failure)\b/i;
const TICKET_FEATURE_RE = /\b(add(?:s|ed)?|new|introduc(?:e|es|ed)|support(?:s|ed)? for|enable[sd]?|allow[sd]?)\b/i;
const TICKET_IMPROVEMENT_RE = /\b(improv(?:e|ed|es|ement)|updat(?:e|ed|es)|enhanc(?:e|ed|es|ement)|optimiz(?:e|ed|es)|refactor(?:ed|s)?)\b/i;
// Lines that are almost always ticket scaffolding rather than a description
// of the change itself — acceptance-criteria/step lists, not prose.
const BOILERPLATE_LINE_RE = /^(given|when|then|and)\b|^(ac|acceptance criteria|steps to reproduce|expected result|actual result)\s*[:\-]|^\d+[.)]\s|^[-*•]\s/i;

const CATEGORIES = ["New Feature", "Improvement", "Bug Fix", "Other"];

function categorizeTicket(t) {
  const type = String((t && t.issueType) || "").toLowerCase();
  if (type.indexOf("bug") > -1) return "Bug Fix";
  if (type.indexOf("story") > -1 || type.indexOf("feature") > -1 || type.indexOf("epic") > -1) return "New Feature";
  if (type.indexOf("improvement") > -1 || type.indexOf("enhancement") > -1) return "Improvement";
  // Generic issue types (Task, etc.) — fall back to reading the ticket's own
  // content, since it's often a better signal than a catch-all issue type.
  const text = [t && t.title, t && t.description].filter(Boolean).join(" ");
  if (TICKET_BUGFIX_RE.test(text)) return "Bug Fix";
  if (TICKET_FEATURE_RE.test(text)) return "New Feature";
  if (TICKET_IMPROVEMENT_RE.test(text)) return "Improvement";
  return "Other";
}

function stripBoilerplateLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !BOILERPLATE_LINE_RE.test(l))
    .join(" ");
}

function firstSentences(text, maxSentences, maxChars) {
  const cleaned = stripBoilerplateLines(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const parts = cleaned.match(/[^.!?]+[.!?]+/g) || [cleaned];
  let out = parts.slice(0, maxSentences).join(" ").trim();
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
  return out;
}

function ticketFallbackSentence(t, category) {
  const subject = String((t && (t.title || t.key)) || "this ticket").replace(/^\s*the\s+/i, "");
  if (category === "Bug Fix") return "Fixed an issue with " + subject + ".";
  if (category === "New Feature") return "Added " + subject + ".";
  if (category === "Improvement") return "Improvement to " + subject + ".";
  return "Update to " + subject + ".";
}

// One short, human sentence per ticket — never copies the raw Jira
// description verbatim, never invents functionality that isn't there. This
// is the non-AI path: pure extraction (first sentence(s) already present in
// the ticket) plus a neutral fallback, nothing generated.
function ruleBasedSummary(t) {
  const category = categorizeTicket(t);
  const source = (t && (t.description || t.recentComments)) || "";
  let sentence = firstSentences(source, 2, 220);
  if (!sentence || sentence.length < 12) sentence = ticketFallbackSentence(t, category);
  return { category, title: t && t.title ? t.title : t && t.key, description: sentence };
}

// ---- Validation pipeline (see routes/releases.js for where this is used) --

// De-dupes by Jira key, keeping the first occurrence. Jira's own search
// shouldn't return the same key twice, but this makes that assumption
// explicit rather than silently trusting it.
function dedupeByKey(tickets) {
  const seen = new Set();
  const out = [];
  for (const t of tickets || []) {
    if (!t || !t.key || seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(t);
  }
  return out;
}

function sanitizeGeneratedText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen || 300);
}

// ---- AI response validation + mapping back onto Jira issues --------------
//
// Pulled out of routes/releases.js so it's directly unit-testable without a
// live model call. Given the categorized ticket list and the AI's raw
// (parsed) response, this:
//   - verifies every generated item has a valid source Jira issue
//   - verifies that issue exists in the original input (validKeys)
//   - rejects/removes any invented Jira issue key
//   - never accepts factual metadata from the AI response — only "title"
//     and "description" are ever read off an entry
//   - falls back to the existing rule-based summary, per ticket, for
//     anything AI didn't validly cover
//
// `categorized` is [{ticket, category}, ...] (see categorizeTicket above).
// `rawAiResponse` is whatever generateSummaries() returned — untrusted,
// possibly not even an array.
function mapAiResponseToItems(categorized, rawAiResponse) {
  const crypto = require("crypto");
  const validKeys = new Set(categorized.map((c) => c.ticket.key));
  const aiByKey = new Map();
  if (Array.isArray(rawAiResponse)) {
    for (const entry of rawAiResponse) {
      if (!entry || typeof entry !== "object") continue;
      const key = entry.key;
      if (!key || !validKeys.has(key)) continue; // invented/unknown key — reject
      const title = sanitizeGeneratedText(entry.title, 200);
      const description = sanitizeGeneratedText(entry.description, 600);
      if (!title || !description) continue; // incomplete — falls back below
      aiByKey.set(key, { title, description });
    }
  }

  let fallbackCount = 0;
  const items = categorized.map(({ ticket, category }) => {
    const ai = aiByKey.get(ticket.key);
    let title, description, engine;
    if (ai) {
      title = ai.title;
      description = ai.description;
      engine = aiService.PROVIDER_NAME || "ai"; // whichever provider aiService.js is actually configured for — never hardcoded here
    } else {
      const rb = ruleBasedSummary(ticket);
      title = rb.title;
      description = rb.description;
      engine = "rule_based";
      fallbackCount++;
    }
    return {
      id: crypto.randomUUID(),
      category,
      title,
      description,
      sourceKey: ticket.key, // factual — always from the Jira ticket, never AI
      sourceUrl: ticket.url, // factual
      issueType: ticket.issueType, // factual
      status: ticket.status, // factual
      priority: ticket.priority, // factual
      origin: "AI_GENERATED", // see engine for claude vs rule_based; MANUALLY_ADDED/MANUALLY_EDITED are set elsewhere (routes/releases.js, app.js handleSaveNotes)
      engine,
    };
  });

  return { items, aiUsedCount: aiByKey.size, fallbackCount };
}

// ---- generateReleaseNotes(jiraIssues) — the provider-agnostic entry point
// ----------------------------------------------------------------------
//
// This is the abstraction routes/releases.js calls — the entire boundary
// between "Release Notes" and "AI". It decides whether to attempt AI at
// all (aiService.isConfigured()), calls it, validates the response, and
// always falls back to the safe rule-based summary for anything AI didn't
// cover — the caller gets back finished, already-validated items either
// way and never has to know or care which of those paths ran.
//
// `jiraIssues` is [{ticket, category}, ...] — already fetched from Jira and
// categorized by the caller (categorizeTicket, above; categorization always
// happens before this call, never inside it, and is never redone by AI).
//
// Returns { items, aiConfigured, aiUsed, aiUsedCount, fallbackCount, warnings }.
async function generateReleaseNotes(jiraIssues) {
  const aiConfigured = aiService.isConfigured();
  let rawAiResponse = null;
  let aiErrorMessage = null;

  if (aiConfigured && jiraIssues.length) {
    // ---- Prepare structured data + send only what's required to the AI --
    const payload = jiraIssues.map(({ ticket }) => ({
      key: ticket.key,
      issueType: ticket.issueType,
      status: ticket.status,
      title: ticket.title,
      description: (ticket.description || "").slice(0, 1000),
      recentComments: (ticket.recentComments || "").slice(0, 600),
    }));
    try {
      rawAiResponse = await aiService.generateSummaries(payload);
      if (!Array.isArray(rawAiResponse)) {
        aiErrorMessage = "The AI response wasn't a list of issues — used the existing rule-based summaries instead.";
        rawAiResponse = null;
      }
    } catch (e) {
      // Network/parse/API/config failure — every ticket falls back to the
      // rule-based summary below; the caller surfaces this via `warnings`
      // (the existing toast pattern) instead of treating the whole feature
      // as broken.
      aiErrorMessage = (e && e.message) || "AI generation failed — used the existing rule-based summaries instead.";
    }
  }

  // ---- Validate AI response + map generated content back to Jira issues,
  // falling back per-ticket for anything AI didn't validly cover ---------
  const mapped = mapAiResponseToItems(jiraIssues, rawAiResponse);
  const fallbackCount = aiConfigured ? mapped.fallbackCount : 0;

  const warnings = [];
  if (aiErrorMessage) warnings.push(aiErrorMessage);
  if (aiConfigured && fallbackCount && !aiErrorMessage) {
    warnings.push(
      fallbackCount +
        " ticket" +
        (fallbackCount === 1 ? "" : "s") +
        " fell back to the existing rule-based summary (the AI response for " +
        (fallbackCount === 1 ? "it" : "them") +
        " was missing or invalid)."
    );
  }

  return {
    items: mapped.items,
    aiConfigured,
    aiUsed: mapped.aiUsedCount > 0,
    aiUsedCount: mapped.aiUsedCount,
    fallbackCount,
    warnings,
  };
}

module.exports = {
  CATEGORIES,
  categorizeTicket,
  firstSentences,
  stripBoilerplateLines,
  ticketFallbackSentence,
  ruleBasedSummary,
  dedupeByKey,
  mapAiResponseToItems,
  generateReleaseNotes,
};
