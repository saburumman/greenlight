// Reporting module (REPORTING_SPEC.md) — pure logic, no I/O. Turns Jira's raw
// issue JSON into the cache rows of §2.2 and computes the derived fields of
// §2.3. Everything here is hours (never story points) and read-only.
//
// Dates are kept as ISO-8601 UTC strings (stored as timestamptz); rendering
// in Asia/Amman is the UI/export layer's job.

// ---------- small helpers ----------

function toHours(seconds) {
  if (seconds === null || seconds === undefined || seconds === "" || isNaN(Number(seconds))) return null;
  return Math.round((Number(seconds) / 3600) * 100) / 100;
}

function round2(n) {
  return n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 100) / 100;
}

// Jira sends "2026-09-01T10:15:30.123+0300" (no colon in the offset) — make it
// something every JS engine parses the same way, and return UTC ISO.
function normalizeJiraDate(s) {
  if (!s || typeof s !== "string") return null;
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(fixed);
  return isNaN(t) ? null : new Date(t).toISOString();
}

// Jira's `duedate` is a plain calendar date (YYYY-MM-DD) — keep it that way.
function normalizeDueDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

const DAY_MS = 86400000;
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const d = (Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS;
  return isNaN(d) ? null : round2(d);
}

// Atlassian Document Format → short plain text (worklog comments).
function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return " ";
  const inner = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
  return /^(paragraph|heading|listItem|codeBlock|blockquote)$/.test(node.type || "") ? inner + " " : inner;
}
function worklogComment(c) {
  return adfToText(c).replace(/\s+/g, " ").trim().slice(0, 500);
}

// ---------- status categories ----------

// statusList = GET /rest/api/3/status. Returns lower-cased status name →
// "To Do" | "In Progress" | "Done".
function buildStatusIndex(statusList) {
  const idx = new Map();
  for (const s of statusList || []) {
    if (!s || !s.name) continue;
    const key = s.statusCategory && s.statusCategory.key;
    const cat = key === "done" ? "Done" : key === "indeterminate" ? "In Progress" : key === "new" ? "To Do" : null;
    if (cat) idx.set(String(s.name).trim().toLowerCase(), cat);
  }
  return idx;
}
function categoryOfStatusName(name, idx) {
  return (name && idx && idx.get(String(name).trim().toLowerCase())) || null;
}
function categoryFromField(statusField) {
  const key = statusField && statusField.statusCategory && statusField.statusCategory.key;
  return key === "done" ? "Done" : key === "indeterminate" ? "In Progress" : key === "new" ? "To Do" : "To Do";
}

// ---------- changelog ----------

// histories = Jira changelog entries. → { transitions[], flagEvents[] }
// transitions sorted oldest first: {from_status, to_status, changed_at, changed_by}
// flagEvents: {at, on:boolean} — the Flagged (impediment) field switching.
function extractChangelog(histories) {
  const transitions = [];
  const flagEvents = [];
  for (const h of histories || []) {
    const at = normalizeJiraDate(h.created);
    if (!at) continue;
    const by = (h.author && (h.author.displayName || h.author.emailAddress)) || null;
    for (const it of h.items || []) {
      const field = String(it.field || "").toLowerCase();
      if (field === "status") {
        transitions.push({ from_status: it.fromString || null, to_status: it.toString || null, changed_at: at, changed_by: by });
      } else if (field === "flagged") {
        flagEvents.push({ at, on: !!(it.toString && String(it.toString).trim()) });
      }
    }
  }
  const byTime = (a, b) => Date.parse(a.changed_at || a.at) - Date.parse(b.changed_at || b.at);
  transitions.sort(byTime);
  flagEvents.sort(byTime);
  return { transitions, flagEvents };
}

// started / completed / reopen facts from the transition history.
//  - started_at   first move into an In Progress category status
//  - completed_at (only if the issue is Done NOW) the LAST move into Done;
//                 falls back to Jira's resolutiondate when no transition exists
//  - reopen_count moves out of a Done status
function lifecycle(transitions, statusIndex, currentCategory, resolutionDate) {
  let startedAt = null;
  let lastDone = null;
  let reopenCount = 0;
  for (const t of transitions) {
    const toCat = categoryOfStatusName(t.to_status, statusIndex);
    const fromCat = categoryOfStatusName(t.from_status, statusIndex);
    if (toCat === "In Progress" && !startedAt) startedAt = t.changed_at;
    if (toCat === "Done") lastDone = t.changed_at;
    if (fromCat === "Done" && toCat !== "Done") reopenCount++;
  }
  let completedAt = null;
  if (currentCategory === "Done") completedAt = lastDone || resolutionDate || null;
  return { started_at: startedAt, completed_at: completedAt, reopen_count: reopenCount, was_reopened: reopenCount > 0 };
}

