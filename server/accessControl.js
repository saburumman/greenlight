// Request-time authorization. Mounted once in index.js right after
// requireAuth (which only proves "a valid Jira session cookie"):
//
//   attachAccess      looks the person up BY JIRA accountId, fresh from the
//                     database on every request, works out their effective
//                     permissions, and refuses PENDING / INACTIVE accounts for
//                     every /api route — so a pending or deactivated person
//                     can't reach any data by calling the API directly.
//   requirePermission(...)      403 unless the caller holds ALL of the keys
//   requireAnyPermission(...)   403 unless the caller holds AT LEAST ONE
//
// Nothing is read from the browser: not a role, not a permission, not an id.
// Routes use these guards (never role names) and may read req.access.

const { asyncHandler } = require("./asyncHandler");
const rbac = require("./rbacService");

// Replaces req.authUser (the cookie payload) with the verified identity PLUS
// the resolved Team Member id, which is how every existing "who is this
// person on the QA team" lookup (audit actor, assignments, Daily QA Report)
// now resolves — by stable id, not by matching an email address.
function applyAccess(req, access) {
  req.access = access;
  req.authUser = {
    ...req.authUser,
    userId: access.user.id,
    teamMemberId: access.user.teamMemberId || null,
    accessStatus: access.status,
  };
}

const attachAccess = asyncHandler(async (req, res, next) => {
  const access = await rbac.loadAccess(req.authUser, { login: false });
  applyAccess(req, access);
  if (access.status === "INACTIVE") {
    return res.status(403).json({ error: "Your account has been deactivated. Contact an administrator.", code: "ACCOUNT_INACTIVE" });
  }
  if (access.status !== "ACTIVE" || !access.role || access.role.isActive === false) {
    return res.status(403).json({ error: "Your account is waiting for an administrator to give you access.", code: "ACCESS_PENDING" });
  }
  next();
});

function deny(res, keys) {
  return res.status(403).json({ error: "You don’t have permission to do that.", code: "FORBIDDEN", required: keys });
}

function requirePermission(...keys) {
  return (req, res, next) => {
    const held = req.access && req.access.permissions;
    if (!held || !keys.every((k) => held.has(k))) return deny(res, keys);
    next();
  };
}
function requireAnyPermission(...keys) {
  return (req, res, next) => {
    const held = req.access && req.access.permissions;
    if (!held || !keys.some((k) => held.has(k))) return deny(res, keys);
    next();
  };
}
const can = (req, key) => !!(req.access && req.access.permissions && req.access.permissions.has(key));

module.exports = { attachAccess, applyAccess, requirePermission, requireAnyPermission, can };
