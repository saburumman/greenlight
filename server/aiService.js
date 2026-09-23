// A thin client for the Google Gemini API (generativelanguage.googleapis.com)
// — used for three things, each with its own system prompt: writing the
// human-readable title/description for each Release Notes item
// (generateSummaries), drafting short store-facing bullets for the Mobile
// Release Note section (generateMobileBullets), and translating those
// bullets to Arabic (translateToArabic). Nothing else in this app calls out
// to an LLM.
//
// Deliberately narrow, matching this project's existing "thin client" style
// (see jiraClient.js, atlassianOAuth.js): one function in, one function out
// per task, hand-rolled with the built-in fetch — no SDK dependency added.
// All three share one request/response plumbing function (callGemini,
// below) — only the system prompt and the input payload differ.
//
// IMPORTANT — what this file is not responsible for: it does not decide
// which Release Notes section a ticket belongs in (that's rule-based, see
// releaseNotesLogic.js), and its output is never trusted as fact. The
// caller (routes/releases.js, via releaseNotesLogic.js /
// mobileReleaseNoteLogic.js) is responsible for validating every item this
// returns before using any of it — see the "AI response validation" steps
// there. This file only gets you the model's raw (parsed) response.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// NOTE: "gemini-3.6-flash" was requested directly — Google's model ids change
// over time and this one wasn't something this app could verify against
// Google's docs at the time it was wired up. If the API starts rejecting it
// with a 404/"model not found", set GEMINI_MODEL in .env to whatever the
// current valid id is (check https://ai.google.dev/gemini-api/docs/models) —
// no code change needed either way.
const DEFAULT_MODEL = "gemini-3.6-flash";
const MAX_OUTPUT_TOKENS = 4096;
// Which provider this file is actually wired to right now — read by
// releaseNotesLogic.js only to label a generated item's provenance
// (item.engine), never used to decide any behavior. This is the one place
// that name lives; nothing else in the app should hardcode a provider name.
const PROVIDER_NAME = "gemini";

class AIError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AIError";
    this.status = status || 502;
  }
}

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

// ---- Shared Gemini request/response plumbing — used by all three tasks
// below. Always asks for application/json output and returns the parsed
// top-level JSON value (array, in every current use). Throws AIError on any
// failure (network, non-2xx, blocked/empty response, unparseable content);
// every caller in this file lets that propagate to its own caller, which
// falls back to a rule-based path where one exists (generateSummaries,
// generateMobileBullets) or surfaces the error directly where none does
// (translateToArabic — see mobileReleaseNoteLogic.js).
async function callGemini(systemPrompt, userMessage) {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
        },
      }),
    });
  } catch (e) {
    throw new AIError(`Couldn't reach the AI service (${e.message}).`, 502);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = (body.error && body.error.message) || "";
    } catch (_) {}
    throw new AIError(`AI service returned an error (${res.status})${detail ? ": " + detail : "."}`, res.status);
  }

  const data = await res.json();
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
  if (!candidate) {
    const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
    throw new AIError(`The AI returned no response${blockReason ? " (" + blockReason + ")" : ""}.`);
  }
  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.map((p) => p.text || "").join("");
  if (!text) throw new AIError("The AI response had no text content.");

  return extractJsonArray(text);
}

// Gemini is asked for application/json output (see generationConfig above),
// but this stays defensive in case a model/version wraps it in prose or a
// ```json fence anyway — pull out the first top-level [...] block rather
// than failing outright on otherwise-good output.
function extractJsonArray(text) {
  const trimmed = String(text || "").trim();
  try {
    const direct = JSON.parse(trimmed);
    if (Array.isArray(direct)) return direct;
  } catch (_) {
    // fall through to bracket extraction
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new AIError("The AI response wasn't valid JSON.");
  }
  const slice = trimmed.slice(start, end + 1);
  const parsed = JSON.parse(slice); // let a real parse error propagate/throw
  if (!Array.isArray(parsed)) throw new AIError("The AI response wasn't a JSON array.");
  return parsed;
}

// ---- Release Notes summaries (existing feature, unchanged behavior) ------

const SYSTEM_PROMPT = `You write short, business-friendly Release Notes entries from Jira issue data for a QA release-readiness tool.

You will be given a JSON array of Jira issues. For EVERY issue in the array, return one object with exactly these three fields:
- "key": the issue's Jira key, copied EXACTLY as given — never alter it.
- "title": a short, plain-English title for the release note (a few words, not a sentence).
- "description": 1-2 short sentences summarizing the change for a business reader.

Strict rules:
- Summarize and rephrase — never copy long stretches of the Jira description verbatim.
- Use clear, business-friendly language. Avoid technical implementation details (code, internal method/class names, file paths, database tables) unless the detail is directly relevant to what changed for a user.
- Never invent functionality, behavior, or user impact that isn't stated in the supplied issue data. If the issue gives you little to go on, write a short, honest, generic line about the ticket's own title instead of guessing what it does.
- Never invent or restate factual metadata (status, priority, issue type, dates, people, other ticket keys) as if it were part of the description — those fields are handled separately and are not your job.
- Return content only for issues actually present in the input. Do not add issues, and do not skip any.
- Output ONLY a raw JSON array of objects with exactly the fields "key", "title", "description" — no surrounding prose, no markdown code fences, no extra fields.`;

function buildUserMessage(issues) {
  // Only what the model needs to write a summary — no URLs, no internal ids,
  // nothing that isn't either context for the summary or the key needed to
  // map the response back (see routes/releases.js for why: "send only
  // required data to the AI").
  const payload = issues.map((i) => ({
    key: i.key,
    issueType: i.issueType || "",
    status: i.status || "",
    title: i.title || "",
    description: i.description || "",
    recentComments: i.recentComments || "",
  }));
  return (
    "Here are the Jira issues. Return the JSON array described in your instructions, one entry per issue, in any order:\n\n" +
    JSON.stringify(payload, null, 2)
  );
}

