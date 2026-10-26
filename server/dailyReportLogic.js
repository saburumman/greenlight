// Daily QA Report — pure logic (no I/O), shared by routes/dailyReports.js, the
// reminder scheduler and the tests.
//
// A report is one record per Know the Team member per report date:
//   {
//     id, teamMemberId, memberName,        // identity comes from the verified session, never the request body
//     reportDate,                          // "YYYY-MM-DD" in Asia/Amman, set by the server
//     today, tomorrow,                     // required multi-line text
//     blockers,                            // optional multi-line text ("" = none; shown/sent as "None")
//     submittedAt,
//     revision, editedAt,                  // revision starts at 1 and goes up on every saved edit (author only, any time)
//     slack: { status, attempts, lastAttemptAt, sentAt, error,
//              postedRevision,             // which revision the Slack message shows
//              updatesPosted, lastUpdateAt, updateError },
//                                          // status: "pending" | "sent" | "failed" | "not_configured"
//     createdAt, updatedAt
//   }
// The report is always saved FIRST; the Slack post is a separate step whose
// outcome is recorded on the report so a failure never loses the report and
// can be retried.

const TIME_ZONE = "Asia/Amman";
const MAX_TEXT = 3000;
const MAX_BLOCKERS = 1500;

// The daily reminder goes out at 3:45 PM Amman time. If the server was down at
// that minute it still goes out up to GRACE_MINUTES later (and never after).
const REMINDER_HOUR = 15;
const REMINDER_MINUTE = 45;
const REMINDER_GRACE_MINUTES = 120;

