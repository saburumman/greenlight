// Builds and appends audit records on the server. Used by routes/audit.js
// (events the browser reports) and routes/releases.js (assignment and
// regression-status events derived from a release save — see
// assignmentLogic.diffReleaseActivity). In both cases identity is the
// verified session resolved to a Know the Team member (assignmentLogic.
// resolveActor), never anything the browser sends.

const crypto = require("crypto");

// The only structured keys an audit record's `meta` may carry — everything
// is a short string/boolean, so one oversized or hostile payload can't bloat
// the log.
const META_KEYS = [
  "releaseId", "ticketKey", "regressionModuleId", "scope",
  "assignedTo", "previousAssignedTo", "changedBy",
  "previousStatus", "newStatus", "byOther",
];

function cleanMeta(meta) {
  if (!meta || typeof meta !== "object") return undefined;
  const out = {};
  for (const k of META_KEYS) {
    if (!(k in meta)) continue;
    const v = meta[k];
    if (v === null) out[k] = null;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 200);
  }
  return Object.keys(out).length ? out : undefined;
}

function buildEntry(actor, event, now) {
  const entry = {
    id: event.id && typeof event.id === "string" ? event.id.slice(0, 100) : crypto.randomUUID(),
    teamMemberId: actor && actor.id ? actor.id : null,
    userName: (actor && actor.name) || "Unknown",
    action: event.action,
    entityType: event.entityType ? String(event.entityType).slice(0, 100) : "",
    entityId: event.entityId ? String(event.entityId).slice(0, 200) : "",
    details: event.details ? String(event.details).slice(0, 500) : "",
    createdAt: now || new Date().toISOString(),
  };
  const meta = cleanMeta(event.meta);
  if (meta) entry.meta = meta;
  return entry;
}

// Appends every event; never throws — audit is activity tracking, and a
// failed write must not undo or fail the user's real action.
async function recordEvents(db, actor, events, now) {
  for (const event of events || []) {
    try {
      await db.auditLog.append(buildEntry(actor, event, now));
    } catch (e) {
      console.error("audit append failed:", e && e.message);
    }
  }
}

module.exports = { buildEntry, cleanMeta, recordEvents, META_KEYS };
