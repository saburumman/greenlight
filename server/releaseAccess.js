// Permission-aware release saves.
//
// The browser edits a release locally and PUTs the WHOLE document back
// (routes/releases.js), so "may this person save a release?" isn't one
// question — a QA Engineer updating a regression result sends the entire
// release too. This module answers it field by field, on the server, from the
// caller's permissions, and returns the document that is actually allowed to
// be stored:
//
//   regression  rows/services   status + notes -> regression.edit
//                               assignedTo      -> regression.assign
//                               add a row       -> regression.create
//                               remove a row    -> regression.delete
//                               anything else   -> regression.manage
//   regressionSkipped                           -> regression.manage
//   published   (QA decision)                   -> releases.manage
//   everything else (name, tickets, bugs, platforms, incidents, notes…)
//                                               -> releases.edit
//
// A part the caller may not change is simply kept as stored (so a browser tab
// holding a slightly stale copy can't clobber other people's work, and a
// hand-crafted request can't write what its sender may not write). If the
// caller asked for changes and NONE of them is allowed, the route answers 403.
// Pure functions — no Express, no database.

const SYSTEM_KEYS = new Set(["_id", "createdAt", "updatedAt"]);
// Server-written bookkeeping on regression rows (stamped by
// assignmentLogic.diffReleaseActivity after this check) — never a "change".
const STAMP_KEYS = new Set(["assignedAt", "assignedBy", "lastChange"]);
const ALL_REGRESSION = ["regression.create", "regression.edit", "regression.delete", "regression.assign", "regression.manage"];

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function fieldNeed(key) {
  if (key === "status" || key === "notes") return "regression.edit";
  if (key === "assignedTo" || key === "owner" || key === "legacyOwner") return "regression.assign";
  return "regression.manage";
}

// Merges one row (entity or service): field by field.
function mergeFields(cur, inc, held, stats, skip) {
  const out = { ...cur };
  const keys = new Set([...Object.keys(cur || {}), ...Object.keys(inc || {})]);
  for (const k of keys) {
    if (k === "id" || (skip && skip.has(k)) || STAMP_KEYS.has(k)) continue;
    if (same(cur[k], inc[k])) continue;
    if (held.has(fieldNeed(k))) {
      stats.applied++;
      if (inc[k] === undefined) delete out[k]; else out[k] = clone(inc[k]);
    } else stats.denied.add(fieldNeed(k));
  }
  return out;
}

function mergeById(curList, incList, held, stats, mergeOne) {
  const cur = Array.isArray(curList) ? curList : [];
  const inc = Array.isArray(incList) ? incList : [];
  const incById = new Map(inc.filter((x) => x && x.id).map((x) => [x.id, x]));
  const curIds = new Set(cur.filter((x) => x && x.id).map((x) => x.id));
  const out = [];
  for (const c of cur) {
    const i = c && c.id ? incById.get(c.id) : null;
    if (!i) {
      if (c && c.id && held.has("regression.delete")) { stats.applied++; continue; }
      if (c && c.id) stats.denied.add("regression.delete");
      out.push(c);
      continue;
    }
    out.push(mergeOne(c, i));
  }
  for (const i of inc) {
    if (!i || !i.id || curIds.has(i.id)) continue;
    if (held.has("regression.create")) { stats.applied++; out.push(clone(i)); } else stats.denied.add("regression.create");
  }
  return out;
}

function mergeRegression(cur, inc, held, stats) {
  if (!Array.isArray(inc)) return clone(cur);
  if (ALL_REGRESSION.every((k) => held.has(k))) { if (!same(cur, inc)) stats.applied++; return clone(inc); } // full regression rights: exactly the document sent
  return mergeById(cur, inc, held, stats, (c, i) => {
    const row = mergeFields(c, i, held, stats, new Set(["services"]));
    if (has(c, "services") || has(i, "services")) {
      row.services = mergeById(c.services, i.services, held, stats, (cs, is) => mergeFields(cs, is, held, stats));
    }
    return row;
  });
}

// held: Set of permission keys. Returns { merged, applied, denied: [permission keys needed but not held] }.
function authorizeReleaseSave(existing, incoming, held) {
  const ex = existing || {};
  const inc = incoming || {};
  const stats = { applied: 0, denied: new Set() };
  const merged = {};
  const keys = new Set([...Object.keys(ex), ...Object.keys(inc)]);
  for (const key of keys) {
    if (SYSTEM_KEYS.has(key)) continue;
    const cur = ex[key];
    const next = has(inc, key) ? inc[key] : undefined;
    if (key === "regression") {
      const r = mergeRegression(cur, next, held, stats);
      if (r !== undefined) merged[key] = r;
      continue;
    }
    if (same(cur, next)) { if (cur !== undefined) merged[key] = cur; continue; }
    const need = key === "regressionSkipped" ? "regression.manage" : key === "published" ? "releases.manage" : "releases.edit";
    if (held.has(need)) {
      stats.applied++;
      if (next !== undefined) merged[key] = clone(next);
    } else {
      stats.denied.add(need);
      if (cur !== undefined) merged[key] = cur;
    }
  }
  return { merged, applied: stats.applied, denied: Array.from(stats.denied) };
}

module.exports = { authorizeReleaseSave, fieldNeed };
