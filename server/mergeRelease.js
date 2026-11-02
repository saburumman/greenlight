// Three-way merge for release saves.
//
// The browser edits its copy of a release and PUTs the WHOLE document back
// (routes/releases.js). With two people on the same release, the second save used
// to write the first person's stale copy over everything the first had changed
// meanwhile — silently reverting regression statuses, notes and owners, and
// (because the server diffs stored vs. incoming) attributing that revert to the
// person who merely saved something else.
//
// The browser now also sends `_base`: the release exactly as it last received it
// from the server. merge3(base, current, incoming) keeps everything the sender did
// NOT touch at its CURRENT stored value and applies only what the sender actually
// changed since `base`. Where both people changed the very same value, the sender
// (the later save) wins, as before. Rows of a list (regression entities and
// services, tickets, bugs, …) are matched by id (tickets: key), so one person
// adding or removing a row doesn't disturb another's edits to its neighbours.
// Pure functions — no I/O.

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const idOf = (el) => (el && typeof el === "object" ? (el.id != null ? "i:" + el.id : (el.key != null ? "k:" + el.key : null)) : null);
const keyedList = (a) => Array.isArray(a) && a.every((x) => idOf(x) !== null);

function mergeLists(base, cur, inc) {
  const bMap = new Map(base.map((x) => [idOf(x), x]));
  const cMap = new Map(cur.map((x) => [idOf(x), x]));
  const iMap = new Map(inc.map((x) => [idOf(x), x]));
  const out = [];
  const seen = new Set();
  for (const c of cur) {                                   // current order first
    const k = idOf(c); seen.add(k);
    const b = bMap.get(k), i = iMap.get(k);
    if (!iMap.has(k)) {
      // the sender doesn't have it: they deleted it (if they knew it) — unless someone changed it meanwhile — or it was added by someone else after their copy
      if (bMap.has(k) && same(b, c)) continue;
      out.push(c);
    } else if (!bMap.has(k)) {
      out.push(merge3(undefined, c, i));                    // added by both sides (same id): sender's version wins field by field
    } else out.push(merge3(b, c, i));
  }
  for (const i of inc) {                                    // rows only the sender has: added by them
    const k = idOf(i);
    if (!seen.has(k) && !cMap.has(k)) out.push(clone(i));
  }
  return out;
}

function merge3(base, cur, inc) {
  if (same(inc, base)) return clone(cur);                   // sender didn't touch it — keep what is stored now
  if (same(cur, base) || same(cur, inc)) return clone(inc); // nobody else touched it
  if (isObj(cur) && isObj(inc)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(cur), ...Object.keys(inc)])) {
      const v = merge3(b[k], cur[k], inc[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(cur) && Array.isArray(inc) && keyedList(cur) && keyedList(inc) && (base === undefined || (Array.isArray(base) && keyedList(base)))) {
    return mergeLists(base || [], cur, inc);
  }
  return clone(inc);                                        // both changed the same value: the later save wins
}

// `base` is optional; without it (an older browser tab) the incoming document is used as sent.
function mergeReleaseSave(base, current, incoming) {
  if (!isObj(base)) return incoming;
  const SYSTEM = new Set(["_id", "createdAt", "updatedAt"]);
  const merged = merge3(base, current, incoming);
  for (const k of SYSTEM) { if (current && k in current) merged[k] = current[k]; else delete merged[k]; }
  return merged;
}

module.exports = { merge3, mergeReleaseSave };
