// The permission catalogue + the built-in role templates + the pure rule that
// turns "a role + a user's own overrides" into the permissions a person
// actually has. Nothing here touches Express or the database, so the rules can
// be unit-tested directly (see the RBAC tests).
//
// Authorization everywhere else in the app asks ONE question — "does this
// request hold permission X?" — never "is this person an Admin?". Role names
// are labels an administrator can rename; the permission keys below are the
// stable contract between the UI, the API guards and the database.
//
// Precedence (documented in README → "Users, roles & permissions"):
//   1. No permission by default (a user with no role, or a PENDING / INACTIVE
//      account, has none at all).
//   2. A role grants the permissions listed on it (Super Admin: every
//      permission in this catalogue, including ones added later).
//   3. A user-level ALLOW adds a permission the role doesn't grant.
//   4. A user-level DENY removes it — a DENY always beats a role grant or an
//      ALLOW (one override per user per permission, so they never "tie").
//   5. An override with a past expiry is ignored (temporary access).

// [key, label] pairs, grouped by module. `restricted:true` marks permissions
// that let a person change who can do what — the UI flags them.
const GROUPS = [
  { key: "releases", label: "Releases", permissions: [
    ["releases.view", "View releases and tickets"],
    ["releases.create", "Create and duplicate releases"],
    ["releases.edit", "Edit releases, tickets, bugs, incidents, notes and sync Jira"],
    ["releases.delete", "Delete releases"],
    ["releases.manage", "Make QA decisions — publish a release"],
  ] },
  { key: "regression", label: "Regression", permissions: [
    ["regression.view", "View regression modules and results"],
    ["regression.create", "Add regression items to a release"],
    ["regression.edit", "Update regression status and notes"],
    ["regression.delete", "Remove regression items from a release"],
    ["regression.assign", "Assign regression modules to team members"],
    ["regression.manage", "Manage the master module list, skip regression, sync modules"],
  ] },
  { key: "test_data", label: "Test Data", permissions: [
    ["test_data.view", "View and export test data"],
    ["test_data.create", "Add and import test data"],
    ["test_data.edit", "Edit test data and related accounts"],
    ["test_data.delete", "Delete test data"],
  ] },
  { key: "daily_reports", label: "Daily QA Reports", permissions: [
    ["daily_reports.view", "Open the Daily QA Report page and see your own reports"],
    ["daily_reports.create", "Submit reports and mark yourself absent"],
    ["daily_reports.edit_own", "Edit and re-post your own reports"],
    ["daily_reports.edit_all", "Edit other people's reports"],
    ["daily_reports.view_all", "See everyone's reports (team table)"],
  ] },
  { key: "statistics", label: "Statistics", permissions: [
    ["statistics.view", "Open the Statistics page"],
  ] },
  { key: "reporting", label: "Reporting", permissions: [
    ["reporting.view", "Open Reporting and export reports"],
    ["reporting.manage", "Run Reporting syncs and manage dependencies"],
  ] },
  { key: "audit", label: "Audit", permissions: [
    ["audit.view", "View the audit log"],
  ] },
  { key: "team", label: "Team Management", permissions: [
    ["team.view", "View Know the Team"],
    ["team.manage", "Add, edit and remove team members"],
  ] },
  { key: "users", label: "User Management", restricted: true, permissions: [
    ["users.view", "View application users"],
    ["users.create", "Pre-register users by Jira account"],
    ["users.edit", "Edit users and link them to Team Members"],
    ["users.deactivate", "Activate and deactivate accounts"],
    ["users.assign_roles", "Assign roles and individual permission overrides"],
  ] },
  { key: "roles", label: "Role Management", restricted: true, permissions: [
    ["roles.view", "View roles and who holds them"],
    ["roles.create", "Create custom roles"],
    ["roles.edit", "Edit role names, descriptions and status"],
    ["roles.delete", "Delete custom roles"],
    ["roles.manage_permissions", "Change which permissions a role grants"],
  ] },
  { key: "settings", label: "Application Settings", restricted: true, permissions: [
    ["settings.view", "View application settings"],
    ["settings.manage", "Change application settings (Reporting sync settings)"],
  ] },
];

const ALL_PERMISSIONS = Object.freeze(GROUPS.flatMap((g) => g.permissions.map((p) => p[0])));
const PERMISSION_SET = new Set(ALL_PERMISSIONS);

function isValidPermission(key) {
  return typeof key === "string" && PERMISSION_SET.has(key);
}

// Keeps only known keys, once each, in catalogue order. Unknown keys are
// reported so the API can reject them instead of silently dropping.
function normalizePermissions(list) {
  const input = Array.isArray(list) ? list : [];
  const unknown = [];
  const seen = new Set();
  for (const k of input) {
    if (typeof k !== "string" || !PERMISSION_SET.has(k)) { unknown.push(String(k)); continue; }
    seen.add(k);
  }
  return { permissions: ALL_PERMISSIONS.filter((k) => seen.has(k)), unknown };
}

function catalogForClient() {
  return GROUPS.map((g) => ({
    key: g.key, label: g.label, restricted: !!g.restricted,
    permissions: g.permissions.map(([key, label]) => ({ key, label })),
  }));
}

const NOT_ROLE_MANAGEMENT = ALL_PERMISSIONS.filter((k) => !k.startsWith("roles.") || k === "roles.view");

