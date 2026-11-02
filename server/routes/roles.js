// Administration → Roles & Permissions. Guarded per action; the safeguards
// (system roles, Super Admin locked, no deleting a role people hold, no
// granting permissions you don't hold, no editing your own role) are in
// rbacService.js.

const express = require("express");
const { asyncHandler } = require("../asyncHandler");
const { requirePermission } = require("../accessControl");
const rbac = require("../rbacService");
const P = require("../permissions");

const router = express.Router();

router.get("/", requirePermission("roles.view"), asyncHandler(async (req, res) => {
  res.json({ roles: await rbac.rolesView(), catalog: P.catalogForClient() });
}));

router.post("/", requirePermission("roles.create"), asyncHandler(async (req, res) => {
  res.status(201).json(await rbac.createRole(req.access, req.body || {}));
}));

router.get("/:id", requirePermission("roles.view"), asyncHandler(async (req, res) => {
  res.json(await rbac.roleDetail(req.params.id));
}));

router.put("/:id", requirePermission("roles.edit"), asyncHandler(async (req, res) => {
  res.json(await rbac.updateRole(req.access, req.params.id, req.body || {}));
}));

router.put("/:id/permissions", requirePermission("roles.manage_permissions"), asyncHandler(async (req, res) => {
  res.json(await rbac.setRolePermissions(req.access, req.params.id, req.body && req.body.permissions));
}));

router.post("/:id/reset-permissions", requirePermission("roles.manage_permissions"), asyncHandler(async (req, res) => {
  res.json(await rbac.setRolePermissions(req.access, req.params.id, null, { reset: true }));
}));

router.delete("/:id", requirePermission("roles.delete"), asyncHandler(async (req, res) => {
  res.json(await rbac.deleteRole(req.access, req.params.id));
}));

module.exports = router;
