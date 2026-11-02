/* ============================================================
   ADMINISTRATION — Users, and Roles & Permissions
   Loaded after app.js, which hands over a small context (GreenlightCtx:
   state, helpers, modal functions). Everything here only DRAWS and calls the
   /api/users and /api/roles routes; the server decides what each person may
   do (permission checks, no self-promotion, no privilege escalation, the last
   Super Admin is protected) and answers with a clear message when it says no.
   Uses the same patterns as app.js: delegated clicks (data-adm="…"), full
   re-render of the page, openModal for dialogs.
   ============================================================ */
(function(){
"use strict";
var C = null; // GreenlightCtx
var A = {
  users: null, roles: null, catalog: null, statuses: ["PENDING","ACTIVE","INACTIVE"],
  loaded: {adminUsers:false, adminRoles:false}, error: "",
  f: {q:"", role:"", status:""},
  detail: null,          // open user-details modal: {user, audit, busy}
  roleEdit: null,        // open role editor: {id|null, name, description, perms:Set, readOnly...}
  roleUsers: {}          // roleId -> expanded list
};

function esc(s){ return C.esc(s); }
function can(p){ return C.can(p); }
function myUserId(){ return C.state.access && C.state.access.userId; }
function api(method, path, body){ return C.apiCall(method, path, body); }
function toast(m){ C.showToast(m); }
function errMsg(e){ return (e && e.message) || "Something went wrong."; }

/* ---------------- loading ---------------- */
function loadUsers(){
  var p = api("GET","/users").then(function(d){ A.users = d.users || []; if(d.statuses) A.statuses = d.statuses; });
  // Roles feed the role pickers; people who can manage users but not view roles still get a usable list from the users themselves.
  var r = can("roles.view") ? loadRoles() : Promise.resolve();
  return Promise.all([p, r]).then(function(){ A.loaded.adminUsers = true; A.error = ""; }).catch(function(e){ A.error = errMsg(e); A.loaded.adminUsers = true; });
}
function loadRoles(){
  return api("GET","/roles").then(function(d){ A.roles = d.roles || []; A.catalog = d.catalog || []; A.loaded.adminRoles = true; A.error = ""; })
    .catch(function(e){ A.error = errMsg(e); A.loaded.adminRoles = true; });
}
function load(view){
  if(view === "adminUsers") return loadUsers();
  return loadRoles();
}
function repaint(){ C.render(); }

/* ---------------- shared bits ---------------- */
function statusPill(st){
  var tone = st === "ACTIVE" ? "go" : (st === "PENDING" ? "warn" : "neutral");
  var label = st === "ACTIVE" ? "Active" : (st === "PENDING" ? "Pending" : "Inactive");
  return C.pill(label, tone);
}
function activeRoles(){ return (A.roles || []).filter(function(r){ return r.isActive !== false; }); }
function roleOptionsHtml(selectedId, opts){
  opts = opts || {};
  var list = A.roles ? activeRoles() : [];
  // keep a currently-held but switched-off role visible, so the select shows the truth
  if(selectedId && !list.some(function(r){ return r.id === selectedId; })){
    var held = (A.roles || []).filter(function(r){ return r.id === selectedId; })[0];
    if(held) list = list.concat([held]);
  }
  var h = '<option value="">'+esc(opts.none || "— No role (pending) —")+'</option>';
  list.forEach(function(r){
    h += '<option value="'+esc(r.id)+'"'+(r.id === selectedId ? ' selected' : '')+(r.isActive === false ? ' disabled' : '')+'>'+esc(r.name)+(r.isActive === false ? ' (off)' : '')+'</option>';
  });
  return h;
}
function groupLabel(key){
  var g = (A.catalog || []).filter(function(x){ return x.key === key; })[0];
  if(g) return g.label;
  return key.replace(/_/g," ").replace(/\b\w/g, function(c){ return c.toUpperCase(); });
}
function permLabel(key){
  var out = key;
  (A.catalog || []).forEach(function(g){ g.permissions.forEach(function(p){ if(p.key === key) out = p.label; }); });
  return out;
}
function when(iso){ return (iso && C.fmtDateTime(iso)) || "—"; }
function dateOnly(iso){ var t = iso && C.fmtDateTime(iso); return t ? t.split(",")[0] : "—"; }
function detailOpen(){ if(A.detail && !C.qs(".adm-detail")) A.detail = null; return A.detail; }
function ago(iso){ return iso ? C.fmtRelativeTime(iso) : "Never"; }
function actionLabel(a){
  var map = {USER_REGISTERED:"Registered", USER_ROLE_CHANGED:"Role changed", USER_ACTIVATED:"Activated", USER_DEACTIVATED:"Deactivated",
    USER_PERMISSION_OVERRIDE_ADDED:"Override added", USER_PERMISSION_OVERRIDE_REMOVED:"Override removed", TEAM_MEMBER_LINKED:"Linked to Team Member", TEAM_MEMBER_UNLINKED:"Unlinked from Team Member"};
  return map[a] || a;
}

/* ============================================================
   USERS PAGE
   ============================================================ */
function filteredUsers(){
  var q = A.f.q.trim().toLowerCase();
  return (A.users || []).filter(function(u){
    if(A.f.role === "__none__" ? !!u.roleId : (A.f.role && u.roleId !== A.f.role)) return false;
    if(A.f.status && u.status !== A.f.status) return false;
    if(q && (u.displayName + " " + u.email + " " + u.accountId + " " + u.roleName).toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
}
function userRowHtml(u){
  var self = u.id === myUserId();
  var roleCell;
  if(can("users.assign_roles") && !self && A.roles){
    roleCell = '<select class="adm-select" data-adm-change="user-role" data-id="'+esc(u.id)+'" aria-label="Role for '+esc(u.displayName || u.accountId)+'">'+roleOptionsHtml(u.roleId)+'</select>';
  } else {
    roleCell = u.roleName ? esc(u.roleName)+(u.roleActive === false ? ' <span class="hint">(off)</span>' : '') : '<span class="hint">No role</span>';
  }
  var toggle = "";
  if(can("users.deactivate") && !self){
    toggle = u.status === "INACTIVE"
      ? '<button type="button" class="btn btn-sm" data-adm="user-activate" data-id="'+esc(u.id)+'">Activate</button>'
      : '<button type="button" class="btn btn-sm" data-adm="user-deactivate" data-id="'+esc(u.id)+'">Deactivate</button>';
  }
  return '<tr data-uid="'+esc(u.id)+'">'+
    '<td data-label="Name"><button type="button" class="adm-name" data-adm="user-open" data-id="'+esc(u.id)+'">'+esc(u.displayName || u.accountId)+'</button>'+(self?' <span class="badge badge-me">You</span>':'')+
      '<div class="hint">'+esc(u.email || "No email shared")+'</div></td>'+
    '<td data-label="Jira account ID" class="mono adm-acct" title="'+esc(u.accountId)+'">'+esc(u.accountId)+'</td>'+
    '<td data-label="Role">'+roleCell+'</td>'+
    '<td data-label="Status">'+statusPill(u.status)+'</td>'+
    '<td data-label="Last login" class="adm-when" title="'+esc(when(u.lastLoginAt))+'">'+esc(ago(u.lastLoginAt))+'</td>'+
    '<td data-label="Created" class="adm-when" title="'+esc(when(u.createdAt))+'">'+esc(dateOnly(u.createdAt))+'</td>'+
    '<td class="adm-actions"><button type="button" class="btn btn-sm" data-adm="user-open" data-id="'+esc(u.id)+'">Details</button> '+toggle+'</td>'+
  '</tr>';
}
function usersBodyHtml(){
  var list = filteredUsers();
  if(!list.length) return '<tr><td colspan="7" class="adm-empty">No users match these filters.</td></tr>';
  return list.map(userRowHtml).join("");
}
function usersCountText(){
  var all = (A.users || []).length, n = filteredUsers().length;
  return n === all ? all + " user" + (all === 1 ? "" : "s") : n + " of " + all + " users";
}
function renderUsers(){
  var head = '<div class="list-head"><div><h1>Users</h1><p>People who signed in with Jira. Access is given by role — nobody is an administrator by default.</p></div>'+
    '<div class="list-head-actions">'+(can("users.create") ? '<button type="button" class="btn btn-primary" data-adm="user-add">+ Add user</button>' : '')+'</div></div>';
  if(!A.loaded.adminUsers) return head + '<div class="empty-state"><h3>Loading users…</h3></div>';
  if(A.error && !A.users) return head + '<div class="empty-state"><h3>Couldn’t load users</h3><p>'+esc(A.error)+'</p></div>';
  var pending = (A.users || []).filter(function(u){ return u.status === "PENDING"; }).length;
  var banner = pending ? '<div class="adm-banner">'+pending+' '+(pending === 1 ? 'person is' : 'people are')+' waiting for access. Give them a role to let them in.'+
    ' <button type="button" class="btn btn-sm" data-adm="filter-pending">Show pending</button></div>' : '';
  var roleOpts = '<option value="">All roles</option><option value="__none__"'+(A.f.role === "__none__" ? ' selected' : '')+'>No role</option>'+
    (A.roles || []).map(function(r){ return '<option value="'+esc(r.id)+'"'+(A.f.role === r.id ? ' selected' : '')+'>'+esc(r.name)+'</option>'; }).join("");
  var statusOpts = '<option value="">All statuses</option>'+["ACTIVE","PENDING","INACTIVE"].map(function(s){
    return '<option value="'+s+'"'+(A.f.status === s ? ' selected' : '')+'>'+s.charAt(0)+s.slice(1).toLowerCase()+'</option>'; }).join("");
  var filters = '<div class="adm-filters">'+
    '<input type="search" id="adm-search" class="adm-search" data-adm-input="user-search" placeholder="Search name, email, Jira account ID or role…" value="'+esc(A.f.q)+'" aria-label="Search users">'+
    '<select data-adm-change="user-filter-role" aria-label="Filter by role">'+roleOpts+'</select>'+
    '<select data-adm-change="user-filter-status" aria-label="Filter by status">'+statusOpts+'</select>'+
    '<span class="helper-text" id="adm-count">'+esc(usersCountText())+'</span></div>';
  var table = '<div class="dr-table-wrap"><table class="dr-table adm-table"><thead><tr>'+
    '<th>Name</th><th>Jira account ID</th><th>Role</th><th>Status</th><th>Last login</th><th>Created</th><th></th></tr></thead>'+
    '<tbody id="adm-users-body">'+usersBodyHtml()+'</tbody></table></div>';
  return head + banner + filters + table;
}
function repaintUsersTable(){
  var body = C.qs("#adm-users-body"); if(body) body.innerHTML = usersBodyHtml();
  var c = C.qs("#adm-count"); if(c) c.textContent = usersCountText();
}
function replaceUser(u){
  if(!A.users) return;
  for(var i=0;i<A.users.length;i++){ if(A.users[i].id === u.id){ A.users[i] = u; return; } }
  A.users.push(u);
}
// Detail objects carry everything the list row needs.
function afterUserChange(detail, msg){
  replaceUser(detail);
  if(detailOpen() && A.detail.user && A.detail.user.id === detail.id){ A.detail.user = detail; refreshAudit(detail.id); paintDetail(); }
  if(msg) toast(msg);
  if(C.currentRoute() === "adminUsers") repaint();
  // Changing the signed-in person's own record can't happen here, but a role change may alter what OTHER pages show — nothing to refresh locally.
}
function assignRole(userId, roleId){
  return api("PUT","/users/"+encodeURIComponent(userId)+"/role", {roleId: roleId || null})
    .then(function(d){ afterUserChange(d, roleId ? "Role updated" : "Role removed — the user is pending again"); })
    .catch(function(e){ toast(errMsg(e)); repaint(); if(detailOpen()) paintDetail(); });
}
function setStatus(userId, status){
  return api("PUT","/users/"+encodeURIComponent(userId)+"/status", {status: status})
    .then(function(d){ afterUserChange(d, status === "INACTIVE" ? "User deactivated" : "User activated"); })
    .catch(function(e){ toast(errMsg(e)); repaint(); if(detailOpen()) paintDetail(); });
}
function userById(id){ return (A.users || []).filter(function(u){ return u.id === id; })[0]; }
function confirmDeactivate(id){
  var u = userById(id) || (A.detail && A.detail.user) || {};
  C.openConfirm("Deactivate this user?",
    "<b>"+esc(u.displayName || u.accountId || "This person")+"</b> will be signed out of every API call straight away and can’t use Greenlight until you activate them again. Their Team Member card, history and audit trail are kept.",
    "Deactivate", function(){ setStatus(id, "INACTIVE"); }, true);
}

/* ---- Add user ---- */
function openAddUser(){
  var body =
    '<p class="helper-text" style="margin:0;">Registers someone before their first sign-in. They still sign in with Jira; this just prepares their access. Use their <b>Jira account ID</b> (not an email address).</p>'+
    '<div class="field"><label for="adm-au-acct">Jira account ID</label><input type="text" id="adm-au-acct" required autocomplete="off" placeholder="e.g. 5b10ac8d82e05b22cc7d4ef5"><span class="hint">Open the person’s Atlassian profile — the ID is the last part of the address (…/people/<b>accountId</b>).</span></div>'+
    '<div class="field-row"><div class="field"><label for="adm-au-name">Name <span class="hint">(optional)</span></label><input type="text" id="adm-au-name"></div>'+
    '<div class="field"><label for="adm-au-email">Email <span class="hint">(optional)</span></label><input type="email" id="adm-au-email"></div></div>'+
    (can("users.assign_roles") && A.roles ? '<div class="field"><label for="adm-au-role">Role</label><select id="adm-au-role">'+roleOptionsHtml("")+'</select><span class="hint">Leave empty and the person stays pending until you give them a role.</span></div>' : '')+
    '<div class="adm-form-error" id="adm-au-err" role="alert"></div>';
  var foot = '<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Add user</button>';
  C.openModal(C.modalShell("Add user", body, foot));
  C.qs("#modal-form").addEventListener("submit", function(e){
    e.preventDefault();
    var btn = C.qs('#modal-form button[type="submit"]'); btn.disabled = true;
    var roleEl = C.qs("#adm-au-role");
    api("POST","/users", {
      accountId: C.qs("#adm-au-acct").value.trim(), displayName: C.qs("#adm-au-name").value.trim(), email: C.qs("#adm-au-email").value.trim(),
      roleId: roleEl && roleEl.value ? roleEl.value : null
    }).then(function(d){
      C.closeModal(); replaceUser(d); toast("User added"); repaint();
    }).catch(function(err){
      btn.disabled = false; C.qs("#adm-au-err").textContent = errMsg(err);
    });
  });
}

/* ---- User details ---- */
function openUser(id){
  A.detail = {user: userById(id) || {id:id, displayName:"Loading…"}, audit: null, loading: true};
  paintDetail();
  Promise.all([api("GET","/users/"+encodeURIComponent(id)), api("GET","/users/"+encodeURIComponent(id)+"/audit").catch(function(){ return []; })])
    .then(function(r){ if(!A.detail) return; A.detail.user = r[0]; A.detail.audit = r[1]; A.detail.loading = false; paintDetail(); })
    .catch(function(e){ toast(errMsg(e)); closeDetail(); });
}
function closeDetail(){ A.detail = null; C.closeModal(); }
function refreshAudit(id){
  api("GET","/users/"+encodeURIComponent(id)+"/audit").then(function(a){ if(A.detail && A.detail.user.id === id){ A.detail.audit = a; paintDetail(); } }).catch(function(){});
}
function permGroups(effective){
  var order = [], by = {};
  effective.forEach(function(p){
    var g = p.key.split(".")[0];
    if(!by[g]){ by[g] = []; order.push(g); }
    by[g].push(p);
  });
  return order.map(function(g){ return {key:g, items:by[g]}; });
}
function effectiveHtml(u){
  var eff = u.effective || [];
  if(!eff.length) return "";
  var granted = eff.filter(function(p){ return p.granted; }).length;
  var note = u.status !== "ACTIVE" ? '<p class="helper-text">This person is '+esc(u.status.toLowerCase())+', so they currently hold no permissions at all. Below is what they would hold once active.</p>' : '';
  var groups = permGroups(eff).map(function(g){
    return '<div class="adm-pgroup"><div class="adm-pgroup-h">'+esc(groupLabel(g.key))+'</div><div class="adm-chips">'+
      g.items.map(function(p){
        var cls = p.source === "override" ? "extra" : (p.source === "denied" ? "denied" : (p.granted ? "role" : "none"));
        var tip = p.source === "override" ? "Extra access from an individual override" : (p.source === "denied" ? "Denied by an individual override" : (p.granted ? "Granted by the role" : "Not granted"));
        return '<span class="adm-chip '+cls+'" title="'+esc(tip+" · "+p.key)+'">'+esc(permLabel(p.key))+'</span>';
      }).join("")+'</div></div>';
  }).join("");
  return '<section class="adm-sec"><h4>Effective permissions <span class="hint">('+granted+' of '+eff.length+')</span></h4>'+note+
    '<div class="adm-legend"><span class="adm-chip role">From role</span><span class="adm-chip extra">Extra (override)</span><span class="adm-chip denied">Denied (override)</span><span class="adm-chip none">Not granted</span></div>'+groups+'</section>';
}
function overridesHtml(u){
  var self = u.id === myUserId();
  var editable = can("users.assign_roles") && !self && !u.isSuperAdmin;
  var rows = (u.overrides || []).map(function(o){
    return '<tr><td>'+esc(permLabel(o.permission))+'<div class="hint mono">'+esc(o.permission)+'</div></td>'+
      '<td>'+C.pill(o.effect === "allow" ? "Allow" : "Deny", o.effect === "allow" ? "go" : "danger")+'</td>'+
      '<td>'+(o.expiresAt ? esc(dateOnly(o.expiresAt))+(o.expired ? ' <span class="hint">(expired)</span>' : '') : '<span class="hint">No expiry</span>')+'</td>'+
      '<td>'+esc(o.reason || "")+(o.createdBy ? '<div class="hint">by '+esc(o.createdBy)+'</div>' : '')+'</td>'+
      '<td>'+(editable ? '<button type="button" class="btn btn-sm" data-adm="override-remove" data-perm="'+esc(o.permission)+'">Remove</button>' : '')+'</td></tr>';
  }).join("");
  var table = rows ? '<div class="dr-table-wrap"><table class="dr-table adm-table"><thead><tr><th>Permission</th><th>Effect</th><th>Until</th><th>Reason</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    : '<p class="helper-text">No individual overrides. This person has exactly what their role gives. A <b>Deny</b> always wins over the role; an <b>Allow</b> adds access (optionally only until a date).</p>';
  var form = "";
  if(editable && A.catalog){
    var opts = A.catalog.map(function(g){
      return '<optgroup label="'+esc(g.label)+'">'+g.permissions.map(function(p){ return '<option value="'+esc(p.key)+'">'+esc(p.label)+' ('+esc(p.key)+')</option>'; }).join("")+'</optgroup>';
    }).join("");
    form = '<div class="adm-ovr-form">'+
      '<div class="field"><label for="adm-ov-perm">Permission</label><select id="adm-ov-perm">'+opts+'</select></div>'+
      '<div class="field"><label for="adm-ov-effect">Effect</label><select id="adm-ov-effect"><option value="allow">Allow (add access)</option><option value="deny">Deny (remove access)</option></select></div>'+
      '<div class="field"><label for="adm-ov-exp">Until <span class="hint">(optional)</span></label><input type="date" id="adm-ov-exp"></div>'+
      '<div class="field adm-ovr-reason"><label for="adm-ov-reason">Reason <span class="hint">(optional)</span></label><input type="text" id="adm-ov-reason" maxlength="200"></div>'+
      '<button type="button" class="btn btn-primary" data-adm="override-add">Save override</button></div>';
  }
  return '<section class="adm-sec"><h4>Individual overrides</h4>'+table+form+'</section>';
}
function teamSectionHtml(u){
  var editable = can("users.edit");
  var members = C.allTeamMembers();
  var cur = u.teamMember;
  var line = cur ? 'Linked to <b>'+esc(cur.name)+'</b>'+(cur.role ? ' <span class="hint">· '+esc(cur.role)+'</span>' : '') : '<span class="hint">Not linked to a Team Member card yet.</span>';
  var ctl = "";
  if(editable){
    ctl = '<div class="adm-inline"><select id="adm-tm-select" aria-label="Team Member"><option value="">— Choose a Team Member —</option>'+
      members.map(function(m){ return '<option value="'+esc(m.id)+'"'+(cur && cur.id === m.id ? ' selected' : '')+'>'+esc(m.name)+'</option>'; }).join("")+'</select>'+
      '<button type="button" class="btn btn-sm" data-adm="tm-link">Link</button>'+
      (cur ? '<button type="button" class="btn btn-sm" data-adm="tm-unlink">Unlink</button>' : '')+'</div>'+
      (!members.length ? '<p class="helper-text">The team list isn’t available to you.</p>' : '');
  }
  return '<section class="adm-sec"><h4>Team Member</h4><p>'+line+'</p>'+ctl+
    '<p class="helper-text">One person ↔ one card. Assignments, My Regression and the Daily QA Report follow this link. Deactivating a user keeps the card and its history.</p></section>';
}
function accessSectionHtml(u){
  var self = u.id === myUserId();
  var parts = "";
  if(can("users.assign_roles")){
    parts += '<div class="adm-inline"><label for="adm-d-role" class="adm-lbl">Role</label>'+
      (self || !A.roles ? '<b>'+esc(u.roleName || "No role")+'</b>' : '<select id="adm-d-role">'+roleOptionsHtml(u.roleId)+'</select><button type="button" class="btn btn-sm" data-adm="detail-role">Apply</button>')+'</div>';
  } else parts += '<div class="adm-inline"><span class="adm-lbl">Role</span><b>'+esc(u.roleName || "No role")+'</b></div>';
  if(can("users.deactivate") && !self){
    parts += '<div class="adm-inline"><span class="adm-lbl">Status</span>'+statusPill(u.status)+
      (u.status === "INACTIVE" ? '<button type="button" class="btn btn-sm" data-adm="detail-activate">Activate</button>' : '<button type="button" class="btn btn-sm" data-adm="detail-deactivate">Deactivate</button>')+'</div>';
  } else parts += '<div class="adm-inline"><span class="adm-lbl">Status</span>'+statusPill(u.status)+'</div>';
  if(self) parts += '<p class="helper-text">You can’t change your own role, status or permissions — ask another administrator.</p>';
  return '<section class="adm-sec"><h4>Role &amp; status</h4>'+parts+'</section>';
}
function auditHtml(d){
  if(d.audit == null) return '<section class="adm-sec"><h4>Audit history</h4><p class="helper-text">Loading…</p></section>';
  if(!d.audit.length) return '<section class="adm-sec"><h4>Audit history</h4><p class="helper-text">Nothing recorded for this person yet.</p></section>';
  return '<section class="adm-sec"><h4>Audit history</h4><div class="adm-audit">'+d.audit.map(function(e){
    return '<div class="adm-audit-row"><div><b>'+esc(actionLabel(e.action))+'</b> <span class="hint">· '+esc(e.userName || "")+'</span><div>'+esc(e.details || "")+'</div>'+
      (e.meta && (e.meta.previousValue || e.meta.newValue) ? '<div class="hint">'+esc(e.meta.previousValue || "—")+' → '+esc(e.meta.newValue || "—")+'</div>' : '')+'</div>'+
      '<div class="hint adm-audit-when" title="'+esc(when(e.createdAt))+'">'+esc(C.fmtRelativeTime(e.createdAt))+'</div></div>';
  }).join("")+'</div></section>';
}
function paintDetail(){
  var d = A.detail; if(!d) return;
  var u = d.user;
  var summary = '<dl class="adm-dl">'+
    '<div><dt>Jira account ID</dt><dd class="mono">'+esc(u.accountId || "")+'</dd></div>'+
    '<div><dt>Email</dt><dd>'+esc(u.email || "—")+'</dd></div>'+
    '<div><dt>Created</dt><dd>'+esc(when(u.createdAt))+'</dd></div>'+
    '<div><dt>Last login</dt><dd>'+esc(u.lastLoginAt ? when(u.lastLoginAt) : "Never")+'</dd></div></dl>';
  var body = d.loading ? '<p class="helper-text">Loading…</p>' :
    summary + accessSectionHtml(u) + teamSectionHtml(u) + effectiveHtml(u) + overridesHtml(u) + auditHtml(d);
  var prev = C.qs(".adm-detail"), keepScroll = prev ? prev.scrollTop : 0;
  C.openModal('<div class="modal-head"><h3>'+esc(u.displayName || u.accountId || "User")+' '+(u.status ? statusPill(u.status) : '')+'</h3>'+
    '<button class="btn btn-icon btn-ghost" data-adm="detail-close" aria-label="Close">×</button></div>'+
    '<div class="modal-body adm-detail">'+body+'</div>'+
    '<div class="modal-foot"><button type="button" class="btn" data-adm="detail-close">Close</button></div>', {xwide:true});
  var now = C.qs(".adm-detail"); if(now && keepScroll) now.scrollTop = keepScroll; // a refresh after an edit shouldn't jump back to the top
}

/* ============================================================
   ROLES PAGE
   ============================================================ */
function roleCardHtml(r){
  var kind = r.locked ? C.pill("Super Admin · locked","info") : (r.isSystem ? C.pill("System role","neutral") : C.pill("Custom","neutral"));
  var off = r.isActive === false ? ' '+C.pill("Inactive","warn") : '';
  var acts = '<button type="button" class="btn btn-sm" data-adm="role-open" data-id="'+esc(r.id)+'">'+(can("roles.edit") || can("roles.manage_permissions") ? (r.locked ? 'View' : 'Edit') : 'View')+'</button> '+
    '<button type="button" class="btn btn-sm" data-adm="role-users" data-id="'+esc(r.id)+'">Users ('+r.userCount+')</button>';
  if(!r.isSystem && can("roles.edit")){
    acts += ' <button type="button" class="btn btn-sm" data-adm="role-toggle" data-id="'+esc(r.id)+'">'+(r.isActive === false ? 'Activate' : 'Deactivate')+'</button>';
  }
  if(!r.isSystem && can("roles.delete")){
    acts += ' <button type="button" class="btn btn-sm btn-danger" data-adm="role-delete" data-id="'+esc(r.id)+'"'+(r.userCount ? ' disabled title="Move the users with this role elsewhere first"' : '')+'>Delete</button>';
  }
  var count = r.locked ? "All" : (r.permissions || []).length;
  return '<div class="card adm-role'+(r.isActive === false ? ' is-off' : '')+'">'+
    '<div class="adm-role-head"><h3>'+esc(r.name)+'</h3><div>'+kind+off+'</div></div>'+
    '<p class="adm-role-desc">'+esc(r.description || "No description.")+'</p>'+
    '<div class="adm-role-stats"><span><b>'+r.userCount+'</b> user'+(r.userCount === 1 ? '' : 's')+'</span><span><b>'+count+'</b> permission'+(count === 1 ? '' : 's')+'</span></div>'+
    '<div class="adm-role-actions">'+acts+'</div></div>';
}
function renderRoles(){
  var head = '<div class="list-head"><div><h1>Roles &amp; Permissions</h1><p>A role is a named set of permissions. Everything in Greenlight is allowed or refused by permission, never by role name.</p></div>'+
    '<div class="list-head-actions">'+(can("roles.create") ? '<button type="button" class="btn btn-primary" data-adm="role-new">+ New role</button>' : '')+'</div></div>';
  if(!A.loaded.adminRoles) return head + '<div class="empty-state"><h3>Loading roles…</h3></div>';
  if(A.error && !A.roles) return head + '<div class="empty-state"><h3>Couldn’t load roles</h3><p>'+esc(A.error)+'</p></div>';
  var sys = (A.roles || []).filter(function(r){ return r.isSystem; });
  var custom = (A.roles || []).filter(function(r){ return !r.isSystem; });
  var legacyNote = "";
  return head +
    '<h2 class="adm-h2">System roles</h2><div class="adm-roles">'+sys.map(roleCardHtml).join("")+'</div>'+
    '<h2 class="adm-h2">Custom roles</h2>'+(custom.length ? '<div class="adm-roles">'+custom.map(roleCardHtml).join("")+'</div>'
      : '<div class="empty-state" style="padding:24px;"><p>No custom roles yet.'+(can("roles.create") ? ' Create one to give a group of people exactly the access they need.' : '')+'</p></div>') + legacyNote;
}

/* ---- role editor ---- */
function openRoleEditor(role){
  var isNew = !role;
  var locked = !!(role && role.locked);
  var canEditText = isNew ? can("roles.create") : can("roles.edit");
  var canPerms = (isNew ? can("roles.create") && can("roles.manage_permissions") : can("roles.manage_permissions")) && !locked;
  A.roleEdit = {
    id: role ? role.id : null, isSystem: !!(role && role.isSystem), locked: locked,
    name: role ? role.name : "", description: role ? role.description || "" : "",
    perms: role ? (locked ? allPermKeys() : (role.permissions || []).slice()) : [],
    orig: role ? (locked ? allPermKeys() : (role.permissions || []).slice()) : [],
    canText: canEditText && !locked, canPerms: canPerms
  };
  paintRoleEditor();
}
function allPermKeys(){
  var out = []; (A.catalog || []).forEach(function(g){ g.permissions.forEach(function(p){ out.push(p.key); }); }); return out;
}
function paintRoleEditor(){
  var E = A.roleEdit; if(!E) return;
  var groups = (A.catalog || []).map(function(g){
    var keys = g.permissions.map(function(p){ return p.key; });
    var n = keys.filter(function(k){ return E.perms.indexOf(k) !== -1; }).length;
    var all = n === keys.length;
    return '<div class="adm-pgroup'+(g.restricted ? ' restricted' : '')+'"><div class="adm-pgroup-h">'+
      '<label class="adm-check"><input type="checkbox" data-adm-change="role-group" data-group="'+esc(g.key)+'"'+(all ? ' checked' : '')+(E.canPerms ? '' : ' disabled')+'> <b>'+esc(g.label)+'</b></label>'+
      '<span class="hint adm-gcount" data-group="'+esc(g.key)+'">'+n+'/'+keys.length+'</span>'+(g.restricted ? ' <span class="hint">· sensitive</span>' : '')+'</div>'+
      '<div class="adm-plist">'+g.permissions.map(function(p){
        return '<label class="adm-check"><input type="checkbox" data-adm-change="role-perm" value="'+esc(p.key)+'"'+(E.perms.indexOf(p.key) !== -1 ? ' checked' : '')+(E.canPerms ? '' : ' disabled')+'> <span>'+esc(p.label)+'</span> <span class="hint mono">'+esc(p.key)+'</span></label>';
      }).join("")+'</div></div>';
  }).join("");
  var body =
    (E.locked ? '<p class="helper-text" style="margin:0;">Super Admin always holds every permission, including ones added in future versions. It can’t be edited, so administration can never be locked out.</p>' : '')+
    '<div class="field"><label for="adm-r-name">Name</label><input type="text" id="adm-r-name" maxlength="80" value="'+esc(E.name)+'"'+(E.canText && !E.isSystem ? '' : ' disabled')+(E.isSystem ? ' title="Built-in roles keep their name"' : '')+'></div>'+
    '<div class="field"><label for="adm-r-desc">Description</label><textarea id="adm-r-desc" rows="2" maxlength="300"'+(E.canText ? '' : ' disabled')+'>'+esc(E.description)+'</textarea></div>'+
    '<div class="adm-permhead"><b>Permissions</b>'+(E.canPerms ? '' : '<span class="hint"> · read-only</span>')+'</div>'+
    '<div class="adm-pgrid">'+groups+'</div>'+
    '<div class="adm-form-error" id="adm-r-err" role="alert"></div>';
  var canSave = !E.locked && (E.canText || E.canPerms);
  var foot = (E.isSystem && E.canPerms && !E.locked ? '<button type="button" class="btn" data-adm="role-reset">Reset to defaults</button>' : '<span></span>')+
    '<span style="flex:1"></span><button type="button" class="btn" data-adm="role-close">'+(canSave ? 'Cancel' : 'Close')+'</button>'+
    (canSave ? '<button type="submit" class="btn btn-primary">'+(E.id ? 'Save changes' : 'Create role')+'</button>' : '');
  C.openModal(C.modalShell(E.id ? (E.locked ? E.name : 'Edit role') : 'New role', body, foot, "adm-role-form"), {xwide:true});
  var form = C.qs("#adm-role-form");
  form.addEventListener("submit", function(e){ e.preventDefault(); saveRole(); });
  refreshEditorChecks();
}
// Ticks / unticks the boxes in place (so the long list doesn't jump back to the top while you click).
function refreshEditorChecks(){
  var E = A.roleEdit; if(!E) return;
  C.qsa("input[data-adm-change=role-perm]").forEach(function(cb){ cb.checked = E.perms.indexOf(cb.value) !== -1; });
  (A.catalog || []).forEach(function(g){
    var keys = g.permissions.map(function(p){ return p.key; });
    var n = keys.filter(function(k){ return E.perms.indexOf(k) !== -1; }).length;
    var gc = C.qs('input[data-adm-change=role-group][data-group="'+g.key+'"]');
    if(gc){ gc.checked = n === keys.length; gc.indeterminate = n > 0 && n < keys.length; }
    var cnt = C.qs('.adm-gcount[data-group="'+g.key+'"]'); if(cnt) cnt.textContent = n+"/"+keys.length;
  });
}
function syncEditorFromDom(){
  var E = A.roleEdit; if(!E) return;
  var n = C.qs("#adm-r-name"), d = C.qs("#adm-r-desc");
  if(n && !n.disabled) E.name = n.value;
  if(d && !d.disabled) E.description = d.value;
}
function setGroup(groupKey, on){
  var E = A.roleEdit;
  var g = (A.catalog || []).filter(function(x){ return x.key === groupKey; })[0]; if(!g) return;
  g.permissions.forEach(function(p){
    var i = E.perms.indexOf(p.key);
    if(on && i === -1) E.perms.push(p.key);
    if(!on && i !== -1) E.perms.splice(i, 1);
  });
}
function sameSet(a, b){ return a.length === b.length && a.every(function(x){ return b.indexOf(x) !== -1; }); }
function saveRole(){
  syncEditorFromDom();
  var E = A.roleEdit; if(!E) return;
  var err = C.qs("#adm-r-err"), btn = C.qs('#adm-role-form button[type="submit"]');
  if(!E.name.trim() && !E.isSystem){ err.textContent = "Give the role a name."; return; }
  if(btn) btn.disabled = true;
  var done = function(msg){ A.roleEdit = null; C.closeModal(); toast(msg); loadRoles().then(function(){ repaint(); }); };
  var fail = function(e){ if(btn) btn.disabled = false; err.textContent = errMsg(e); };
  if(!E.id){
    api("POST","/roles", {name: E.name.trim(), description: E.description.trim(), permissions: E.perms}).then(function(){ done("Role created"); }).catch(fail);
    return;
  }
  var orig = (A.roles || []).filter(function(r){ return r.id === E.id; })[0] || {};
  var textChanged = E.canText && ((!E.isSystem && E.name.trim() !== orig.name) || E.description.trim() !== (orig.description || ""));
  var permsChanged = E.canPerms && !sameSet(E.perms, E.orig);
  var p = Promise.resolve();
  if(textChanged) p = p.then(function(){ var b = {description: E.description.trim()}; if(!E.isSystem) b.name = E.name.trim(); return api("PUT","/roles/"+encodeURIComponent(E.id), b); });
  if(permsChanged) p = p.then(function(){ return api("PUT","/roles/"+encodeURIComponent(E.id)+"/permissions", {permissions: E.perms}); });
  p.then(function(){ done(textChanged || permsChanged ? "Role saved" : "Nothing to change"); }).catch(fail);
}
function openRoleUsers(id){
  api("GET","/roles/"+encodeURIComponent(id)).then(function(r){
    var rows = (r.users || []).map(function(u){
      return '<div class="adm-audit-row"><div><b>'+esc(u.displayName)+'</b></div><div>'+statusPill(u.status)+'</div></div>';
    }).join("") || '<p class="helper-text">Nobody has this role yet.</p>';
    C.openModal('<div class="modal-head"><h3>Users with “'+esc(r.name)+'”</h3><button class="btn btn-icon btn-ghost" data-action="close-modal" aria-label="Close">×</button></div>'+
      '<div class="modal-body"><div class="adm-audit">'+rows+'</div></div><div class="modal-foot"><button type="button" class="btn" data-action="close-modal">Close</button></div>', {confirm:true});
  }).catch(function(e){ toast(errMsg(e)); });
}
function roleById(id){ return (A.roles || []).filter(function(r){ return r.id === id; })[0]; }

/* ============================================================
   EVENTS
   ============================================================ */
function onClick(e){
  var t = e.target.closest && e.target.closest("[data-adm]");
  if(!t || t.disabled) return;
  var a = t.getAttribute("data-adm"), id = t.getAttribute("data-id");
  switch(a){
    case "user-add": openAddUser(); break;
    case "user-open": openUser(id); break;
    case "user-activate": setStatus(id, "ACTIVE"); break;
    case "user-deactivate": confirmDeactivate(id); break;
    case "filter-pending": A.f.status = "PENDING"; repaint(); break;
    case "detail-close": closeDetail(); break;
    case "detail-role": { var sel = C.qs("#adm-d-role"); if(sel) assignRole(A.detail.user.id, sel.value); break; }
    case "detail-activate": setStatus(A.detail.user.id, "ACTIVE"); break;
    case "detail-deactivate": confirmDeactivate(A.detail.user.id); break;
    case "tm-link": {
      var s2 = C.qs("#adm-tm-select"); if(!s2 || !s2.value){ toast("Choose a Team Member first."); break; }
      api("PUT","/users/"+encodeURIComponent(A.detail.user.id)+"/team-member", {teamMemberId: s2.value})
        .then(function(d){ afterUserChange(d, "Linked to Team Member"); }).catch(function(er){ toast(errMsg(er)); paintDetail(); });
      break;
    }
    case "tm-unlink":
      api("PUT","/users/"+encodeURIComponent(A.detail.user.id)+"/team-member", {teamMemberId: null})
        .then(function(d){ afterUserChange(d, "Team Member unlinked — the card and its history are kept"); }).catch(function(er){ toast(errMsg(er)); paintDetail(); });
      break;
    case "override-add": {
      var perm = C.qs("#adm-ov-perm").value, effect = C.qs("#adm-ov-effect").value, exp = C.qs("#adm-ov-exp").value, reason = C.qs("#adm-ov-reason").value.trim();
      var body = {effect: effect, reason: reason};
      if(exp){ body.expiresAt = new Date(exp + "T23:59:59").toISOString(); }
      api("PUT","/users/"+encodeURIComponent(A.detail.user.id)+"/overrides/"+encodeURIComponent(perm), body)
        .then(function(d){ afterUserChange(d, "Override saved"); }).catch(function(er){ toast(errMsg(er)); });
      break;
    }
    case "override-remove":
      api("DELETE","/users/"+encodeURIComponent(A.detail.user.id)+"/overrides/"+encodeURIComponent(t.getAttribute("data-perm")))
        .then(function(d){ afterUserChange(d, "Override removed"); }).catch(function(er){ toast(errMsg(er)); });
      break;
    case "role-new": openRoleEditor(null); break;
    case "role-open": { var r = roleById(id); if(r) openRoleEditor(r); break; }
    case "role-close": A.roleEdit = null; C.closeModal(); break;
    case "role-users": openRoleUsers(id); break;
    case "role-toggle": {
      var rr = roleById(id); if(!rr) break;
      api("PUT","/roles/"+encodeURIComponent(id), {isActive: rr.isActive === false})
        .then(function(){ toast(rr.isActive === false ? "Role activated" : "Role deactivated"); return loadRoles(); }).then(repaint)
        .catch(function(er){ toast(errMsg(er)); });
      break;
    }
    case "role-delete": {
      var rd = roleById(id); if(!rd) break;
      C.openConfirm("Delete this role?", "<b>"+esc(rd.name)+"</b> will be removed. This can’t be undone. Roles that people hold can’t be deleted.", "Delete", function(){
        api("DELETE","/roles/"+encodeURIComponent(id)).then(function(){ toast("Role deleted"); return loadRoles(); }).then(repaint).catch(function(er){ toast(errMsg(er)); });
      }, true);
      break;
    }
    case "role-reset": {
      var E = A.roleEdit; if(!E || !E.id) break;
      C.openConfirm("Reset to defaults?", "This role’s permissions go back to what Greenlight ships with. The change is recorded in the audit log.", "Reset", function(){
        api("POST","/roles/"+encodeURIComponent(E.id)+"/reset-permissions").then(function(){ A.roleEdit = null; toast("Permissions reset"); return loadRoles(); }).then(repaint).catch(function(er){ toast(errMsg(er)); });
      }, false);
      break;
    }
  }
}
function onChange(e){
  var t = e.target.closest && e.target.closest("[data-adm-change]");
  if(!t) return;
  var a = t.getAttribute("data-adm-change");
  switch(a){
    case "user-role": assignRole(t.getAttribute("data-id"), t.value); break;
    case "user-filter-role": A.f.role = t.value; repaintUsersTable(); break;
    case "user-filter-status": A.f.status = t.value; repaintUsersTable(); break;
    case "role-perm": {
      syncEditorFromDom();
      var E = A.roleEdit, k = t.value, i = E.perms.indexOf(k);
      if(t.checked && i === -1) E.perms.push(k);
      if(!t.checked && i !== -1) E.perms.splice(i, 1);
      refreshEditorChecks();
      break;
    }
    case "role-group": syncEditorFromDom(); setGroup(t.getAttribute("data-group"), t.checked); refreshEditorChecks(); break;
  }
}
function onInput(e){
  var t = e.target.closest && e.target.closest("[data-adm-input]");
  if(!t) return;
  if(t.getAttribute("data-adm-input") === "user-search"){ A.f.q = t.value; repaintUsersTable(); }
}

window.GreenlightAdmin = {
  init: function(ctx){
    C = ctx;
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("input", onInput);
  },
  load: load,
  render: function(view){ return view === "adminUsers" ? renderUsers() : renderRoles(); }
};
// app.js ran before this file was parsed (it only knows the hook name): hand over the context now.
if(window.GreenlightCtx) window.GreenlightAdmin.init(window.GreenlightCtx);
})();