// Built-in roles. `key` is stable (never shown); `name` and the permission list
// can be edited by an administrator after they are created — except Super
// Admin, which is always "everything" and cannot be reduced (that is what
// makes lock-out impossible through the role editor).
const SYSTEM_ROLES = [
  {
    key: "super_admin", name: "Super Admin", locked: true,
    description: "Full access to every module, user, role and setting. Always holds every permission, including ones added in future versions.",
    permissions: ALL_PERMISSIONS,
  },
  {
    key: "admin", name: "Admin",
    description: "Manages users, assigns roles, manages the team and application settings, and has access to all operational modules. Cannot create roles or change what a role grants.",
    permissions: NOT_ROLE_MANAGEMENT,
  },
  {
    key: "qa_lead", name: "QA Lead",
    description: "Manages releases and regression (including assigning modules and QA decisions), reviews all Daily QA Reports, and can open Statistics, Reporting and the audit log.",
    permissions: [
      "releases.view", "releases.create", "releases.edit", "releases.delete", "releases.manage",
      "regression.view", "regression.create", "regression.edit", "regression.delete", "regression.assign", "regression.manage",
      "test_data.view", "test_data.create", "test_data.edit", "test_data.delete",
      "daily_reports.view", "daily_reports.create", "daily_reports.edit_own", "daily_reports.view_all",
      "statistics.view", "reporting.view", "audit.view",
      "team.view",
    ],
  },
  {
    key: "qa_engineer", name: "QA Engineer",
    description: "Views releases and tickets, works on regression results, uses Test Data, and submits and manages their own Daily QA Reports.",
    permissions: [
      "releases.view",
      "regression.view", "regression.edit",
      "test_data.view", "test_data.create", "test_data.edit",
      "daily_reports.view", "daily_reports.create", "daily_reports.edit_own",
      "team.view",
    ],
  },
  {
    key: "viewer", name: "Viewer",
    description: "Read-only access to releases, regression, test data and the team. Cannot change anything.",
    permissions: ["releases.view", "regression.view", "test_data.view", "team.view"],
  },
];

// The role existing users are placed in the first time they sign in after RBAC
// is switched on — it grants exactly what every signed-in person could already
// do before (everything except the three gated pages, which move to
// per-person overrides). A normal, editable, deletable custom role: an
// administrator moves people to the right role and removes it when empty.
const LEGACY_ROLE = {
  key: "legacy_member", name: "Existing Member (migrated)",
  description: "Created automatically for people who were already using Greenlight before roles existed. It keeps what they could do before; move each person to the right role, then delete this one.",
  permissions: [
    "releases.view", "releases.create", "releases.edit", "releases.delete", "releases.manage",
    "regression.view", "regression.create", "regression.edit", "regression.delete", "regression.assign", "regression.manage",
    "test_data.view", "test_data.create", "test_data.edit", "test_data.delete",
    "daily_reports.view", "daily_reports.create", "daily_reports.edit_own", "daily_reports.view_all",
    "audit.view", "team.view", "team.manage",
  ],
};

// role:  { systemKey, permissions[], isActive } | null
// overrides: { [permission]: { effect:"allow"|"deny", expiresAt? } }
// Returns a Set of permission keys.
function effectivePermissions(status, role, overrides, now) {
  const out = new Set();
  if (status !== "ACTIVE") return out;
  if (role && role.isActive !== false) {
    if (role.systemKey === "super_admin") ALL_PERMISSIONS.forEach((k) => out.add(k));
    else for (const k of role.permissions || []) if (PERMISSION_SET.has(k)) out.add(k);
  }
  const at = now instanceof Date ? now.getTime() : Date.now();
  const isSuper = !!(role && role.systemKey === "super_admin" && role.isActive !== false);
  for (const [perm, o] of Object.entries(overrides || {})) {
    if (!PERMISSION_SET.has(perm) || !o || isSuper) continue;
    if (o.expiresAt && new Date(o.expiresAt).getTime() <= at) continue;
    if (o.effect === "allow") out.add(perm);
    else if (o.effect === "deny") out.delete(perm);
  }
  return out;
}

// Where each effective permission comes from — for the user-detail screen.
function explainPermissions(status, role, overrides, now) {
  const eff = effectivePermissions(status, role, overrides, now);
  const at = now instanceof Date ? now.getTime() : Date.now();
  const roleSet = new Set(role && role.isActive !== false ? (role.systemKey === "super_admin" ? ALL_PERMISSIONS : (role.permissions || [])) : []);
  return ALL_PERMISSIONS.map((key) => {
    const o = overrides && overrides[key];
    const live = !!(o && !(o.expiresAt && new Date(o.expiresAt).getTime() <= at));
    let source = "none";
    if (live && o.effect === "deny" && roleSet.has(key)) source = "denied";
    else if (live && o.effect === "deny") source = "denied";
    else if (live && o.effect === "allow" && !roleSet.has(key)) source = "override";
    else if (eff.has(key)) source = "role";
    return { key, granted: eff.has(key), source };
  });
}

function isSubset(needed, held) {
  for (const k of needed) if (!held.has(k)) return false;
  return true;
}

module.exports = {
  GROUPS, ALL_PERMISSIONS, SYSTEM_ROLES, LEGACY_ROLE,
  isValidPermission, normalizePermissions, catalogForClient,
  effectivePermissions, explainPermissions, isSubset,
};
