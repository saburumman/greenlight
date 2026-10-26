// Statistics API — the audit-derived data behind the Statistics page. Every
// route is behind requirePageAccess("statistics"), enforced here on the
// server (the page being hidden in the UI is not the control).
//
// The page computes its numbers in the browser from the release documents
// (which every signed-in user can already read) plus THIS endpoint's activity
// feed — the structured audit events (who changed whose regression, previous
// and new status). /api/audit withholds that `meta` from people without
// access, so this is where it actually lives.

const express = require("express");
const db = require("../db");
const { asyncHandler } = require("../asyncHandler");
const { requirePageAccess } = require("../pageAccess");
const dailyLogic = require("../dailyReportLogic");

const router = express.Router();
router.use(requirePageAccess("statistics"));

// GET /api/statistics/activity — regression status-change events with their
// structured meta, newest first.
router.get("/activity", asyncHandler(async (req, res) => {
  const list = await db.auditLog.list();
  res.json(list.filter((e) => e && e.action === "REGRESSION_UPDATED" && e.meta && e.meta.newStatus));
}));

// GET /api/statistics/daily-reports?from=&to=&last=&member= — how many Daily QA
// Reports each QA member filled and how many working days (Sunday to Thursday)
// they missed in the period. QA members = Know the Team members available for
// regression assignment, the same population as the rest of Statistics. Counts
// only: no report text, and members are listed alphabetically.
router.get("/daily-reports", asyncHandler(async (req, res) => {
  const today = dailyLogic.reportDateFor(new Date());
  let from = dailyLogic.cleanDate(req.query.from);
  let to = dailyLogic.cleanDate(req.query.to);
  // ?last=7 / ?last=30 = the last N calendar days up to today in Amman
  const last = Number(req.query.last);
  if (last === 7 || last === 30) { from = dailyLogic.addDays(today, -(last - 1)); to = today; }
  const memberId = String(req.query.member || "").trim();
  const team = (await db.team.list()).filter((m) => m && dailyLogic.memberHasRegressionFlag(m));
  const members = team.filter((m) => !memberId || m.id === memberId)
    .map((m) => ({ id: m.id, name: m.name || "", createdAt: m.createdAt }));
  const reports = await db.dailyReports.listAllDates();
  res.json(dailyLogic.coverage({ reports, members, from, to, today }));
}));

module.exports = router;
