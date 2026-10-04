// QA assignment — identity resolution, legacy-name migration, and the
// diff that turns a release save into audit events.
//
// ONE source of truth for who a person is: Know the Team (db.team). Every
// assignment in a release stores a team member's stable `id` (`assignedTo`),
// never a display name:
//
//   ticket.assignedTo      member id | null.  The KEY being present at all
//                          marks a manual choice (null = explicitly
//                          unassigned); a ticket with no `assignedTo` key
//                          simply follows Jira's own "QA Assigned" field
//                          (ticket.qaAssignedFromJira, refreshed on sync).
//   entity.assignedTo      member id | null.  Who covers the whole Entity.
//   service.assignedTo     (optional) a per-module override. Absent = use
//                          the Entity's owner; an id = that member; null =
//                          explicitly unassigned even though the Entity has
//                          an owner. Precedence: module > entity > nobody.
//
// This module is dependency-free (no express/db) so it can be unit-tested
// directly. routes/releases.js calls migrateReleaseAssignments() on every
// release it reads/writes and diffReleaseActivity() on every save.

const UNSET = Symbol("unset");

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// A name normalized only for the ONE-TIME legacy migration (turning an old
// free-text owner such as "Sara' Abu-Rumman" into that person's team member
// id). Never used as an identifier afterwards.
function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactName(name) {
  return normalizeName(name).replace(/ /g, "");
}

function indexTeam(team) {
  const byId = new Map();
  const byName = new Map(); // compact name (or Jira name) -> id, only when UNIQUE
  const claims = new Map(); // key -> set of member ids claiming it
  for (const m of team || []) {
    if (!m || !m.id) continue;
    byId.set(m.id, m);
    const names = [m.name].concat(Array.isArray(m.jiraNames) ? m.jiraNames : []);
    for (const n of names) {
      const key = compactName(n);
      if (!key) continue;
      if (!claims.has(key)) claims.set(key, new Set());
      claims.get(key).add(m.id);
    }
  }
  // Two members claiming the same name would make a match a guess — leave
  // those unresolved rather than picking one.
  for (const [key, ids] of claims) if (ids.size === 1) byName.set(key, [...ids][0]);
  return { byId, byName };
}

function resolveNameToId(name, index) {
  const key = compactName(name);
  return key && index.byName.has(key) ? index.byName.get(key) : null;
}

function cleanId(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v ? v.slice(0, 200) : null;
}

// The team member behind a signed-in Atlassian account: the Know the Team
// entry the user pinned with "This is me" (member.linkedEmail). Returns
// {id, name} — id is null when the user hasn't linked themselves yet (their
// own Atlassian name is then only a display label, never an identity).
function resolveActor(authUser, team) {
  const email = authUser && authUser.email ? String(authUser.email).trim().toLowerCase() : "";
  const fallbackName = (authUser && authUser.name) || "Unknown";
  if (email) {
    const m = (team || []).find((x) => x && x.linkedEmail && String(x.linkedEmail).trim().toLowerCase() === email);
    if (m) return { id: m.id, name: m.name || fallbackName };
  }
  return { id: null, name: fallbackName };
}