// Days an issue spent blocked: time in a "blocked" status plus time flagged as
// an impediment, overlapping stretches counted once. Still-open stretches run
// to `endIso` (completion, otherwise now).
function blockedStats(transitions, flagEvents, blockedStatuses, currentStatus, currentFlagged, endIso) {
  const blocked = new Set((blockedStatuses || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const end = Date.parse(endIso);
  const intervals = [];
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    if (blocked.has(String(t.to_status || "").trim().toLowerCase())) {
      const next = transitions[i + 1];
      intervals.push([Date.parse(t.changed_at), next ? Date.parse(next.changed_at) : end]);
    }
  }
  let openFrom = null;
  for (const e of flagEvents) {
    if (e.on && openFrom === null) openFrom = Date.parse(e.at);
    else if (!e.on && openFrom !== null) { intervals.push([openFrom, Date.parse(e.at)]); openFrom = null; }
  }
  if (openFrom !== null) intervals.push([openFrom, end]);
  const merged = [];
  for (const iv of intervals.filter((x) => isFinite(x[0]) && isFinite(x[1]) && x[1] > x[0]).sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push(iv.slice());
  }
  const ms = merged.reduce((n, iv) => n + (iv[1] - iv[0]), 0);
  const isBlocked = blocked.has(String(currentStatus || "").trim().toLowerCase()) || !!currentFlagged;
  return { is_blocked: isBlocked, blocked_days: round2(ms / DAY_MS) || 0 };
}

// ---------- variance (hours) ----------

const BAND = {
  ON: "On target (±10%)",
  UNDER_MID: "Under 10–25%",
  UNDER_BIG: "Under >25%",
  OVER_MID: "Over 10–25%",
  OVER_BIG: "Over >25%",
  NONE: "Unestimated",
};
function accuracyBand(variancePct) {
  if (variancePct === null || variancePct === undefined || isNaN(variancePct)) return BAND.NONE;
  if (variancePct > 25) return BAND.OVER_BIG;
  if (variancePct > 10) return BAND.OVER_MID;
  if (variancePct >= -10) return BAND.ON;
  if (variancePct >= -25) return BAND.UNDER_MID;
  return BAND.UNDER_BIG;
}
// No estimate (missing or zero) is UNESTIMATED: variance stays null — it is
// never treated as 0 and never divided by.
function variance(estimateH, loggedH) {
  if (estimateH === null || estimateH === undefined || !(estimateH > 0) || loggedH === null || loggedH === undefined) {
    return { variance_h: null, variance_pct: null, estimate_accuracy_band: BAND.NONE };
  }
  const vh = round2(loggedH - estimateH);
  const vp = round2(((loggedH - estimateH) / estimateH) * 100);
  return { variance_h: vh, variance_pct: vp, estimate_accuracy_band: accuracyBand(vp) };
}

// ---------- configurable mapping (service / component / squad) ----------
// cfg = { source: "none"|"component"|"label"|"project"|"field:<Jira field name>",
//         map: { "<jira value>": "<name>" }, passthrough: true }
function applyMapping(cfg, ctx) {
  if (!cfg || !cfg.source || cfg.source === "none") return null;
  let raws = [];
  const f = ctx.fields || {};
  if (cfg.source === "component") raws = (f.components || []).map((c) => c && c.name);
  else if (cfg.source === "label") raws = f.labels || [];
  else if (cfg.source === "project") raws = f.project ? [f.project.key, f.project.name] : [];
  else if (cfg.source.indexOf("field:") === 0) {
    const id = ctx.customFieldIds && ctx.customFieldIds[cfg.source.slice(6).trim().toLowerCase()];
    const v = id ? f[id] : null;
    raws = Array.isArray(v) ? v.map(fieldValueText) : v ? [fieldValueText(v)] : [];
  }
  raws = raws.map((r) => String(r || "").trim()).filter(Boolean);
  const map = {};
  for (const k of Object.keys(cfg.map || {})) map[k.trim().toLowerCase()] = cfg.map[k];
  for (const r of raws) if (map[r.toLowerCase()]) return String(map[r.toLowerCase()]);
  if (cfg.passthrough !== false && raws.length) return raws[0];
  return null;
}
function fieldValueText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v.value || v.name || v.displayName || "");
  return String(v);
}

