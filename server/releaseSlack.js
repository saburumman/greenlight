// The Slack message posted to the QA channel when a release is published.
// Pure (no I/O): routes/releases.js decides when to send it and slack.js sends it.
//
//   🚀 Release Published · <name> <version>
//   ━━━━━━━━━━━━━━━━━━━━━━
//   Recommendation: ✅ GO
//   Release date: 4 Nov 2026
//   Published by: Sara
//   Tickets: 12 · Regression: 40 pass, 1 warning, 0 fail, 2 not tested
//   Open blockers: 0 · Open bugs: 2
//   <link|Open in Greenlight>
//
// Everything that came from a person (release name, version, names) is escaped
// so it can't ping the channel (<!channel>) or smuggle in a link.

const { escapeSlack } = require("./dailyReportLogic");

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━";
const DEFAULT_APP_URL = "https://greenlight-0foe.onrender.com";

// A publish is "new" when the saved release carries a publish stamp that the
// stored one didn't have, or a different one (re-publish refreshes `at`).
function isNewPublish(before, after) {
  const a = after && after.published && after.published.at;
  if (!a) return false;
  const b = before && before.published && before.published.at;
  return a !== b;
}

function appUrl() {
  const v = String(process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s<>|]+$/i.test(v) ? v : DEFAULT_APP_URL;
}
function releaseLink(release) {
  return appUrl() + "/#/r/" + encodeURIComponent(String((release && release._id) || ""));
}

// Regression rows the same way the app counts them: every service, or the
// entity itself when it has none; SKIP is left out of the totals.
function regressionCounts(release) {
  const c = { PASS: 0, WARNING: 0, FAIL: 0, "NOT TESTED": 0, total: 0 };
  for (const e of Array.isArray(release.regression) ? release.regression : []) {
    if (!e) continue;
    const items = Array.isArray(e.services) && e.services.length ? e.services : [e];
    for (const s of items) {
      if (!s || s.status === "SKIP") continue;
      const st = ["PASS", "WARNING", "FAIL"].includes(s.status) ? s.status : "NOT TESTED";
      c[st] += 1;
      c.total += 1;
    }
  }
  return c;
}

function recommendationLine(rec) {
  const r = String(rec || "").toUpperCase();
  if (r === "GO") return "✅ GO";
  if (r === "CONDITIONAL GO") return "⚠️ CONDITIONAL GO";
  if (r === "NO-GO" || r === "NO GO") return "⛔ NO-GO";
  return rec ? escapeSlack(rec) : "—";
}

function fmtDate(value) {
  const s = String(value || "").trim();
  const d = /^\d{4}-\d{2}-\d{2}/.test(s) ? new Date(s.slice(0, 10) + "T00:00:00Z") : null;
  if (!d || isNaN(d.getTime())) return s ? escapeSlack(s) : "—";
  return d.getUTCDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()] + " " + d.getUTCFullYear();
}

// opts: { actorName, republished }
function buildPublishMessage(release, opts) {
  const r = release || {};
  const o = opts || {};
  const label = [r.name || "Untitled release", r.version].filter(Boolean).join(" ");
  const tickets = Array.isArray(r.tickets) ? r.tickets.length : 0;
  const blockers = (Array.isArray(r.blockers) ? r.blockers : []).filter((b) => b && b.status !== "Resolved").length;
  const bugs = (Array.isArray(r.bugs) ? r.bugs : []).filter((b) => b && b.status === "Open").length;
  const reg = r.regressionSkipped
    ? "skipped"
    : (() => {
        const c = regressionCounts(r);
        return c.total
          ? c.PASS + " pass, " + c.WARNING + " warning, " + c.FAIL + " fail, " + c["NOT TESTED"] + " not tested"
          : "not provided";
      })();
  return [
    (o.republished ? "🔁 *Release Re-published" : "🚀 *Release Published") + " · " + escapeSlack(label) + "*",
    DIVIDER,
    "*Recommendation:* " + recommendationLine(r.published && r.published.recommendation),
    "*Release date:* " + fmtDate(r.date),
    "*Published by:* " + escapeSlack(o.actorName || "Unknown"),
    "*Tickets:* " + tickets + " · *Regression:* " + reg,
    "*Open blockers:* " + blockers + " · *Open bugs:* " + bugs,
    "<" + releaseLink(r) + "|Open in Greenlight>",
  ].join("\n");
}

module.exports = { isNewPublish, buildPublishMessage, regressionCounts, releaseLink };
