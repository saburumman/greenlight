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

const router = express.Router();
router.use(requirePageAccess("statistics"));

// GET /api/statistics/activity — regression status-change events with their
// structured meta, newest first.
router.get("/activity", asyncHandler(async (req, res) => {
  const list = await db.auditLog.list();
  res.json(list.filter((e) => e && e.action === "REGRESSION_UPDATED" && e.meta && e.meta.newStatus));
}));

module.exports = router;
