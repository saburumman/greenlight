// Who may open the restricted pages (Statistics, Reporting) — and who may
// change that.
//
// Identity comes from the verified Atlassian session (req.authUser) resolved
// to a Know the Team card through the one-time "This is me" link
// (member.linkedEmail) — the same resolution the audit log and assignments
// use (assignmentLogic.resolveActor). Permission is ONE explicit boolean per
// page on that same TeamMember record; there is no second user table, and no
// names/ids/emails are hard-coded anywhere.
//
// Everything below reads the team fresh on every request (nothing is
// cached), so a revoke applies from the very next call without a restart.
//
// The helpers are pure (they take the team array) so they can be unit-tested
// directly; only requirePageAccess() touches express and the database.

const RESTRICTED_PAGES = {
  statistics: { field: "statisticsAccess", label: "Statistics" },
  reporting: { field: "reportingAccess", label: "Reporting" },
};

function pageConfig(page) {
  return Object.prototype.hasOwnProperty.call(RESTRICTED_PAGES, page) ? RESTRICTED_PAGES[page] : null;
}

// The Know the Team card the signed-in user linked themselves to (or null).
function memberForUser(authUser, team) {
  const email = authUser && authUser.email ? String(authUser.email).trim().toLowerCase() : "";
  if (!email) return null;
  return (team || []).find((m) => m && m.linkedEmail && String(m.linkedEmail).trim().toLowerCase() === email) || null;
}

function memberHasAccess(member, page) {
  const cfg = pageConfig(page);
  return !!(cfg && member && member[cfg.field] === true);
}

function hasPageAccess(authUser, team, page) {
  return memberHasAccess(memberForUser(authUser, team), page);
}

// Does this member hold ANY restricted page? (used for who may unlink a card)
function holdsAnyAccess(member) {
  return Object.keys(RESTRICTED_PAGES).some((p) => memberHasAccess(member, p));
}

// May `actorMember` (the caller's card, or null if unlinked) switch `page`
// access to `enable` for `target`?   → { ok:true, noop?:true } | { ok:false, status, error }
//   1. A person WITH the page's access may grant/revoke it for others.
//   2. Nobody may grant THEMSELVES access (revoking your own is fine).
//   3. Bootstrap: while NOBODY has access to the page, any signed-in user
//      linked to a card may grant it (including to themselves) — otherwise
//      the first holder could never exist.
//   4. A user not linked to a card can't change access.
function canChangePageAccess(actorMember, target, team, page, enable) {
  const cfg = pageConfig(page);
  if (!cfg) return { ok: false, status: 404, error: "Unknown page." };
  if (!actorMember) {
    return { ok: false, status: 403, error: "Link your sign-in to your Know the Team entry first (“This is me”), then you can manage access." };
  }
  if ((target[cfg.field] === true) === !!enable) return { ok: true, noop: true };
  const holders = (team || []).filter((m) => m && m[cfg.field] === true);
  if (holders.length === 0) return { ok: true, bootstrap: true };
  if (actorMember[cfg.field] !== true) {
    return { ok: false, status: 403, error: "Only people who have " + cfg.label + " access can change it for others." };
  }
  if (enable && actorMember.id === target.id) {
    return { ok: false, status: 403, error: "You can’t give yourself " + cfg.label + " access — ask someone who has it." };
  }
  return { ok: true };
}

// Express guard. Mount it on EVERY route of a restricted area. 403 unless the
// caller's linked card has the page's flag set to true right now.
function requirePageAccess(page) {
  const cfg = pageConfig(page);
  if (!cfg) throw new Error("requirePageAccess: unknown page " + page);
  const { asyncHandler } = require("./asyncHandler");
  return asyncHandler(async (req, res, next) => {
    const db = require("./db");
    const team = await db.team.list();
    if (!hasPageAccess(req.authUser, team, page)) {
      return res.status(403).json({ error: "You don’t have access to " + cfg.label + ".", page });
    }
    next();
  });
}

// ---- Daily QA Report ----
// Not an opt-in flag like Statistics/Reporting: it follows the regression flag
// ("Available for regression assignment" in Know the Team), so the whole QA
// team is in by default and a person is only left out by switching that off.
// The caller must still be linked to a Know the Team card (that card IS their
// identity on the report). Pure -> { ok:true, member } | { ok:false, status, error }
function dailyReportAccess(authUser, team) {
  const { memberHasRegressionFlag } = require("./dailyReportLogic");
  const member = memberForUser(authUser, team);
  if (!member) {
    return { ok: false, status: 403, error: "Link your sign-in to your Know the Team entry first (top bar → Link to team) to use the Daily QA Report." };
  }
  if (!memberHasRegressionFlag(member)) {
    return { ok: false, status: 403, error: "The Daily QA Report is for team members who are available for regression assignment." };
  }
  return { ok: true, member };
}
// Express guard for every Daily QA Report route; puts the caller's card on
// req.dailyMember (the report's author is always this member).
function requireDailyReportAccess() {
  const { asyncHandler } = require("./asyncHandler");
  return asyncHandler(async (req, res, next) => {
    const db = require("./db");
    const team = await db.team.list();
    const access = dailyReportAccess(req.authUser, team);
    if (!access.ok) return res.status(access.status).json({ error: access.error, page: "dailyReport" });
    req.dailyMember = access.member;
    req.team = team;
    next();
  });
}

module.exports = {
  dailyReportAccess,
  requireDailyReportAccess,
  RESTRICTED_PAGES,
  pageConfig,
  memberForUser,
  memberHasAccess,
  hasPageAccess,
  holdsAnyAccess,
  canChangePageAccess,
  requirePageAccess,
};