// ---------------------------------------------------------------------
// Legacy migration (idempotent)
// ---------------------------------------------------------------------
// Before this change, assignments were stored as display NAMES:
//   entity.owner (string), ticket.qaAssignee (array of names, key present =
//   manual override). They become `assignedTo` ids. Whatever can't be
//   represented exactly is kept (never silently dropped):
//     entity.legacyOwner       the old name, when it matched no team member
//     ticket.legacyQaAssignee  the old names, when there was more than one
//                              (an id holds exactly one person) or when one
//                              matched no member
// Safe to run any number of times, including on a document an old browser
// tab just saved back with the old keys.
function migrateReleaseAssignments(release, team) {
  if (!release || typeof release !== "object") return false;
  const index = indexTeam(team);
  let changed = false;

  for (const t of release.tickets || []) {
    if (!t || typeof t !== "object") continue;
    if (hasOwn(t, "qaAssignee")) {
      if (!hasOwn(t, "assignedTo")) {
        const names = (Array.isArray(t.qaAssignee) ? t.qaAssignee : t.qaAssignee ? [t.qaAssignee] : [])
          .map((n) => String(n || "").trim())
          .filter(Boolean);
        const ids = names.map((n) => resolveNameToId(n, index));
        t.assignedTo = ids.find(Boolean) || null;
        if (names.length > 1 || ids.some((id) => !id)) {
          if (names.length) t.legacyQaAssignee = names;
        }
      }
      delete t.qaAssignee;
      changed = true;
    }
    if (hasOwn(t, "assignedTo")) {
      const clean = cleanId(t.assignedTo);
      if (clean !== t.assignedTo) { t.assignedTo = clean; changed = true; }
    }
  }

  for (const row of release.regression || []) {
    if (!row || typeof row !== "object") continue;
    if (hasOwn(row, "owner")) {
      if (!hasOwn(row, "assignedTo")) {
        const name = String(row.owner || "").trim();
        const id = name ? resolveNameToId(name, index) : null;
        row.assignedTo = id;
        if (name && !id) row.legacyOwner = name;
      }
      delete row.owner;
      changed = true;
    }
    if (!hasOwn(row, "assignedTo")) {
      // A row synced/created before this change and never owned — make the
      // "no owner" state explicit so every entity row has the field.
      row.assignedTo = null;
      changed = true;
    } else {
      const clean = cleanId(row.assignedTo);
      if (clean !== row.assignedTo) { row.assignedTo = clean; changed = true; }
    }
    for (const s of Array.isArray(row.services) ? row.services : []) {
      if (s && hasOwn(s, "assignedTo")) {
        const clean = cleanId(s.assignedTo);
        if (clean !== s.assignedTo) { s.assignedTo = clean; changed = true; }
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------
// Effective assignee (server copy of what the UI computes)
// ---------------------------------------------------------------------
function moduleAssignee(row, service) {
  if (service && hasOwn(service, "assignedTo")) return service.assignedTo || null;
  return (row && row.assignedTo) || null;
}

// Every status-bearing "module" on a release as one flat list, keyed by id:
// a service under an entity, an entity with no services (tracked as a single
// item), or a legacy flat row.
function regressionItems(release) {
  const out = [];
  for (const row of (release && release.regression) || []) {
    if (!row || typeof row !== "object") continue;
    if (Array.isArray(row.services) && row.services.length) {
      for (const s of row.services) {
        if (s && s.id) out.push({ id: s.id, kind: "module", row, service: s, holder: s, name: s.name, status: s.status });
      }
    } else {
      // 0-service entity or legacy flat row: the row itself is the item.
      out.push({ id: row.id, kind: "entity-item", row, service: null, holder: row, name: row.name, status: row.status });
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Save diff -> stamped timestamps + audit events
// ---------------------------------------------------------------------
function memberName(id, index) {
  if (!id) return null;
  const m = index.byId.get(id);
  return m ? m.name || "Unnamed member" : "a removed team member";
}

function ticketOwn(t) {
  return hasOwn(t, "assignedTo") ? t.assignedTo || null : UNSET;
}

// Compares the release as stored (`before`) with the release being saved
// (`after`, mutated in place) and returns the audit events that describe
// what changed. Also stamps who/when onto the changed items so Statistics
// and the "changed by someone else" warning read real data:
//   ticket/entity/module.assignedAt / assignedBy
//   module.lastChange = {at, changedBy, assignedTo, previousStatus, newStatus, byOther}
// `actor` is {id, name} from resolveActor — always the verified session,
// never the request body.
function diffReleaseActivity(before, after, { actor, team, now }) {
  const events = [];
  const index = indexTeam(team);
  const stamp = now || new Date().toISOString();
  const releaseId = after._id || (before && before._id) || "";

  // ---- tickets ----
  const beforeTickets = new Map(((before && before.tickets) || []).filter((t) => t && t.key).map((t) => [t.key, t]));
  for (const t of after.tickets || []) {
    if (!t || !t.key) continue;
    const prior = beforeTickets.get(t.key);
    if (!prior) continue; // a brand-new ticket is TICKET_ADDED, not an assignment change
    const prev = ticketOwn(prior);
    const next = ticketOwn(t);
    if (prev === next) continue;
    const prevId = prev === UNSET ? null : prev;
    const nextId = next === UNSET ? null : next;
    if (next !== UNSET) { t.assignedAt = stamp; t.assignedBy = actor.id; }
    let action, details;
    if (next === UNSET) {
      action = "TICKET_UNASSIGNED";
      details = t.key + " back to Jira's QA Assigned field" + (prevId ? " (was " + memberName(prevId, index) + ")" : "");
    } else if (nextId && prevId) {
      action = "TICKET_REASSIGNED";
      details = t.key + " reassigned from " + memberName(prevId, index) + " to " + memberName(nextId, index);
    } else if (nextId) {
      action = "TICKET_ASSIGNED";
      details = "Jira ticket " + t.key + " assigned to " + memberName(nextId, index);
    } else {
      action = "TICKET_UNASSIGNED";
      details = t.key + " unassigned" + (prevId ? " from " + memberName(prevId, index) : "");
    }
    events.push({
      action, entityType: "Ticket", entityId: t.key, details,
      meta: { releaseId, ticketKey: t.key, assignedTo: nextId, previousAssignedTo: prevId },
    });
  }

  // ---- regression: entity / module assignment ----
  const beforeRows = new Map(((before && before.regression) || []).filter((r) => r && r.id).map((r) => [r.id, r]));
  for (const row of after.regression || []) {
    if (!row || !row.id) continue;
    const prior = beforeRows.get(row.id);
    if (!prior) continue;
    const label = row.name || "Unnamed entity";
    const prevOwner = prior.assignedTo || null;
    const nextOwner = row.assignedTo || null;
    if (prevOwner !== nextOwner) {
      row.assignedAt = stamp; row.assignedBy = actor.id;
      events.push({
        action: nextOwner ? "ENTITY_REGRESSION_ASSIGNED" : "REGRESSION_UNASSIGNED",
        entityType: "Regression", entityId: row.id,
        details: nextOwner
          ? label + " regression assigned to " + memberName(nextOwner, index)
          : "Removed assignment from " + label + " regression",
        meta: { releaseId, regressionModuleId: row.id, scope: "entity", assignedTo: nextOwner, previousAssignedTo: prevOwner },
      });
    }
    const priorServices = new Map((Array.isArray(prior.services) ? prior.services : []).filter((s) => s && s.id).map((s) => [s.id, s]));
    for (const s of Array.isArray(row.services) ? row.services : []) {
      const ps = s && priorServices.get(s.id);
      if (!ps) continue;
      const pv = hasOwn(ps, "assignedTo") ? ps.assignedTo || null : UNSET;
      const nv = hasOwn(s, "assignedTo") ? s.assignedTo || null : UNSET;
      if (pv === nv) continue;
      s.assignedAt = stamp; s.assignedBy = actor.id;
      const itemLabel = label + " — " + (s.name || "Unnamed module");
      const prevEff = pv === UNSET ? prevOwner : pv;
      let action, details;
      if (nv === UNSET) {
        action = "REGRESSION_ASSIGNED";
        details = itemLabel + " now follows the Entity owner" + (nextOwner ? " (" + memberName(nextOwner, index) + ")" : " (no one)");
      } else if (nv) {
        action = "REGRESSION_ASSIGNED";
        details = itemLabel + " assigned to " + memberName(nv, index);
      } else {
        action = "REGRESSION_UNASSIGNED";
        details = itemLabel + " unassigned";
      }
      events.push({
        action, entityType: "Regression", entityId: s.id, details,
        meta: {
          releaseId, regressionModuleId: s.id, scope: nv === UNSET ? "module-inherit" : "module",
          assignedTo: nv === UNSET ? nextOwner : nv, previousAssignedTo: prevEff || null,
        },
      });
    }
  }

  // ---- regression: status changes ----
  const beforeItems = new Map(regressionItems(before).map((i) => [i.id, i]));
  for (const item of regressionItems(after)) {
    const prior = beforeItems.get(item.id);
    if (!prior) continue;
    const prevStatus = prior.status || "NOT TESTED";
    const nextStatus = item.status || "NOT TESTED";
    if (prevStatus === nextStatus) continue;
    const assignedTo = moduleAssignee(item.row, item.service);
    const changedBy = actor.id;
    const byOther = !!assignedTo && assignedTo !== changedBy;
    item.holder.lastChange = {
      at: stamp, changedBy, assignedTo: assignedTo || null,
      previousStatus: prevStatus, newStatus: nextStatus, byOther,
    };
    // Someone not linked to a Know the Team entry has no id — keep their
    // display name (from the verified session) so the note can still say who.
    if (!changedBy) item.holder.lastChange.changedByName = actor.name || "Unknown";
    const label = item.kind === "module" ? (item.row.name || "Unnamed entity") + " — " + (item.name || "Unnamed module") : (item.name || "Unnamed entity");
    events.push({
      action: "REGRESSION_UPDATED", entityType: "Regression", entityId: item.id,
      details: label + ": " + prevStatus + " → " + nextStatus,
      meta: { releaseId, regressionModuleId: item.id, assignedTo: assignedTo || null, changedBy, previousStatus: prevStatus, newStatus: nextStatus, byOther },
    });
  }
  return events;
}

module.exports = {
  normalizeName,
  indexTeam,
  resolveActor,
  migrateReleaseAssignments,
  moduleAssignee,
  regressionItems,
  diffReleaseActivity,
};
