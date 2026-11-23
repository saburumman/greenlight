// RCA (Root Cause Analysis) — pure rules, no Express and no database, so they can
// be tested directly. routes/rca.js does the I/O.
//
// One RCA record:
//   {
//     id,
//     releaseId, releaseLabel,        // the release that caused the issue; the label is a snapshot
//                                     // ("Name Version") kept so the RCA still reads well if the
//                                     // release is later deleted or renamed
//     issue, cause, correctiveAction, preventiveAction,   // the four text fields
//     status,                         // "Open" | "In Progress" | "Resolved" — optional, defaults to "Open"
//                                     // (records saved before it existed read as "Open")
//     createdBy: { id, name },        // the signed-in person (Know the Team id when linked) — never from the browser
//     createdAt,
//     updatedBy: { id, name } | null, updatedAt,
//   }

const MAX_TEXT = 5000;
const STATUSES = ["Open", "In Progress", "Resolved"];
const DEFAULT_STATUS = "Open";

const TEXT_FIELDS = [
  ["issue", "The issue"],
  ["cause", "The cause"],
  ["correctiveAction", "The corrective action"],
  ["preventiveAction", "The preventive action"],
];

function releaseLabel(r) {
  return [r && r.name ? String(r.name).trim() : "", r && r.version ? String(r.version).trim() : ""].filter(Boolean).join(" ") || "Untitled release";
}

// Trims each field (keeping the person's own line breaks), requires all four, and
// caps the length. -> { clean:{issue,cause,correctiveAction,preventiveAction,releaseId}, errors:{field:message} }
function validateInput(body) {
  const b = body && typeof body === "object" ? body : {};
  const clean = {};
  const errors = {};
  const releaseId = typeof b.releaseId === "string" ? b.releaseId.trim() : "";
  if (!releaseId) errors.releaseId = "Pick the release that caused it.";
  clean.releaseId = releaseId;
  for (const [key, label] of TEXT_FIELDS) {
    const v = typeof b[key] === "string" ? b[key].replace(/\r\n/g, "\n").trim() : "";
    if (!v) errors[key] = label + " is required.";
    else if (v.length > MAX_TEXT) errors[key] = label + " is too long (" + MAX_TEXT + " characters at most).";
    clean[key] = v;
  }
  // Status is optional: left out it means "Open" on a new RCA and "unchanged" on an edit.
  if (b.status === undefined || b.status === null || b.status === "") clean.status = null;
  else if (STATUSES.includes(b.status)) clean.status = b.status;
  else errors.status = "Status must be Open, In Progress or Resolved.";
  return { clean, errors };
}

// The release the dropdown is built from (and the filter): newest first, as the
// store returns them.
function releaseOption(r) {
  return { id: r._id || r.id, name: r.name || "", version: r.version || "", date: r.date || "", label: releaseLabel(r) };
}

function buildRecord({ id, clean, release, actor, now }) {
  return {
    id,
    releaseId: clean.releaseId,
    releaseLabel: releaseLabel(release),
    issue: clean.issue,
    cause: clean.cause,
    correctiveAction: clean.correctiveAction,
    preventiveAction: clean.preventiveAction,
    status: clean.status || DEFAULT_STATUS,
    createdBy: { id: (actor && actor.id) || null, name: (actor && actor.name) || "Unknown" },
    createdAt: now,
    updatedBy: null,
    updatedAt: now,
  };
}

// The record as the browser sees it: the release is looked up live (so a rename
// shows), falling back to the stored snapshot when it has been deleted; people
// are shown under their current Know the Team name.
function publicRca(rec, releasesById, teamById) {
  const rel = releasesById && releasesById.get(rec.releaseId);
  const nameOf = (p) => {
    if (!p) return null;
    const m = p.id && teamById ? teamById.get(p.id) : null;
    return (m && m.name) || p.name || "Unknown";
  };
  return {
    id: rec.id,
    releaseId: rec.releaseId,
    release: rel
      ? { exists: true, label: releaseLabel(rel), date: rel.date || "" }
      : { exists: false, label: rec.releaseLabel || "Deleted release", date: "" },
    issue: rec.issue,
    cause: rec.cause,
    correctiveAction: rec.correctiveAction,
    preventiveAction: rec.preventiveAction,
    status: STATUSES.includes(rec.status) ? rec.status : DEFAULT_STATUS,
    createdBy: nameOf(rec.createdBy),
    createdAt: rec.createdAt,
    updatedBy: nameOf(rec.updatedBy),
    updatedAt: rec.updatedAt,
    edited: !!rec.updatedBy,
  };
}

// Every typed word must appear somewhere in the RCA (any of the four fields, the
// release, or the author) — case-insensitive.
function matchesSearch(pub, q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [pub.issue, pub.cause, pub.correctiveAction, pub.preventiveAction, pub.release.label, pub.status, pub.createdBy, pub.updatedBy || ""].join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

module.exports = { MAX_TEXT, STATUSES, DEFAULT_STATUS, TEXT_FIELDS, releaseLabel, releaseOption, validateInput, buildRecord, publicRca, matchesSearch };
