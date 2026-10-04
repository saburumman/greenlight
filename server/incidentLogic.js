// Incidents — validation and normalization.
//
// An Incident is a small record kept on a Release (release.incidents[],
// alongside release.bugs / release.blockers — same "embedded in the release
// document, saved through the generic PUT /:id" storage as every other
// section). There are two levels:
//   - scope "TICKET":  tied to one ticket that belongs to THIS release
//   - scope "RELEASE": about the release as a whole, no ticket
//
// ticketId is the ticket's Jira key (release.tickets[].key) — tickets in this
// app have no separate id, and the key is what the rest of the app already
// uses to identify one within a release (e.g. the ticket DELETE route).
//
// This module is intentionally dependency-free (no express/db) so it can be
// unit-tested directly. routes/releases.js calls prepareIncidentsForSave()
// from the generic PUT /:id, which is the one place incident rules are
// enforced server-side (the client validates too, for UX, but is not trusted).

const crypto = require("crypto");

const SCOPES = ["TICKET", "RELEASE"];
const SEVERITIES = ["Critical", "High", "Medium", "Low"];
const STATUSES = ["Open", "Investigating", "Resolved"];

const DEFAULT_SEVERITY = "Medium";
const DEFAULT_STATUS = "Open";

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;
const MAX_LONG_TEXT = 1000; // impact, resolution
const MAX_NAME = 200;

class IncidentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IncidentValidationError";
    this.status = 400;
  }
}

function clean(value, max) {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
}

// An incident is "unresolved" until it's explicitly Resolved — "Investigating"
// is still an active problem, so it counts the same as "Open" everywhere that
// matters (assessment risk signals, summary counts).
function isUnresolved(incident) {
  return !!incident && incident.status !== "Resolved";
}

// The fields a person can edit — used to decide whether an incoming incident
// actually changed (so updatedAt only moves when something real did).
function comparableFields(inc) {
  return JSON.stringify([
    inc.scope, inc.ticketId || null, inc.title, inc.severity, inc.status,
    inc.description, inc.impact, inc.resolution,
  ]);
}

// Validates + normalizes ONE incoming incident. `ticketKeys` is the set of
// ticket keys that belong to the release being saved; `priorTicketId` is the
// ticket this incident was already linked to in the stored copy (or
// undefined for a brand-new incident). A ticket link is only re-checked
// against the release's tickets when it's new or has changed — otherwise
// saving an UNRELATED edit to an old incident (or any other section of the
// release) would start failing the moment Jira sync removed that ticket from
// the Fix Version.
function normalizeIncident(raw, { ticketKeys, prior }) {
  if (!raw || typeof raw !== "object") throw new IncidentValidationError("Each incident must be an object.");

  const scope = String(raw.scope || "").trim().toUpperCase();
  if (!SCOPES.includes(scope)) {
    throw new IncidentValidationError('Incident type is required — choose "Related to a ticket" or "Release-level incident".');
  }

  const title = clean(raw.title, MAX_TITLE);
  if (!title) throw new IncidentValidationError("Incident title is required.");

  const description = clean(raw.description, MAX_DESCRIPTION);
  if (!description) throw new IncidentValidationError("Incident description is required.");

  const severity = raw.severity == null || raw.severity === "" ? DEFAULT_SEVERITY : String(raw.severity).trim();
  if (!SEVERITIES.includes(severity)) {
    throw new IncidentValidationError("Incident severity must be one of: " + SEVERITIES.join(", ") + ".");
  }
  const status = raw.status == null || raw.status === "" ? DEFAULT_STATUS : String(raw.status).trim();
  if (!STATUSES.includes(status)) {
    throw new IncidentValidationError("Incident status must be one of: " + STATUSES.join(", ") + ".");
  }

  let ticketId = null;
  if (scope === "TICKET") {
    ticketId = clean(raw.ticketId, MAX_NAME);
    if (!ticketId) throw new IncidentValidationError("Pick the release ticket this incident is related to.");
    const unchanged = prior && prior.scope === "TICKET" && prior.ticketId === ticketId;
    if (!unchanged && !ticketKeys.has(ticketId)) {
      throw new IncidentValidationError("Ticket " + ticketId + " isn't part of this release — an incident can only be linked to one of this release's own tickets.");
    }
  }
  // scope === "RELEASE": ticketId stays null no matter what was sent.

  return {
    scope,
    ticketId,
    title,
    severity,
    status,
    description,
    impact: clean(raw.impact, MAX_LONG_TEXT),
    resolution: clean(raw.resolution, MAX_LONG_TEXT),
  };
}

// Entry point used by PUT /:id. `releaseId` is the id of the release being
// saved (from the URL, not the body). `incoming` is whatever the client sent as
// `incidents` (undefined for an older client that doesn't know about them —
// in which case the stored incidents are kept untouched rather than wiped).
// Returns the final, normalized incidents array to store.
//
// Server-owned fields (never taken from the client): releaseId (always the
// release being saved — this is what makes an incident belong to exactly one
// release), createdAt/createdBy of an incident that already exists, and
// updatedAt (only advances when an editable field actually changed).
function prepareIncidentsForSave(incoming, existingRelease, { releaseId, authUser, now } = {}) {
  const stored = Array.isArray(existingRelease && existingRelease.incidents) ? existingRelease.incidents : [];
  if (incoming === undefined) return stored;
  if (!Array.isArray(incoming)) throw new IncidentValidationError("incidents must be a list.");

  const ticketKeys = new Set(((existingRelease && existingRelease.tickets) || []).map((t) => t && t.key).filter(Boolean));
  const storedById = new Map(stored.filter((i) => i && i.id).map((i) => [i.id, i]));
  const stamp = now || new Date().toISOString();
  const usedIds = new Set();

  return incoming.map((raw) => {
    const prior = raw && raw.id ? storedById.get(raw.id) : undefined;
    const fields = normalizeIncident(raw, { ticketKeys, prior });

    let id = raw && typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 100) : "";
    if (!id || usedIds.has(id)) id = crypto.randomUUID();
    usedIds.add(id);

    if (prior) {
      const changed = comparableFields(fields) !== comparableFields(prior);
      return {
        id,
        releaseId,
        ...fields,
        createdBy: prior.createdBy || "",
        createdAt: prior.createdAt || stamp,
        updatedAt: changed ? stamp : (prior.updatedAt || prior.createdAt || stamp),
      };
    }
    const createdBy = clean(raw.createdBy, MAX_NAME) || clean(authUser && authUser.name, MAX_NAME);
    return { id, releaseId, ...fields, createdBy, createdAt: stamp, updatedAt: stamp };
  });
}

module.exports = {
  SCOPES,
  SEVERITIES,
  STATUSES,
  IncidentValidationError,
  isUnresolved,
  normalizeIncident,
  prepareIncidentsForSave,
};
