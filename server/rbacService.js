// Users, roles and permissions — the rules. Everything that CHANGES who can do
// what lives here (never in a route handler), so the safeguards cannot be
// forgotten by one endpoint:
//
//   - a user is identified ONLY by their Jira accountId; the first successful
//     Jira sign-in registers them as PENDING with no permissions at all;
//   - nobody can change their OWN role, status or overrides;
//   - nobody can hand out a permission they don't hold themselves, assign a
//     role bigger than their own access, or change a user who has more access
//     than they do (so an Admin can never touch or create a Super Admin);
//   - the last active Super Admin can't be demoted, deactivated or removed;
//   - system roles can't be deleted; Super Admin can't be reduced; a role
//     that people hold can't be deleted or switched off;
//   - every change is written to the existing audit log, with the previous
//     and the new value.
//
// All mutations run one at a time through withLock() so two administrators
// acting at the same moment can't, for example, both demote "the other"
// Super Admin. (One lock per server process — Render runs one instance.)
//
// Team Members stay the QA-team identity: a user points at a Team Member by
// its stable id (`teamMemberId`) and nothing here ever creates, edits or
// deletes a Team Member or any history that references one.

const crypto = require("crypto");
const db = require("./db");
const P = require("./permissions");
const { recordEvents } = require("./auditWriter");
const { HttpError } = require("./httpError");

const STATUSES = ["PENDING", "ACTIVE", "INACTIVE"];
const ACCOUNT_ID_RE = /^[A-Za-z0-9:_.\-]{3,128}$/;
const MAX_OVERRIDE_DAYS = 366;

// ---- one-at-a-time lock ---------------------------------------------------
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const nowIso = () => new Date().toISOString();
const lower = (s) => String(s || "").trim().toLowerCase();

// ---- built-in roles ---------------------------------------------------------
let rolesReady = null;
// Creates the five built-in roles the first time (idempotent, never touches
// permission edits an administrator made later). Super Admin is kept equal to
// "every permission in the catalogue" so new permissions reach it automatically.
function ensureSystemRoles() {
  if (rolesReady) return rolesReady;
  rolesReady = (async () => {
    let existing = await db.appRoles.list();
    for (const def of P.SYSTEM_ROLES) {
      const found = existing.find((r) => r.systemKey === def.key);
      if (found) {
        if (def.key === "super_admin" && P.ALL_PERMISSIONS.some((k) => !found.permissions.includes(k))) {
          await db.appRoles.save({ ...found, permissions: P.ALL_PERMISSIONS.slice(), updatedAt: nowIso() });
        }
        continue;
      }
      let name = def.name;
      if (existing.some((r) => lower(r.name) === lower(name))) name = def.name + " (built-in)";
      const t = nowIso();
      try {
        await db.appRoles.save({
          id: crypto.randomUUID(), systemKey: def.key, name, description: def.description, isSystem: true, isActive: true,
          permissions: def.permissions.slice(), createdBy: null, createdAt: t, updatedAt: t,
        });
      } catch (e) {
        if (e.code !== "DUPLICATE_ROLE_NAME") throw e; // another instance created it first
      }
      existing = await db.appRoles.list();
    }
  })().catch((e) => { rolesReady = null; throw e; });
  return rolesReady;
}
function _resetForTests() { rolesReady = null; chain = Promise.resolve(); }

async function systemRole(key) {
  await ensureSystemRoles();
  return (await db.appRoles.list()).find((r) => r.systemKey === key) || null;
}
async function ensureLegacyRole() {
  const roles = await db.appRoles.list();
  const found = roles.find((r) => r.systemKey === P.LEGACY_ROLE.key);
  if (found) return found;
  let name = P.LEGACY_ROLE.name;
  if (roles.some((r) => lower(r.name) === lower(name))) name += " 2";
  const t = nowIso();
  const role = {
    id: crypto.randomUUID(), systemKey: P.LEGACY_ROLE.key, name, description: P.LEGACY_ROLE.description,
    isSystem: false, isActive: true, permissions: P.LEGACY_ROLE.permissions.slice(), createdBy: null, createdAt: t, updatedAt: t,
  };
  try { await db.appRoles.save(role); } catch (e) {
    if (e.code !== "DUPLICATE_ROLE_NAME") throw e;
    return (await db.appRoles.list()).find((r) => r.systemKey === P.LEGACY_ROLE.key) || role;
  }
  return role;
}

// ---- audit helper -----------------------------------------------------------
async function audit(actor, events) {
  const a = actor && actor.user
    ? { id: (actor.teamMember && actor.teamMember.id) || actor.user.teamMemberId || null, name: (actor.teamMember && actor.teamMember.name) || actor.user.displayName || "Unknown" }
    : { id: null, name: (actor && actor.name) || "System" };
  const accountId = actor && actor.user ? actor.user.accountId : "";
  await recordEvents(db, a, events.map((e) => ({ ...e, meta: { ...(e.meta || {}), ...(accountId ? { actorAccountId: accountId } : {}) } })));
}
const short = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const userLabel = (u) => (u.displayName || u.accountId);

// ---- access resolution --------------------------------------------------------
async function roleOf(user) { return user && user.roleId ? db.appRoles.get(user.roleId) : null; }

