// Administration → Users. Every route here is guarded by a permission; the
// rules that protect against privilege escalation (no self-changes, no
// granting what you don't hold, no touching someone with more access, last
// Super Admin protected) live in rbacService.js so they apply no matter which
// route is used.

const express = require("express");
const { asyncHandler } = require("../asyncHandler");
const { requirePermission } = require("../accessControl");
const rbac = require("../rbacService");
const P = require("../permissions");

const router = express.Router();

// Who am I / what can I do — also what the client uses to draw the menu.
router.get("/", requirePermission("users.view"), asyncHandler(async (req, res) => {
  res.json({ users: await rbac.usersView(), statuses: rbac.STATUSES });
}));

router.post("/", requirePermission("users.create"), asyncHandler(async (req, res) => {
  res.status(201).json(await rbac.createUser(req.access, req.body || {}));
}));

router.get("/:id", requirePermission("users.view"), asyncHandler(async (req, res) => {
  res.json(await rbac.userDetail(req.params.id));
}));

router.get("/:id/audit", requirePermission("users.view"), asyncHandler(async (req, res) => {
  res.json(await rbac.userAudit(req.params.id));
}));

router.put("/:id/role", requirePermission("users.assign_roles"), asyncHandler(async (req, res) => {
  const roleId = req.body && req.body.roleId ? String(req.body.roleId) : null;
  res.json(await rbac.assignRole(req.access, req.params.id, roleId));
}));

router.put("/:id/status", requirePermission("users.deactivate"), asyncHandler(async (req, res) => {
  res.json(await rbac.setStatus(req.access, req.params.id, req.body && req.body.status));
}));

router.put("/:id/team-member", requirePermission("users.edit"), asyncHandler(async (req, res) => {
  const id = req.body && req.body.teamMemberId ? String(req.body.teamMemberId) : null;
  res.json(await rbac.linkTeamMember(req.access, req.params.id, id));
}));

router.put("/:id/overrides/:permission", requirePermission("users.assign_roles"), asyncHandler(async (req, res) => {
  res.json(await rbac.setOverride(req.access, req.params.id, req.params.permission, req.body || {}));
}));

router.delete("/:id/overrides/:permission", requirePermission("users.assign_roles"), asyncHandler(async (req, res) => {
  res.json(await rbac.removeOverride(req.access, req.params.id, req.params.permission));
}));

module.exports = router;
