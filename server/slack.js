// Posts messages to Slack through an Incoming Webhook (no new dependency —
// Node's built-in fetch). The webhook URL is a secret: it lives only in the
// environment, is never sent to the browser, never logged and never put in an
// error message.
//
//   SLACK_WEBHOOK_URL            the channel the daily reports (and, unless
//                                overridden below, the reminder) are posted to
//   SLACK_REMINDER_WEBHOOK_URL   optional: a different channel for the reminder

const ALLOWED_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
const TIMEOUT_MS = 8000;

// Tests replace this; production always uses the real fetch.
let fetchImpl = (...args) => fetch(...args);
function __setFetch(fn) { fetchImpl = fn || ((...args) => fetch(...args)); }

function webhookUrl(kind) {
  const own = kind === "reminder" ? process.env.SLACK_REMINDER_WEBHOOK_URL : "";
  return String(own || process.env.SLACK_WEBHOOK_URL || "").trim();
}
function isValidWebhook(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.has(u.hostname);
  } catch (_) {
    return false;
  }
}
function isConfigured(kind) {
  return !!webhookUrl(kind);
}

// -> { ok:true } | { ok:false, code, error }
//   code: "not_configured" | "invalid_config" | "timeout" | "network" | "http_<status>"
// `error` is short, human-readable and safe to store and show.
async function sendMessage(text, opts) {
  const url = webhookUrl(opts && opts.kind);
  if (!url) return { ok: false, code: "not_configured", error: "Slack isn’t set up on the server yet (SLACK_WEBHOOK_URL)." };
  if (!isValidWebhook(url)) return { ok: false, code: "invalid_config", error: "The Slack webhook URL on the server isn’t a valid https://hooks.slack.com/… address." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (opts && opts.timeoutMs) || TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text, mrkdwn: true }),
      redirect: "error",
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    let detail = "";
    try { detail = String(await res.text()).replace(/\s+/g, " ").trim().slice(0, 80); } catch (_) {}
    return { ok: false, code: "http_" + res.status, error: "Slack answered " + res.status + (detail ? " (" + detail + ")" : "") + "." };
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: false, code: "timeout", error: "Slack didn’t answer in time." };
    return { ok: false, code: "network", error: "Couldn’t reach Slack." };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, isValidWebhook, sendMessage, __setFetch, ALLOWED_HOSTS };