function bootstrapIds() {
  return String(process.env.SUPER_ADMIN_ACCOUNT_IDS || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}
async function countActiveSuperAdmins() {
  const roles = await db.appRoles.list();
  const sa = roles.find((r) => r.systemKey === "super_admin");
  if (!sa || sa.isActive === false) return 0;
  return (await db.appUsers.list()).filter((u) => u.status === "ACTIVE" && u.roleId === sa.id).length;
}

// Existing people keep what they had. On the very first registration, a person
// whose email matches the "This is me" link on a Know the Team card (the
// pre-RBAC identity link) is attached to that card and placed in the migrated
// role, with their old per-card flags turned into explicit per-user overrides.
// It happens once, only at registration, and only when Jira shares an email.
async function adoptLegacy(user, identity) {
  if (process.env.RBAC_ADOPT_LEGACY === "off") return { user, adopted: false };
  const email = lower(identity.email);
  if (!email) return { user, adopted: false };
  const team = await db.team.list();
  const card = team.find((m) => m && m.linkedEmail && lower(m.linkedEmail) === email);
  if (!card) return { user, adopted: false };
  const users = await db.appUsers.list();
  if (users.some((u) => u.id !== user.id && u.teamMemberId === card.id)) return { user, adopted: false };
  const role = await ensureLegacyRole();
  const t = nowIso();
  const reason = "Migrated from the previous Team Member access setting";
  const ov = {};
  const put = (perm, effect) => { ov[perm] = { effect, expiresAt: null, reason, createdBy: "system", createdAt: t }; };
  if (card.statisticsAccess === true) put("statistics.view", "allow");
  if (card.reportingAccess === true) put("reporting.view", "allow");
  if (card.regression === false) ["daily_reports.view", "daily_reports.create", "daily_reports.edit_own", "daily_reports.view_all"].forEach((k) => put(k, "deny"));
  const next = { ...user, teamMemberId: card.id, roleId: role.id, status: "ACTIVE", legacyAdopted: true, overrides: ov, statusChangedAt: t, updatedAt: t };
  await db.appUsers.save(next);
  await audit({ name: "System (migration)" }, [
    { action: "TEAM_MEMBER_LINKED", entityType: "User", entityId: next.id, details: userLabel(next) + " linked to " + (card.name || "a team member") + " from the existing “This is me” link", meta: { targetUserId: next.id, targetMemberId: card.id, newValue: card.name || "" } },
    { action: "USER_ROLE_CHANGED", entityType: "User", entityId: next.id, details: userLabel(next) + " placed in “" + role.name + "” to keep their existing access", meta: { targetUserId: next.id, targetRoleId: role.id, previousValue: "No role", newValue: role.name } },
    { action: "USER_ACTIVATED", entityType: "User", entityId: next.id, details: userLabel(next) + " activated (existing user migrated)", meta: { targetUserId: next.id, previousValue: "PENDING", newValue: "ACTIVE" } },
    ...Object.entries(ov).map(([perm, o]) => ({ action: "USER_PERMISSION_OVERRIDE_ADDED", entityType: "User", entityId: next.id, details: o.effect.toUpperCase() + " " + perm + " for " + userLabel(next) + " (migrated)", meta: { targetUserId: next.id, permission: perm, newValue: o.effect } })),
  ]);
  return { user: next, adopted: true };
}

// Safe bootstrap: promotes the person to Super Admin only when (a) their Jira
// accountId is listed in the SUPER_ADMIN_ACCOUNT_IDS environment variable of
// the server and (b) there is NO active Super Admin right now. Nobody is ever
// promoted by being "first to log in", and there is no HTTP endpoint for it.
async function maybeBootstrap(user) {
  if (!bootstrapIds().includes(user.accountId)) return user;
  const sa = await systemRole("super_admin");
  if (!sa) return user;
  if (user.status === "ACTIVE" && user.roleId === sa.id) return user;
  if ((await countActiveSuperAdmins()) > 0) return user;
  const t = nowIso();
  const prevRole = user.roleId ? (await db.appRoles.get(user.roleId)) : null;
  const next = { ...user, roleId: sa.id, status: "ACTIVE", overrides: {}, statusChangedAt: t, updatedAt: t };
  await db.appUsers.save(next);
  await audit({ name: "System (bootstrap)" }, [
    { action: "USER_ROLE_CHANGED", entityType: "User", entityId: next.id, details: userLabel(next) + " set as the first Super Admin (SUPER_ADMIN_ACCOUNT_IDS — no active Super Admin existed)", meta: { targetUserId: next.id, targetRoleId: sa.id, previousValue: prevRole ? prevRole.name : "No role", newValue: sa.name } },
    ...(user.status !== "ACTIVE" ? [{ action: "USER_ACTIVATED", entityType: "User", entityId: next.id, details: userLabel(next) + " activated (bootstrap)", meta: { targetUserId: next.id, previousValue: user.status, newValue: "ACTIVE" } }] : []),
  ]);
  return next;
}

// Called at every successful Jira sign-in (login:true) and, defensively, the
// first time a still-valid session cookie shows up for someone with no record
// yet (login:false). Creates the user once (race-safe on accountId), refreshes
// profile fields otherwise, and never creates a duplicate.
function registerOrUpdateOnLogin(identity, opts) {
  const login = !(opts && opts.login === false);
  return withLock(async () => {
    if (!identity || !identity.accountId || !ACCOUNT_ID_RE.test(String(identity.accountId))) {
      throw new HttpError(400, "The Jira sign-in didn't include an account id.", "NO_ACCOUNT_ID");
    }
    await ensureSystemRoles();
    const t = nowIso();
    let user = await db.appUsers.getByAccountId(identity.accountId);
    if (!user) {
      const draft = {
        id: crypto.randomUUID(), accountId: identity.accountId, displayName: short(identity.name, 200), email: short(identity.email, 320),
        avatarUrl: short(identity.avatarUrl, 1000), roleId: null, status: "PENDING", teamMemberId: null, overrides: {},
        legacyAdopted: false, createdAt: t, updatedAt: t, lastLoginAt: login ? t : null, statusChangedAt: null,
      };
      const r = await db.appUsers.insertIfNew(draft);
      user = r.user;
      if (r.inserted) {
        await audit({ user, teamMember: null }, [{ action: "USER_REGISTERED", entityType: "User", entityId: user.id, details: userLabel(user) + " signed in with Jira for the first time (status: Pending — no access until an administrator assigns a role)", meta: { targetUserId: user.id, newValue: "PENDING" } }]);
        const adopted = await adoptLegacy(user, identity);
        user = adopted.user;
      }
    } else {
      const patch = {};
      if (identity.name && identity.name !== user.displayName) patch.displayName = short(identity.name, 200);
      if (identity.email && identity.email !== user.email) patch.email = short(identity.email, 320); // never blanked: Jira may hide it
      if (identity.avatarUrl && identity.avatarUrl !== user.avatarUrl) patch.avatarUrl = short(identity.avatarUrl, 1000);
      if (login) patch.lastLoginAt = t;
      if (Object.keys(patch).length) {
        user = { ...user, ...patch, updatedAt: t };
        await db.appUsers.save(user);
      }
    }
    return maybeBootstrap(user);
  });
}

// The access picture of one signed-in request. Always read fresh from the
// database — nothing about a person's role or permissions is ever taken from
// the browser or from the session cookie, so a role change, deactivation or
// revoke applies from the very next request.
async function loadAccess(identity, opts) {
  let user = await db.appUsers.getByAccountId(identity.accountId);
  // Bootstrap candidates (SUPER_ADMIN_ACCOUNT_IDS) are re-checked on requests too — not only at sign-in — so someone who
  // was already signed in (and was registered, or migrated, before the variable was set) is promoted by the next request
  // once it is set, with no need to sign out and in. maybeBootstrap does nothing unless NO active Super Admin exists.
  const isBootstrapId = !!user && bootstrapIds().includes(user.accountId);
  const curRole = isBootstrapId ? await roleOf(user) : null;
  const alreadySuper = isBootstrapId && user.status === "ACTIVE" && !!curRole && curRole.systemKey === "super_admin";
  if (!user || (isBootstrapId && !alreadySuper)) {
    user = await registerOrUpdateOnLogin(identity, { login: !!(opts && opts.login) });
  }
  const role = await roleOf(user);
  const permissions = P.effectivePermissions(user.status, role, user.overrides);
  const teamMember = user.teamMemberId ? await db.team.get(user.teamMemberId) : null;
  return {
    user, role, permissions, teamMember, status: user.status,
    isSuperAdmin: !!(role && role.systemKey === "super_admin" && role.isActive !== false && user.status === "ACTIVE"),
  };
}

// ---- guards -----------------------------------------------------------------
function latentPermissions(user, role) { return P.effectivePermissions("ACTIVE", role, user.overrides); }

function assertNotSelf(actor, target, what) {
  if (actor.user.id === target.id) throw new HttpError(403, "You can’t change your own " + what + ". Ask another administrator.", "SELF_CHANGE");
}
async function assertOutranks(actor, target) {
  const role = await roleOf(target);
  if (!P.isSubset(latentPermissions(target, role), actor.permissions)) {
    throw new HttpError(403, "You can’t change a user who has more access than you do.", "TARGET_OUTRANKS");
  }
}
function assertCanGrant(actor, permissions, what) {
  const missing = permissions.filter((k) => !actor.permissions.has(k));
  if (missing.length) throw new HttpError(403, "You can’t " + (what || "grant") + " permissions you don’t hold yourself: " + missing.join(", ") + ".", "ESCALATION");
}
async function assertNotLastSuperAdmin(target, what) {
  const role = await roleOf(target);
  if (role && role.systemKey === "super_admin" && target.status === "ACTIVE" && (await countActiveSuperAdmins()) <= 1) {
    throw new HttpError(409, "This is the last active Super Admin — " + what + " would lock everyone out of administration. Make another person Super Admin first.", "LAST_SUPER_ADMIN");
  }
}
async function mustUser(id) {
  const u = await db.appUsers.get(id);
  if (!u) throw new HttpError(404, "User not found.");
  return u;
}
async function mustRole(id) {
  const r = await db.appRoles.get(id);
  if (!r) throw new HttpError(404, "Role not found.");
  return r;
}

// ---- reads --------------------------------------------------------------------
async function usersView() {
  const [users, roles, team] = await Promise.all([db.appUsers.list(), db.appRoles.list(), db.team.list()]);
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const teamById = new Map(team.map((m) => [m.id, m]));
  return users.map((u) => describeUser(u, roleById.get(u.roleId), teamById.get(u.teamMemberId)))
    .sort((a, b) => String(a.displayName || a.accountId).localeCompare(String(b.displayName || b.accountId), undefined, { sensitivity: "base" }));
}
function describeUser(u, role, member) {
  return {
    id: u.id, accountId: u.accountId, displayName: u.displayName, email: u.email || "", avatarUrl: u.avatarUrl || "",
    status: u.status, roleId: u.roleId || null, roleName: role ? role.name : "", roleActive: role ? role.isActive !== false : null,
    isSuperAdmin: !!(role && role.systemKey === "super_admin"),
    teamMemberId: u.teamMemberId || null, teamMemberName: member ? member.name || "" : "",
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, statusChangedAt: u.statusChangedAt || null,
    overrideCount: Object.keys(u.overrides || {}).length, legacyAdopted: !!u.legacyAdopted,
  };
}
async function userDetail(id) {
  const u = await mustUser(id);
  const role = await roleOf(u);
  const member = u.teamMemberId ? await db.team.get(u.teamMemberId) : null;
  const t = Date.now();
  return {
    ...describeUser(u, role, member),
    teamMember: member ? { id: member.id, name: member.name || "", role: member.role || "", department: member.department || "" } : null,
    effective: P.explainPermissions(u.status, role, u.overrides),
    latentCount: latentPermissions(u, role).size,
    overrides: Object.entries(u.overrides || {}).map(([permission, o]) => ({
      permission, effect: o.effect, expiresAt: o.expiresAt || null, expired: !!(o.expiresAt && new Date(o.expiresAt).getTime() <= t),
      reason: o.reason || "", createdBy: o.createdBy || "", createdAt: o.createdAt || null,
    })).sort((a, b) => a.permission.localeCompare(b.permission)),
  };
}
async function userAudit(id) {
  await mustUser(id);
  const all = await db.auditLog.list();
  return all.filter((e) => e && (e.meta && e.meta.targetUserId === id || (e.entityType === "User" && e.entityId === id))).slice(0, 100);
}
async function rolesView() {
  const [roles, users] = await Promise.all([db.appRoles.list(), db.appUsers.list()]);
  const counts = new Map();
  for (const u of users) if (u.roleId) counts.set(u.roleId, (counts.get(u.roleId) || 0) + 1);
  const order = new Map(P.SYSTEM_ROLES.map((r, i) => [r.key, i]));
  return roles.map((r) => ({ ...r, userCount: counts.get(r.id) || 0, locked: r.systemKey === "super_admin" }))
    .sort((a, b) => (a.isSystem === b.isSystem ? (order.has(a.systemKey) ? order.get(a.systemKey) - (order.get(b.systemKey) ?? 99) : a.name.localeCompare(b.name)) : (a.isSystem ? -1 : 1)));
}
async function roleDetail(id) {
  const r = await mustRole(id);
  const users = (await db.appUsers.list()).filter((u) => u.roleId === id)
    .map((u) => ({ id: u.id, displayName: u.displayName || u.accountId, status: u.status }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { ...r, locked: r.systemKey === "super_admin", userCount: users.length, users };
}

// ---- user mutations ---------------------------------------------------------------
function createUser(actor, body) {
  return withLock(async () => {
    const accountId = String((body && body.accountId) || "").trim();
    if (!ACCOUNT_ID_RE.test(accountId)) throw new HttpError(400, "Enter the person’s Jira account id (letters, digits, “:”, “-” or “_”).", "BAD_ACCOUNT_ID", { field: "accountId" });
    await ensureSystemRoles();
    if (await db.appUsers.getByAccountId(accountId)) throw new HttpError(409, "That Jira account is already registered.", "DUPLICATE_ACCOUNT", { field: "accountId" });
    const roleId = body && body.roleId ? String(body.roleId) : null;
    let role = null;
    if (roleId) {
      if (!actor.permissions.has("users.assign_roles")) throw new HttpError(403, "You can add people but not assign a role (users.assign_roles).", "FORBIDDEN");
      role = await mustRole(roleId);
      if (role.isActive === false) throw new HttpError(400, "That role is switched off.", "ROLE_INACTIVE", { field: "roleId" });
      assertCanGrant(actor, role.systemKey === "super_admin" ? P.ALL_PERMISSIONS : role.permissions, "assign a role with");
    }
    const t = nowIso();
    const user = {
      id: crypto.randomUUID(), accountId, displayName: short((body && body.displayName) || "", 200), email: short((body && body.email) || "", 320),
      avatarUrl: "", roleId: role ? role.id : null, status: role ? "ACTIVE" : "PENDING", teamMemberId: null, overrides: {},
      legacyAdopted: false, createdAt: t, updatedAt: t, lastLoginAt: null, statusChangedAt: role ? t : null,
    };
    const r = await db.appUsers.insertIfNew(user);
    if (!r.inserted) throw new HttpError(409, "That Jira account is already registered.", "DUPLICATE_ACCOUNT", { field: "accountId" });
    await audit(actor, [
      { action: "USER_REGISTERED", entityType: "User", entityId: user.id, details: userLabel(user) + " pre-registered by " + userLabel(actor.user) + " (they sign in with Jira as usual)", meta: { targetUserId: user.id, newValue: user.status } },
      ...(role ? [
        { action: "USER_ROLE_CHANGED", entityType: "User", entityId: user.id, details: userLabel(user) + " given the role “" + role.name + "”", meta: { targetUserId: user.id, targetRoleId: role.id, previousValue: "No role", newValue: role.name } },
        { action: "USER_ACTIVATED", entityType: "User", entityId: user.id, details: userLabel(user) + " activated", meta: { targetUserId: user.id, previousValue: "PENDING", newValue: "ACTIVE" } },
      ] : []),
    ]);
    return userDetail(user.id);
  });
}

function assignRole(actor, userId, roleId) {
  return withLock(async () => {
    const target = await mustUser(userId);
    assertNotSelf(actor, target, "role");
    await assertOutranks(actor, target);
    const prevRole = await roleOf(target);
    let role = null;
    if (roleId) {
      role = await mustRole(String(roleId));
      if (role.isActive === false) throw new HttpError(400, "That role is switched off.", "ROLE_INACTIVE");
      assertCanGrant(actor, role.systemKey === "super_admin" ? P.ALL_PERMISSIONS : role.permissions, "assign a role with");
    }
    if ((role ? role.id : null) === (target.roleId || null)) return userDetail(userId); // nothing to change
    if (!role || role.systemKey !== "super_admin") await assertNotLastSuperAdmin(target, "changing their role");
    const t = nowIso();
    const events = [];
    let next = { ...target, roleId: role ? role.id : null, updatedAt: t };
    if (role && role.systemKey === "super_admin") {
      for (const [perm, o] of Object.entries(target.overrides || {})) {
        events.push({ action: "USER_PERMISSION_OVERRIDE_REMOVED", entityType: "User", entityId: target.id, details: "Override " + o.effect.toUpperCase() + " " + perm + " removed from " + userLabel(target) + " (Super Admin holds every permission)", meta: { targetUserId: target.id, permission: perm, previousValue: o.effect } });
      }
      next.overrides = {};
    }
    const prevStatus = target.status;
    if (!role) { if (next.status === "ACTIVE") { next.status = "PENDING"; next.statusChangedAt = t; } }
    else if (next.status === "PENDING") { next.status = "ACTIVE"; next.statusChangedAt = t; }
    await db.appUsers.save(next);
    events.unshift({
      action: "USER_ROLE_CHANGED", entityType: "User", entityId: target.id,
      details: userLabel(target) + ": " + (prevRole ? prevRole.name : "No role") + " → " + (role ? role.name : "No role"),
      meta: { targetUserId: target.id, ...(role ? { targetRoleId: role.id } : {}), previousValue: prevRole ? prevRole.name : "No role", newValue: role ? role.name : "No role" },
    });
    if (prevStatus !== next.status) {
      events.push({
        action: next.status === "ACTIVE" ? "USER_ACTIVATED" : "USER_DEACTIVATED", entityType: "User", entityId: target.id,
        details: userLabel(target) + (next.status === "ACTIVE" ? " activated by assigning a role" : " set back to Pending (role removed)"),
        meta: { targetUserId: target.id, previousValue: prevStatus, newValue: next.status },
      });
    }
    await audit(actor, events);
    return userDetail(userId);
  });
}

function setStatus(actor, userId, status) {
  return withLock(async () => {
    if (status !== "ACTIVE" && status !== "INACTIVE") throw new HttpError(400, "Status must be ACTIVE or INACTIVE.", "BAD_STATUS");
    const target = await mustUser(userId);
    assertNotSelf(actor, target, "status");
    await assertOutranks(actor, target);
    if (target.status === status) return userDetail(userId);
    if (status === "INACTIVE") await assertNotLastSuperAdmin(target, "deactivating them");
    if (status === "ACTIVE") {
      const role = await roleOf(target);
      if (!role) throw new HttpError(400, "Assign a role first — an active user needs one.", "NO_ROLE");
      if (role.isActive === false) throw new HttpError(400, "Their role is switched off — assign another role first.", "ROLE_INACTIVE");
    }
    const t = nowIso();
    await db.appUsers.save({ ...target, status, statusChangedAt: t, updatedAt: t });
    if (status === "INACTIVE") {
      // End their Jira access too: the stored Jira tokens are dropped, so a
      // deactivated person is signed out of everything at once.
      try { await require("./auth/atlassianTokens").clearTokens(target.accountId); } catch (e) { console.error("clearTokens failed:", e && e.message); }
    }
    await audit(actor, [{
      action: status === "ACTIVE" ? "USER_ACTIVATED" : "USER_DEACTIVATED", entityType: "User", entityId: target.id,
      details: userLabel(target) + (status === "ACTIVE" ? " activated" : " deactivated — no longer has access (their Team Member and history are kept)"),
      meta: { targetUserId: target.id, previousValue: target.status, newValue: status },
    }]);
    return userDetail(userId);
  });
}

// Shared by the administrator screen and the self-service "This is me" link.
async function applyTeamLink(actor, target, teamMemberId, { self }) {
  const users = await db.appUsers.list();
  let member = null;
  if (teamMemberId) {
    member = await db.team.get(String(teamMemberId));
    if (!member) throw new HttpError(404, "Team member not found.");
    const holder = users.find((u) => u.id !== target.id && u.teamMemberId === member.id);
    if (holder) throw new HttpError(409, "That Team Member is already linked to " + userLabel(holder) + ". Unlink it there first.", "TEAM_MEMBER_TAKEN");
  }
  const prevId = target.teamMemberId || null;
  if ((member ? member.id : null) === prevId) return target;
  const prev = prevId ? await db.team.get(prevId) : null;
  const t = nowIso();
  const next = { ...target, teamMemberId: member ? member.id : null, updatedAt: t };
  await db.appUsers.save(next);
  const events = [];
  if (prev) events.push({ action: "TEAM_MEMBER_UNLINKED", entityType: "User", entityId: target.id, details: userLabel(target) + " unlinked from " + (prev.name || "a team member"), meta: { targetUserId: target.id, targetMemberId: prev.id, previousValue: prev.name || "", newValue: "" } });
  if (member) events.push({ action: "TEAM_MEMBER_LINKED", entityType: "User", entityId: target.id, details: userLabel(target) + " linked to " + (member.name || "a team member") + (self ? " (by themselves)" : ""), meta: { targetUserId: target.id, targetMemberId: member.id, previousValue: prev ? prev.name || "" : "", newValue: member.name || "" } });
  await audit(actor, events);
  return next;
}
function linkTeamMember(actor, userId, teamMemberId) {
  return withLock(async () => {
    const target = await mustUser(userId);
    await applyTeamLink(actor, target, teamMemberId || null, { self: actor.user.id === target.id });
    return userDetail(userId);
  });
}
// Self-service: the signed-in person pins which Team Member card is them.
function linkSelf(actor, teamMemberId) {
  return withLock(async () => {
    const target = await mustUser(actor.user.id);
    return applyTeamLink(actor, target, teamMemberId || null, { self: true });
  });
}

function setOverride(actor, userId, permission, body) {
  return withLock(async () => {
    if (!P.isValidPermission(permission)) throw new HttpError(400, "Unknown permission.", "BAD_PERMISSION");
    const effect = body && body.effect;
    if (effect !== "allow" && effect !== "deny") throw new HttpError(400, "effect must be “allow” or “deny”.", "BAD_EFFECT");
    let expiresAt = null;
    if (body && body.expiresAt) {
      const d = new Date(body.expiresAt);
      if (isNaN(d.getTime())) throw new HttpError(400, "That expiry isn’t a valid date.", "BAD_EXPIRY");
      if (d.getTime() <= Date.now()) throw new HttpError(400, "The expiry must be in the future.", "BAD_EXPIRY");
      if (d.getTime() > Date.now() + MAX_OVERRIDE_DAYS * 86400000) throw new HttpError(400, "Temporary access can last at most one year.", "BAD_EXPIRY");
      expiresAt = d.toISOString();
    }
    const target = await mustUser(userId);
    assertNotSelf(actor, target, "permissions");
    const role = await roleOf(target);
    if (role && role.systemKey === "super_admin") throw new HttpError(400, "Super Admins always hold every permission — individual overrides don’t apply to them.", "SUPER_ADMIN_OVERRIDE");
    await assertOutranks(actor, target);
    if (effect === "allow") assertCanGrant(actor, [permission], "grant");
    const prev = (target.overrides || {})[permission];
    const t = nowIso();
    const overrides = { ...(target.overrides || {}), [permission]: { effect, expiresAt, reason: short((body && body.reason) || "", 200), createdBy: actor.user.displayName || actor.user.accountId, createdAt: t } };
    await db.appUsers.save({ ...target, overrides, updatedAt: t });
    await audit(actor, [{
      action: "USER_PERMISSION_OVERRIDE_ADDED", entityType: "User", entityId: target.id,
      details: effect.toUpperCase() + " " + permission + " for " + userLabel(target) + (expiresAt ? " until " + expiresAt.slice(0, 10) : "") + (prev ? " (was " + prev.effect.toUpperCase() + ")" : ""),
      meta: { targetUserId: target.id, permission, previousValue: prev ? prev.effect : "none", newValue: effect + (expiresAt ? " until " + expiresAt.slice(0, 10) : "") },
    }]);
    return userDetail(userId);
  });
}
function removeOverride(actor, userId, permission) {
  return withLock(async () => {
    const target = await mustUser(userId);
    assertNotSelf(actor, target, "permissions");
    await assertOutranks(actor, target);
    const prev = (target.overrides || {})[permission];
    if (!prev) throw new HttpError(404, "There is no override for that permission.");
    const overrides = { ...target.overrides }; delete overrides[permission];
    await db.appUsers.save({ ...target, overrides, updatedAt: nowIso() });
    await audit(actor, [{
      action: "USER_PERMISSION_OVERRIDE_REMOVED", entityType: "User", entityId: target.id,
      details: "Override " + prev.effect.toUpperCase() + " " + permission + " removed from " + userLabel(target),
      meta: { targetUserId: target.id, permission, previousValue: prev.effect, newValue: "none" },
    }]);
    return userDetail(userId);
  });
}

// ---- role mutations -----------------------------------------------------------------
function cleanRoleText(body, { requireName }) {
  const out = {};
  if (requireName || (body && body.name !== undefined)) {
    const name = String((body && body.name) || "").replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 60) throw new HttpError(400, "Give the role a name of 2–60 characters.", "BAD_NAME", { field: "name" });
    out.name = name;
  }
  if (body && body.description !== undefined) {
    const d = String(body.description || "").trim();
    if (d.length > 300) throw new HttpError(400, "The description can be at most 300 characters.", "BAD_DESCRIPTION", { field: "description" });
    out.description = d;
  }
  return out;
}
function permsOrThrow(list) {
  const n = P.normalizePermissions(list);
  if (n.unknown.length) throw new HttpError(400, "Unknown permission: " + n.unknown.slice(0, 5).join(", ") + ".", "BAD_PERMISSION");
  return n.permissions;
}
async function assertNameFree(name, exceptId) {
  const roles = await db.appRoles.list();
  if (roles.some((r) => r.id !== exceptId && lower(r.name) === lower(name))) throw new HttpError(409, "A role with that name already exists.", "DUPLICATE_ROLE_NAME", { field: "name" });
}
function ownRoleGuard(actor, role) {
  if (actor.user.roleId && actor.user.roleId === role.id) throw new HttpError(403, "You can’t change the permissions of your own role. Ask another administrator.", "SELF_CHANGE");
}

function createRole(actor, body) {
  return withLock(async () => {
    const text = cleanRoleText(body, { requireName: true });
    const wantsPerms = body && Array.isArray(body.permissions) && body.permissions.length > 0;
    const permissions = wantsPerms ? permsOrThrow(body.permissions) : [];
    if (permissions.length) {
      if (!actor.permissions.has("roles.manage_permissions")) throw new HttpError(403, "Creating a role with permissions needs roles.manage_permissions.", "FORBIDDEN");
      assertCanGrant(actor, permissions);
    }
    await ensureSystemRoles();
    await assertNameFree(text.name);
    const t = nowIso();
    const role = { id: crypto.randomUUID(), systemKey: null, name: text.name, description: text.description || "", isSystem: false, isActive: true, permissions, createdBy: actor.user.displayName || actor.user.accountId, createdAt: t, updatedAt: t };
    await db.appRoles.save(role);
    await audit(actor, [{ action: "ROLE_CREATED", entityType: "Role", entityId: role.id, details: "Role “" + role.name + "” created with " + permissions.length + " permission" + (permissions.length === 1 ? "" : "s"), meta: { targetRoleId: role.id, previousValue: "", newValue: permissions.join(", ") } }]);
    return roleDetail(role.id);
  });
}

function updateRole(actor, roleId, body) {
  return withLock(async () => {
    const role = await mustRole(roleId);
    const text = cleanRoleText(body, { requireName: false });
    const next = { ...role };
    const changes = [];
    if (text.name !== undefined && text.name !== role.name) {
      if (role.isSystem) throw new HttpError(400, "Built-in roles keep their name — you can edit the description and permissions.", "SYSTEM_ROLE", { field: "name" });
      await assertNameFree(text.name, role.id);
      changes.push("name “" + role.name + "” → “" + text.name + "”");
      next.name = text.name;
    }
    if (text.description !== undefined && text.description !== role.description) { changes.push("description changed"); next.description = text.description; }
    if (body && body.isActive !== undefined && typeof body.isActive !== "boolean") throw new HttpError(400, "isActive must be true or false.", "BAD_ACTIVE");
    if (body && typeof body.isActive === "boolean" && body.isActive !== (role.isActive !== false)) {
      if (role.isSystem && !body.isActive) throw new HttpError(400, "Built-in roles can’t be switched off.", "SYSTEM_ROLE");
      if (!body.isActive) {
        const holders = (await db.appUsers.list()).filter((u) => u.roleId === role.id).length;
        if (holders) throw new HttpError(409, holders + " user" + (holders === 1 ? " has" : "s have") + " this role — move them to another role before switching it off.", "ROLE_IN_USE");
      }
      changes.push(body.isActive ? "activated" : "deactivated");
      next.isActive = body.isActive;
    }
    if (!changes.length) return roleDetail(roleId);
    next.updatedAt = nowIso();
    await db.appRoles.save(next);
    await audit(actor, [{ action: "ROLE_UPDATED", entityType: "Role", entityId: role.id, details: "Role “" + role.name + "”: " + changes.join("; "), meta: { targetRoleId: role.id, previousValue: role.name + (role.isActive === false ? " (inactive)" : ""), newValue: next.name + (next.isActive === false ? " (inactive)" : "") } }]);
    return roleDetail(roleId);
  });
}

function diffPerms(before, after) {
  const b = new Set(before), a = new Set(after);
  const order = (k) => { const i = P.ALL_PERMISSIONS.indexOf(k); return i < 0 ? 999 : i; };
  const byCatalogue = (x, y) => order(x) - order(y);
  return { added: after.filter((k) => !b.has(k)).sort(byCatalogue), removed: before.filter((k) => !a.has(k)).sort(byCatalogue) };
}
function setRolePermissions(actor, roleId, list, { reset } = {}) {
  return withLock(async () => {
    const role = await mustRole(roleId);
    if (role.systemKey === "super_admin") throw new HttpError(400, "Super Admin always holds every permission and can’t be reduced.", "SYSTEM_ROLE");
    ownRoleGuard(actor, role);
    let permissions;
    if (reset) {
      const def = P.SYSTEM_ROLES.find((d) => d.key === role.systemKey);
      if (!def) throw new HttpError(400, "Only built-in roles have defaults to reset to.", "NOT_SYSTEM");
      permissions = def.permissions.slice();
    } else permissions = permsOrThrow(list);
    const d = diffPerms(role.permissions, permissions);
    if (!d.added.length && !d.removed.length) return roleDetail(roleId);
    assertCanGrant(actor, d.added);
    await db.appRoles.save({ ...role, permissions, updatedAt: nowIso() });
    await audit(actor, [{
      action: "ROLE_PERMISSIONS_UPDATED", entityType: "Role", entityId: role.id,
      details: "Role “" + role.name + "” permissions" + (reset ? " reset to defaults" : " updated") + (d.added.length ? " — added: " + d.added.join(", ") : "") + (d.removed.length ? " — removed: " + d.removed.join(", ") : ""),
      meta: { targetRoleId: role.id, previousValue: role.permissions.join(", "), newValue: permissions.join(", ") },
    }]);
    return roleDetail(roleId);
  });
}

function deleteRole(actor, roleId) {
  return withLock(async () => {
    const role = await mustRole(roleId);
    if (role.isSystem) throw new HttpError(400, "Built-in roles can’t be deleted.", "SYSTEM_ROLE");
    const holders = (await db.appUsers.list()).filter((u) => u.roleId === role.id);
    if (holders.length) throw new HttpError(409, holders.length + " user" + (holders.length === 1 ? " has" : "s have") + " this role. Move them to another role first, then delete it.", "ROLE_IN_USE", { userCount: holders.length });
    try { await db.appRoles.delete(role.id); } catch (e) {
      if (e.code === "ROLE_IN_USE") throw new HttpError(409, "Users have this role. Move them first.", "ROLE_IN_USE");
      throw e;
    }
    await audit(actor, [{ action: "ROLE_DELETED", entityType: "Role", entityId: role.id, details: "Role “" + role.name + "” deleted", meta: { targetRoleId: role.id, previousValue: role.name + " — " + role.permissions.join(", "), newValue: "" } }]);
    return { ok: true };
  });
}

// Operator tool (scripts/bootstrap-super-admin.js) — NOT reachable over HTTP.
// Registers (if needed) and promotes a Jira accountId to Super Admin. Refuses
// when an active Super Admin already exists unless `force` is set.
function bootstrapSuperAdmin(accountId, { force, displayName } = {}) {
  return withLock(async () => {
    if (!ACCOUNT_ID_RE.test(String(accountId || ""))) throw new HttpError(400, "That doesn’t look like a Jira account id.");
    const sa = await systemRole("super_admin");
    if (!force && (await countActiveSuperAdmins()) > 0) throw new HttpError(409, "An active Super Admin already exists. Use --force to add another.", "SUPER_ADMIN_EXISTS");
    const t = nowIso();
    let user = await db.appUsers.getByAccountId(accountId);
    if (!user) {
      user = { id: crypto.randomUUID(), accountId, displayName: short(displayName || "", 200), email: "", avatarUrl: "", roleId: null, status: "PENDING", teamMemberId: null, overrides: {}, legacyAdopted: false, createdAt: t, updatedAt: t, lastLoginAt: null, statusChangedAt: null };
      await db.appUsers.insertIfNew(user);
      await audit({ name: "System (operator)" }, [{ action: "USER_REGISTERED", entityType: "User", entityId: user.id, details: userLabel(user) + " registered by the operator bootstrap script", meta: { targetUserId: user.id, newValue: "PENDING" } }]);
    }
    const prev = await roleOf(user);
    const next = { ...user, roleId: sa.id, status: "ACTIVE", overrides: {}, statusChangedAt: t, updatedAt: t };
    await db.appUsers.save(next);
    await audit({ name: "System (operator)" }, [
      { action: "USER_ROLE_CHANGED", entityType: "User", entityId: user.id, details: userLabel(user) + " made Super Admin by the operator bootstrap script", meta: { targetUserId: user.id, targetRoleId: sa.id, previousValue: prev ? prev.name : "No role", newValue: sa.name } },
      ...(user.status !== "ACTIVE" ? [{ action: "USER_ACTIVATED", entityType: "User", entityId: user.id, details: userLabel(user) + " activated (bootstrap)", meta: { targetUserId: user.id, previousValue: user.status, newValue: "ACTIVE" } }] : []),
    ]);
    return next;
  });
}

module.exports = {
  STATUSES, ensureSystemRoles, registerOrUpdateOnLogin, loadAccess, bootstrapIds, countActiveSuperAdmins,
  usersView, userDetail, userAudit, rolesView, roleDetail,
  createUser, assignRole, setStatus, linkTeamMember, linkSelf, setOverride, removeOverride,
  createRole, updateRole, setRolePermissions, deleteRole, bootstrapSuperAdmin, _resetForTests,
};
