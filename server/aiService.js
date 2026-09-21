// A thin client for the Google Gemini API (generativelanguage.googleapis.com)
// — used for exactly one thing: writing the human-readable title/description
// for each Release Notes item. Nothing else in this app calls out to an LLM.
//
// Deliberately narrow, matching this project's existing "thin client" style
// (see jiraClient.js, atlassianOAuth.js): one function in, one function out,
// hand-rolled with the built-in fetch — no SDK dependency added.
//
// IMPORTANT — what this file is not responsible for: it does not decide
// which Release Notes section a ticket belongs in (that's rule-based, see
// releaseNotesLogic.js), and its output is never trusted as fact. The
// caller (routes/releases.js) is responsible for validating every item this
// returns against the real Jira data before using any of it — see the
// "AI response validation" step there. This file only gets you the model's
// raw (parsed) response.

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

// Gemini is asked for application/json output (see generationConfig below),
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

// Returns the model's raw parsed response: an array of whatever-shaped
// objects it produced. Not validated against the real Jira data yet — see
// routes/releases.js for that step. Throws AIError on any failure (network,
// non-2xx, blocked/empty response, unparseable content) — the caller falls
// back to the existing rule-based summarizer rather than surfacing this to
// the user as if the whole feature were broken.
async function generateSummaries(issues) {
  if (!isConfigured()) throw new AIError("AI generation isn't configured (GEMINI_API_KEY not set).", 500);
  if (!issues || !issues.length) return [];

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
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: buildUserMessage(issues) }] }],
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

module.exports = { AIError, isConfigured, generateSummaries, extractJsonArray, PROVIDER_NAME };
