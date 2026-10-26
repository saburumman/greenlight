// Daily QA Report API. Every route is behind requireDailyReportAccess (a
// signed-in user linked to a Know the Team card whose regression flag is on).
// The author of a report is ALWAYS that card — nothing about identity is read
// from the request body.
//
//   GET  /api/daily-reports/me            today's report (if any), recent reports, Slack status
//   POST /api/daily-reports               save a report, then post it to Slack
//   POST /api/daily-reports/:id/slack-retry   try the Slack post again for one of your reports
//
// Order of events on submit: validate -> SAVE (one report per member per day,
// enforced by the store) -> post to Slack -> record the outcome on the report.
// A Slack failure never removes or blocks the saved report.

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");
const { requireDailyReportAccess } = require("../pageAccess");
const { resolveActor } = require("../assignmentLogic");
const { recordEvents } = require("../auditWriter");
const slack = require("../slack");
const logic = require("../dailyReportLogic");

const router = express.Router();
router.use(requireDailyReportAccess());

const HISTORY_LIMIT = 14;
// Reports whose Slack post is running right now (this process) — stops a
// double-click / second tab from posting the same report twice.
const sending = new Set();

// Posts one saved report to Slack and records the outcome on it. Returns the
// updated report. Never throws for a Slack problem.
async function deliverToSlack(report, actor) {
  const startedAt = new Date().toISOString();
  const result = await slack.sendMessage(logic.buildReportMessage(report), { kind: "report" });
  const prev = report.slack || logic.newSlackState();
  report.slack = result.ok
    ? { status: "sent", attempts: (prev.attempts || 0) + 1, lastAttemptAt: startedAt, sentAt: new Date().toISOString(), error: null }
    : { status: result.code === "not_configured" ? "not_configured" : "failed", attempts: (prev.attempts || 0) + 1, lastAttemptAt: startedAt, sentAt: null, error: result.error };
  report.updatedAt = new Date().toISOString();
  try {
    await db.dailyReports.set(report.id, report);
  } catch (e) {
    // The post already went out (or failed); only the bookkeeping failed.
    console.error("daily report: could not record the Slack outcome:", e && e.message);
  }
  if (!result.ok) {
    await recordEvents(db, actor, [{
      action: "DAILY_REPORT_SLACK_FAILED", entityType: "DailyReport", entityId: report.id,
      details: "Daily QA report for " + report.reportDate + " was saved but not posted to Slack — " + result.error,
      meta: { page: "dailyReport" },
    }]);
  }
  return report;
}

router.get("/me", asyncHandler(async (req, res) => {
  const member = req.dailyMember;
  const reportDate = logic.reportDateFor(new Date());
  const mine = await db.dailyReports.listForMember(member.id, HISTORY_LIMIT);
  const today = mine.find((r) => r.reportDate === reportDate) || null;
  res.json({
    reportDate,
    reportDateLabel: logic.formatReportDate(reportDate),
    member: { id: member.id, name: member.name || "" },
    slackConfigured: slack.isConfigured("report"),
    today: logic.publicReport(today),
    history: mine.map(logic.publicReport),
  });
}));

router.post("/", asyncHandler(async (req, res) => {
  const member = req.dailyMember;
  const { clean, errors } = logic.validateSubmission(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: "Please fill in the highlighted fields.", fields: errors });
  }
  const now = new Date();
  const report = logic.buildReport({
    id: crypto.randomUUID(),
    member,
    clean,
    reportDate: logic.reportDateFor(now),
    now,
  });

  // 1. SAVE — the store refuses a second report for the same member and date.
  const saved = await db.dailyReports.insertIfNew(report);
  if (!saved.inserted) {
    return res.status(409).json({
      error: "You’ve already submitted your Daily QA Report for " + logic.formatReportDate(report.reportDate) + ".",
      duplicate: true,
      report: logic.publicReport(saved.existing),
    });
  }
  const actor = resolveActor(req.authUser, req.team);
  await recordEvents(db, actor, [{
    action: "DAILY_REPORT_SUBMITTED", entityType: "DailyReport", entityId: report.id,
    details: "Daily QA report for " + report.reportDate, meta: { page: "dailyReport" },
  }]);

  // 2. SLACK — a failure leaves the report saved and retryable.
  sending.add(report.id);
  try {
    await deliverToSlack(report, actor);
  } finally {
    sending.delete(report.id);
  }
  res.status(201).json({ report: logic.publicReport(report) });
}));

router.post("/:id/slack-retry", asyncHandler(async (req, res) => {
  const member = req.dailyMember;
  const report = await db.dailyReports.get(req.params.id);
  // Someone else's report looks exactly like a missing one.
  if (!report || report.teamMemberId !== member.id) return res.status(404).json({ error: "Report not found." });
  if (!logic.canRetrySlack(report)) {
    return res.status(409).json({ error: "This report was already posted to Slack.", report: logic.publicReport(report) });
  }
  if (sending.has(report.id)) {
    return res.status(409).json({ error: "This report is being sent to Slack right now — give it a moment.", report: logic.publicReport(report) });
  }
  sending.add(report.id);
  try {
    await deliverToSlack(report, resolveActor(req.authUser, req.team));
  } finally {
    sending.delete(report.id);
  }
  res.json({ report: logic.publicReport(report) });
}));

module.exports = router;