// ---------------------------------------------------------------------
// Dates (Asia/Amman)
// ---------------------------------------------------------------------
// Current calendar date and clock time in Amman, whatever the server's own
// time zone is.
function ammanParts(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  return { date: p.year + "-" + p.month + "-" + p.day, hour, minute, minutesOfDay: hour * 60 + minute };
}
function reportDateFor(now) {
  return ammanParts(now).date;
}
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-10-26" -> "Mon 26 Oct 2026" (a pure calendar date: no time zone maths)
function formatReportDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  if (!m) return String(dateStr || "");
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return WEEKDAYS[dt.getUTCDay()] + " " + Number(m[3]) + " " + MONTHS[Number(m[2]) - 1] + " " + m[1];
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------
// Keeps line breaks, drops control characters, trims each line's trailing
// space and squeezes runs of blank lines to one.
function normalizeText(raw) {
  return String(raw == null ? "" : raw)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// -> { clean: {today, tomorrow, blockers}, errors: {field: message} }
// The member's name is NOT an input: anything the browser sends for it is ignored.
function validateSubmission(body) {
  const b = body && typeof body === "object" ? body : {};
  const clean = {
    today: normalizeText(b.today),
    tomorrow: normalizeText(b.tomorrow),
    blockers: normalizeText(b.blockers),
  };
  const errors = {};
  if (!clean.today) errors.today = "Tell the team what you worked on today.";
  else if (clean.today.length > MAX_TEXT) errors.today = "Please keep this under " + MAX_TEXT + " characters.";
  if (!clean.tomorrow) errors.tomorrow = "Tell the team what you plan to work on tomorrow.";
  else if (clean.tomorrow.length > MAX_TEXT) errors.tomorrow = "Please keep this under " + MAX_TEXT + " characters.";
  if (clean.blockers.length > MAX_BLOCKERS) errors.blockers = "Please keep this under " + MAX_BLOCKERS + " characters.";
  return { clean, errors };
}

function newSlackState() {
  return { status: "pending", attempts: 0, lastAttemptAt: null, sentAt: null, error: null };
}
function buildReport({ id, member, clean, reportDate, now }) {
  const stamp = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  return {
    id,
    teamMemberId: member.id,
    memberName: member.name || "Unknown",
    reportDate,
    today: clean.today,
    tomorrow: clean.tomorrow,
    blockers: clean.blockers,
    submittedAt: stamp,
    revision: 1,
    editedAt: null,
    slack: newSlackState(),
    createdAt: stamp,
    updatedAt: stamp,
  };
}
// What the browser gets (nothing here is secret, but keep the shape explicit).
function publicReport(r) {
  if (!r) return null;
  const s = r.slack || newSlackState();
  return {
    id: r.id, reportDate: r.reportDate, memberName: r.memberName,
    today: r.today, tomorrow: r.tomorrow, blockers: r.blockers || "",
    submittedAt: r.submittedAt,
    revision: revisionOf(r), editedAt: r.editedAt || null,
    slack: {
      status: s.status, attempts: s.attempts || 0, lastAttemptAt: s.lastAttemptAt || null, sentAt: s.sentAt || null, error: s.error || null,
      // "unsent" (never posted) | "in_sync" (Slack shows the current text) | "edit_pending" (posted, then edited)
      sync: slackSync(r),
      updatesPosted: s.updatesPosted || 0, lastUpdateAt: s.lastUpdateAt || null, updateError: s.updateError || null,
    },
  };
}
// Reports saved before editing existed have no revision: they are revision 1.
function revisionOf(r) {
  return Number(r && r.revision) || 1;
}
// Does the Slack message match what the report says now?
function slackSync(r) {
  const s = r && r.slack;
  if (!s || s.status !== "sent") return "unsent";
  return (Number(s.postedRevision) || 1) >= revisionOf(r) ? "in_sync" : "edit_pending";
}
// Applies an author's edit to a report in place. Returns true when something
// actually changed (saving identical text does not create a new revision).
function applyEdit(report, clean, now) {
  if (report.today === clean.today && report.tomorrow === clean.tomorrow && (report.blockers || "") === clean.blockers) return false;
  const stamp = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  report.today = clean.today;
  report.tomorrow = clean.tomorrow;
  report.blockers = clean.blockers;
  report.revision = revisionOf(report) + 1;
  report.editedAt = stamp;
  report.updatedAt = stamp;
  // A failed attempt to post an older edit says nothing about this text.
  if (report.slack) report.slack.updateError = null;
  return true;
}
function canPostUpdate(report) {
  return slackSync(report) === "edit_pending";
}
function canRetrySlack(report) {
  return !!report && !!report.slack && report.slack.status !== "sent";
}

// ---------------------------------------------------------------------
// Slack message text (Slack "mrkdwn")
// ---------------------------------------------------------------------
// Slack treats &, < and > specially (<!channel>, <@U123>, <http://…|link>), so
// they are escaped in everything a person typed — nobody can make the bot
// ping the channel or post a disguised link through the form.
function escapeSlack(text) {
  return String(text == null ? "" : text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Typed bullets ("- Survey", "* Survey") become real "•" bullets so a list the
// person wrote looks like a list in Slack instead of stray dashes/asterisks
// (a leading "*" would otherwise start bold text).
function slackBody(text) {
  return escapeSlack(text).split("\n").map((line) => line.replace(/^(\s*)[-*•]\s+/, "$1• ")).join("\n");
}
const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━";
// The established template, with the section headings in Slack bold:
//
//   🧪 Daily QA Update · <report date>
//   ━━━━━━━━━━━━━━━━━━━━━━
//   Your Name
//   {name}
//
//   Today:
//   {today}
//
//   Tomorrow:
//   {tomorrow}
//
//   Blockers / help needed:
//   {blockers or None}
//
// When `updated` is true (an edited report posted a second time) the title line
// ends with "· ✏️ Updated" so the channel can tell the newer message from the
// earlier one; nothing else changes.
function buildReportMessage(report, opts) {
  const updated = !!(opts && opts.updated);
  const blockers = report.blockers && String(report.blockers).trim() ? slackBody(report.blockers) : "None";
  return [
    "🧪 *Daily QA Update* · " + formatReportDate(report.reportDate) + (updated ? " · ✏️ _Updated_" : ""),
    DIVIDER,
    "*Your Name*",
    escapeSlack(report.memberName),
    "",
    "*Today:*",
    slackBody(report.today),
    "",
    "*Tomorrow:*",
    slackBody(report.tomorrow),
    "",
    "*Blockers / help needed:*",
    blockers,
  ].join("\n");
}
// The reminder only ever reminds: it never names anyone or claims a report was
// submitted.
function buildReminderMessage(appBaseUrl) {
  const base = String(appBaseUrl || "").trim().replace(/\/+$/, "");
  const link = base ? "<" + base + "/#/daily-report|Daily QA Report>" : "Daily QA Report";
  return [
    "⏰ *Daily QA Update Reminder*",
    "Please remember to submit your Daily QA Update for today.",
    link,
  ].join("\n");
}

// ---------------------------------------------------------------------
// Reminder timing
// ---------------------------------------------------------------------
// True from 3:45 PM Amman until GRACE_MINUTES later.
function reminderDue(now) {
  const t = ammanParts(now).minutesOfDay;
  const start = REMINDER_HOUR * 60 + REMINDER_MINUTE;
  return t >= start && t < start + REMINDER_GRACE_MINUTES;
}

// ---------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------
// Only members with the regression flag on ("Available for regression
// assignment" in Know the Team) may use the page. Same rule as the rest of the
// app: a member saved before the flag existed has no key at all and counts as
// on; only an explicit false switches it off.
function memberHasRegressionFlag(member) {
  return !!member && member.regression !== false;
}

module.exports = {
  TIME_ZONE, MAX_TEXT, MAX_BLOCKERS, DIVIDER,
  REMINDER_HOUR, REMINDER_MINUTE, REMINDER_GRACE_MINUTES,
  ammanParts, reportDateFor, formatReportDate,
  normalizeText, validateSubmission, newSlackState, buildReport, publicReport, canRetrySlack,
  revisionOf, slackSync, applyEdit, canPostUpdate,
  escapeSlack, slackBody, buildReportMessage, buildReminderMessage,
  reminderDue, memberHasRegressionFlag,
};