// Returns the model's raw parsed response: an array of whatever-shaped
// objects it produced. Not validated against the real Jira data yet — see
// routes/releases.js for that step. Throws AIError on any failure — the
// caller falls back to the existing rule-based summarizer rather than
// surfacing this to the user as if the whole feature were broken.
async function generateSummaries(issues) {
  if (!isConfigured()) throw new AIError("AI generation isn't configured (GEMINI_API_KEY not set).", 500);
  if (!issues || !issues.length) return [];
  return callGemini(SYSTEM_PROMPT, buildUserMessage(issues));
}

// ---- Mobile Release Note — short store-facing bullets (new) --------------
//
// A deliberately different task from generateSummaries above: this writes
// ONE short, end-user-facing bullet per item, in the terse style an App
// Store / Play Store "What's New" listing uses — not the 1-2 sentence,
// internal-audience-friendly description Release Notes writes. See
// server/mobileReleaseNoteLogic.js for the caller (the only place that
// invokes this) and its rule-based fallback for when AI isn't configured or
// fails.

const MOBILE_BULLET_SYSTEM_PROMPT = `You write short "What's New" bullets for a mobile app's App Store / Play Store release notes, from data already prepared by an internal QA tool.

You will be given a JSON array of items, each already categorized as "New Feature", "Improvement", "Bug Fix", or "Other", with a title and description already written for an internal audience.

For EVERY item in the array, return one object with exactly these two fields:
- "key": the item's key, copied EXACTLY as given — never alter it.
- "bullet": ONE short bullet line (no more than about 90 characters), written for an end user reading the app's store listing — plain, positive, customer-facing language. No ticket keys, no internal jargon, no Jira terminology, no leading bullet character ("•") or number — just the sentence itself. Do NOT prefix it with a label like "New:", "Improved:", or "Fixed:" — describe the change directly, the way a real store listing reads.

Strict rules:
- Never invent functionality, behavior, or user impact beyond what the supplied title/description already say.
- A change can be phrased as an improvement ("Improved X") if that reads more naturally for end users, as long as it doesn't overstate what changed — but do not use it, or any other word, as a leading label followed by a colon.
- The supplied title/description may be written in Arabic, English, or a mix of both (this QA tool's tickets are often titled in Arabic). Regardless of the source language, write the "bullet" in English only, in your own plain words — never include any Arabic script, transliterate it, or copy it as-is. If a title is entirely in Arabic and you cannot tell what it means, write a short, honest, generic English line rather than including any of the original Arabic text.
- Return content only for items actually present in the input. Do not add items, and do not skip any.
- Output ONLY a raw JSON array of objects with exactly the fields "key", "bullet" — no surrounding prose, no markdown code fences, no extra fields.`;

function buildMobileBulletUserMessage(items) {
  const payload = items.map((i) => ({
    key: i.key,
    category: i.category || "",
    title: i.title || "",
    description: i.description || "",
  }));
  return (
    "Here are the items. Return the JSON array described in your instructions, one entry per item, in any order:\n\n" +
    JSON.stringify(payload, null, 2)
  );
}

// Returns the model's raw parsed [{key, bullet}, ...] response — not
// validated against the real item list yet, see
// mobileReleaseNoteLogic.mapBulletResponse for that step. Throws AIError on
// any failure; the caller falls back to a simple rule-based bullet per item.
async function generateMobileBullets(items) {
  if (!isConfigured()) throw new AIError("AI generation isn't configured (GEMINI_API_KEY not set).", 500);
  if (!items || !items.length) return [];
  return callGemini(MOBILE_BULLET_SYSTEM_PROMPT, buildMobileBulletUserMessage(items));
}

// ---- Arabic translation for the Mobile Release Note (new) ----------------
//
// Pure translation of whatever English bullets are currently in the
// textarea (already reviewed/edited by a person, not necessarily the raw AI
// draft) — see mobileReleaseNoteLogic.translateBulletsToArabic. Unlike the
// two functions above, there is no safe rule-based fallback for a
// translation, so this is only ever called when isConfigured() is true;
// the caller is responsible for checking that first and giving the user a
// clear "enter it manually" message otherwise.

const TRANSLATE_AR_SYSTEM_PROMPT = `You translate short mobile app "What's New" release-note bullets from English to Arabic, for an App Store / Play Store submission.

You will be given a JSON array of English strings, each one bullet line, in order.

Return a JSON array of strings — the Arabic translation of each bullet, in the SAME order, with EXACTLY the same number of entries as the input. Each translation should read naturally as app-store release-note copy: concise, plain, customer-facing Modern Standard Arabic — not a literal word-for-word translation. Do not add a leading bullet character ("•"), numbering, or any English text. Do not merge, split, skip, or reorder entries.

Output ONLY the raw JSON array of strings — no surrounding prose, no markdown code fences.`;

function buildTranslateUserMessage(lines) {
  return "Here are the English bullets to translate:\n\n" + JSON.stringify(lines, null, 2);
}

// Returns the model's raw parsed array of strings — length/order validated
// by the caller (mobileReleaseNoteLogic.translateBulletsToArabic), not here.
async function translateToArabic(lines) {
  if (!isConfigured()) throw new AIError("AI translation isn't configured (GEMINI_API_KEY not set).", 500);
  if (!lines || !lines.length) return [];
  return callGemini(TRANSLATE_AR_SYSTEM_PROMPT, buildTranslateUserMessage(lines));
}

module.exports = {
  AIError,
  isConfigured,
  generateSummaries,
  generateMobileBullets,
  translateToArabic,
  extractJsonArray,
  PROVIDER_NAME,
};