// ---------- one Jira issue → cache rows ----------
// ctx: { statusIndex, fieldIds:{sprint,epicLink,flagged}, customFieldIds:{lowerName→id},
//        settings:{mappings, blockedStatuses}, now:ISO }
function deriveIssue(raw, ctx) {
  const f = raw.fields || {};
  const issueType = (f.issuetype && f.issuetype.name) || "Task";
  const statusName = (f.status && f.status.name) || "Unknown";
  const category = categoryFromField(f.status);
  const now = ctx.now || new Date().toISOString();

  const parent = f.parent || null;
  const parentIsEpic = !!(parent && parent.fields && parent.fields.issuetype && /epic/i.test(parent.fields.issuetype.name || ""));
  let epicKey = parentIsEpic ? parent.key : null;
  let epicName = parentIsEpic ? (parent.fields.summary || null) : null;
  const epicLinkId = ctx.fieldIds && ctx.fieldIds.epicLink;
  if (!epicKey && epicLinkId && typeof f[epicLinkId] === "string" && f[epicLinkId]) epicKey = f[epicLinkId];
  const parentKey = parent ? parent.key : null;

  const { transitions, flagEvents } = extractChangelog((raw.changelog && raw.changelog.histories) || []);
  const createdAt = normalizeJiraDate(f.created);
  const life = lifecycle(transitions, ctx.statusIndex, category, normalizeJiraDate(f.resolutiondate));
  const flaggedId = ctx.fieldIds && ctx.fieldIds.flagged;
  const flaggedNow = flaggedId && Array.isArray(f[flaggedId]) && f[flaggedId].length > 0;
  const blocked = blockedStats(transitions, flagEvents, (ctx.settings && ctx.settings.blockedStatuses) || [], statusName, flaggedNow, life.completed_at || now);

  const sprintId = ctx.fieldIds && ctx.fieldIds.sprint;
  const sprintsRaw = sprintId && Array.isArray(f[sprintId]) ? f[sprintId] : [];
  const sprints = sprintsRaw.filter((s) => s && typeof s === "object").map((s) => ({
    id: s.id, name: s.name || "", state: s.state || "", start_date: normalizeJiraDate(s.startDate), end_date: normalizeJiraDate(s.endDate || s.completeDate),
  }));

  const est = toHours(f.timeoriginalestimate);
  const logged = toHours(f.timespent);
  const v = variance(est, logged);
  const dueDate = normalizeDueDate(f.duedate);
  const done = category === "Done";
  const fixVersions = (f.fixVersions || []).map((x) => x && x.name).filter(Boolean);
  const mctx = { fields: f, customFieldIds: ctx.customFieldIds };
  const mappings = (ctx.settings && ctx.settings.mappings) || {};

  const row = {
    issue_key: raw.key,
    summary: f.summary || "",
    issue_type: issueType,
    parent_key: parentKey,
    epic_key: issueType.toLowerCase() === "epic" ? null : epicKey,
    epic_name: issueType.toLowerCase() === "epic" ? null : epicName,
    service: applyMapping(mappings.service, mctx),
    component: applyMapping(mappings.component, mctx),
    squad: applyMapping(mappings.squad, mctx),
    labels: f.labels || [],
    priority: (f.priority && f.priority.name) || null,
    fix_version: fixVersions.length ? fixVersions.join(", ") : null,
    release: fixVersions.length ? fixVersions[0] : null,
    status: statusName,
    status_category: category,
    assignee_id: (f.assignee && f.assignee.accountId) || null,
    assignee_name: (f.assignee && f.assignee.displayName) || null,
    reporter_name: (f.reporter && f.reporter.displayName) || null,
    sprints,
    sprint_count: sprints.length,
    created_at: createdAt,
    started_at: life.started_at,
    completed_at: life.completed_at,
    due_date: dueDate,
    original_estimate_h: est,
    remaining_estimate_h: toHours(f.timeestimate),
    logged_h: logged === null ? 0 : logged,
    is_blocked: blocked.is_blocked,
    blocked_days: blocked.blocked_days,
    external_dependency_id: null, // filled by the dependency tracker (Phase 3)
    was_reopened: life.was_reopened,
    reopen_count: life.reopen_count,
    // §2.3 derived
    variance_h: v.variance_h,
    variance_pct: v.variance_pct,
    estimate_accuracy_band: v.estimate_accuracy_band,
    cycle_time_days: life.started_at && life.completed_at ? daysBetween(life.started_at, life.completed_at) : null,
    lead_time_days: createdAt && life.completed_at ? daysBetween(createdAt, life.completed_at) : null,
    // as of this sync — reports recompute these against the day they are generated
    age_days: !done && createdAt ? daysBetween(createdAt, now) : null,
    is_overdue: !!(dueDate && !done && Date.parse(dueDate + "T23:59:59Z") < Date.parse(now)),
  };
  return { row, transitions };
}

// Jira worklog entries → cache rows.
function deriveWorklogs(issueKey, worklogs) {
  return (worklogs || []).filter((w) => w && w.id).map((w) => ({
    worklog_id: String(w.id),
    issue_key: issueKey,
    author_id: (w.author && w.author.accountId) || null,
    author_name: (w.author && w.author.displayName) || null,
    started_at: normalizeJiraDate(w.started),
    time_spent_h: toHours(w.timeSpentSeconds) || 0,
    comment: worklogComment(w.comment),
  }));
}

const DEFAULT_SETTINGS = {
  scope: { jql: "" },
  mappings: {
    service: { source: "none", map: {}, passthrough: true },
    component: { source: "component", map: {}, passthrough: true },
    squad: { source: "none", map: {}, passthrough: true },
  },
  blockedStatuses: ["Blocked"],
  auto: { enabled: false, accountId: null, accountName: null, intervalMinutes: 360 },
};

module.exports = {
  toHours, round2, normalizeJiraDate, normalizeDueDate, daysBetween, adfToText,
  buildStatusIndex, categoryOfStatusName, categoryFromField,
  extractChangelog, lifecycle, blockedStats,
  BAND, accuracyBand, variance, applyMapping, deriveIssue, deriveWorklogs, DEFAULT_SETTINGS,
};
