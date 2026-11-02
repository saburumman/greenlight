// Page-level guards, now built on permissions (see permissions.js and
// accessControl.js) instead of per-card flags:
//
//   Statistics      -> statistics.view
//   Reporting       -> reporting.view
//   Daily QA Report -> daily_reports.view  (+ the person must be linked to a
//                      Know the Team card — that card IS their identity on a
//                      report; there is no longer a separate "regression
//                      flag" gate)
//
// "Who is this person on the QA team" is resolved by the stable Team Member
// id stored on their application user (req.authUser.teamMemberId, set by
// accessControl.attachAccess) — never by matching an email address.

const { asyncHandler } = require("./asyncHandler");
const { requirePermission } = require("./accessControl");

const PAGE_PERMISSIONS = {
  statistics: "statistics.view",
  reporting: "reporting.view",
};

// The Know the Team card of the signed-in user (or null if not linked).
function memberForUser(authUser, team) {
  const id = authUser && authUser.teamMemberId;
  if (!id) return null;
  return (team || []).find((m) => m && m.id === id) || null;
}

// Express guard for a restricted page — mount it on every route of the area.
function requirePageAccess(page) {
  const key = PAGE_PERMISSIONS[page];
  if (!key) throw new Error("requirePageAccess: unknown page " + page);
  return requirePermission(key);
}

// Pure: the card a Daily QA Report belongs to → { ok:true, member } | { ok:false, status, error }
function dailyReportAccess(authUser, team) {
  const member = memberForUser(authUser, team);
  if (!member) {
    return { ok: false, status: 403, error: "Link your sign-in to your Know the Team entry first (top bar → Link to team) to use the Daily QA Report." };
  }
  return { ok: true, member };
}
// Guard for every Daily QA Report route: needs daily_reports.view and a linked
// card (put on req.dailyMember — the report's author is always this member).
function requireDailyReportAccess() {
  const withMember = asyncHandler(async (req, res, next) => {
    const db = require("./db");
    const team = await db.team.list();
    const access = dailyReportAccess(req.authUser, team);
    if (!access.ok) return res.status(access.status).json({ error: access.error, page: "dailyReport" });
    req.dailyMember = access.member;
    req.team = team;
    next();
  });
  return [requirePermission("daily_reports.view"), withMember];
}

module.exports = { PAGE_PERMISSIONS, memberForUser, requirePageAccess, dailyReportAccess, requireDailyReportAccess };
