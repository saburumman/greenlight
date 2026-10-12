// Reporting engine (REPORTING_SPEC.md §3–§5): turns the cached Jira rows into
// the report — every sheet's tables plus the chart data — as plain JSON. Pure
// functions only (no database, no Jira, no express), so the same numbers feed
// the in-app view, the Excel workbook and the CSV downloads.
//
// Rules this file keeps (spec §7):
//  - hours only, never story points;
//  - nothing is silently dropped: tickets without an estimate, or Done with no
//    logged time, stay in every total and are ALSO listed in Data Quality;
//  - every detail row carries its issue key;
//  - dates are ISO-8601 UTC strings here; rendering in Asia/Amman happens in
//    the UI / export layer (helpers below).

const { BAND, variance: calcVariance } = require("./reportingLogic");

const DAY = 86400000;
const TZ = "Asia/Amman";

// ---------------------------------------------------------------------------
// Asia/Amman time helpers
// ---------------------------------------------------------------------------
const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function ammanParts(ms) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}
// "2026-10-12" (the calendar day it is in Amman at that instant)
function ammanYmd(isoOrMs) {
  const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (isNaN(ms)) return null;
  const p = ammanParts(ms);
  return p.year + "-" + String(p.month).padStart(2, "0") + "-" + String(p.day).padStart(2, "0");
}
// A Date whose UTC fields read as the Amman wall-clock time — what Excel
// needs (Excel has no time zones, so the wall-clock value is what is shown).
function ammanWall(isoOrMs) {
  const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (isNaN(ms)) return null;
  const p = ammanParts(ms);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}
// The UTC instant at which a calendar day starts in Amman.
function ammanDayStartMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return null;
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  let guess = target - 3 * 3600000;
  for (let i = 0; i < 3; i++) {
    const p = ammanParts(guess);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += target - wall;
  }
  return guess;
}
function ammanDayEndMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return null;
  const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  return ammanDayStartMs(next.toISOString().slice(0, 10)) - 1;
}
function ymdAddDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}
function fmtAmmanDateTime(iso) {
  if (!iso) return "";
  const p = ammanParts(Date.parse(iso));
  const z = (n) => String(n).padStart(2, "0");
  return p.year + "-" + z(p.month) + "-" + z(p.day) + " " + z(p.hour) + ":" + z(p.minute) + " (Amman)";
}

// ---------------------------------------------------------------------------
// small maths
// ---------------------------------------------------------------------------
const r1 = (n) => (n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 10) / 10);
const r2 = (n) => (n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 100) / 100);
const sum = (a) => a.reduce((s, x) => s + (Number(x) || 0), 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const isSubtask = (i) => /sub-?task/i.test(i.issue_type || "");
const isEpic = (i) => /^epic$/i.test(i.issue_type || "");
const isDone = (i) => i.status_category === "Done";
const hasEstimate = (i) => i.original_estimate_h !== null && i.original_estimate_h > 0;
const BANDS = [BAND.UNDER_BIG, BAND.UNDER_MID, BAND.ON, BAND.OVER_MID, BAND.OVER_BIG];
const NONE = "(none)";

// ---------------------------------------------------------------------------
// filters (§5)
// ---------------------------------------------------------------------------
const LIST_FILTERS = ["sprints", "services", "squads", "components", "issueTypes", "assignees", "epics", "statusCategories", "priorities"];
const UNASSIGNED = "__none__";

function normalizeFilters(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  const out = { period: { by: "created", from: "", to: "" }, blockedOnly: false, overdueOnly: false, includeSubtasks: true };
  const p = f.period || {};
  out.period.by = ["created", "completed", "worklog"].includes(p.by) ? p.by : "created";
  for (const k of ["from", "to"]) out.period[k] = /^\d{4}-\d{2}-\d{2}$/.test(String(p[k] || "")) ? String(p[k]) : "";
  for (const k of LIST_FILTERS) {
    const v = Array.isArray(f[k]) ? f[k] : [];
    out[k] = Array.from(new Set(v.map((x) => String(x == null ? "" : x).trim()).filter(Boolean))).slice(0, 200);
  }
  out.blockedOnly = f.blockedOnly === true;
  out.overdueOnly = f.overdueOnly === true;
  out.includeSubtasks = f.includeSubtasks !== false;
  return out;
}

// Plain-language list of the active filters — printed on the Cover sheet so
// the scope of any report can be reconstructed (spec §5).
function describeFilters(f, names) {
  const nm = names || {};
  const lines = [];
  if (f.period.from || f.period.to) {
    lines.push("Period (" + { created: "by created date", completed: "by completed date", worklog: "by worklog date" }[f.period.by] + "): " + (f.period.from || "start") + " to " + (f.period.to || "today") + " (Amman time)");
  }
  const label = { sprints: "Sprint", services: "Service", squads: "Squad", components: "Component", issueTypes: "Issue type", assignees: "Assignee", epics: "Epic", statusCategories: "Status category", priorities: "Priority" };
  for (const k of LIST_FILTERS) {
    if (!f[k].length) continue;
    const vals = k === "assignees" ? f[k].map((v) => (v === UNASSIGNED ? "Unassigned" : (nm.assignees && nm.assignees[v]) || v)) : k === "epics" ? f[k].map((v) => (nm.epics && nm.epics[v] ? v + " – " + nm.epics[v] : v)) : f[k];
    lines.push(label[k] + ": " + vals.join(", "));
  }
  if (f.blockedOnly) lines.push("Blocked tickets only");
  if (f.overdueOnly) lines.push("Overdue tickets only");
  if (!f.includeSubtasks) lines.push("Sub-tasks excluded");
  return lines;
}

function latestSprint(i) {
  const s = (i.sprints || []).slice();
  if (!s.length) return null;
  s.sort((a, b) => (Date.parse(a.end_date || a.start_date || 0) || 0) - (Date.parse(b.end_date || b.start_date || 0) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0));
  return s[s.length - 1].name || null;
}

function applyFilters(issues, f, worklogsByIssue) {
  const fromMs = f.period.from ? ammanDayStartMs(f.period.from) : null;
  const toMs = f.period.to ? ammanDayEndMs(f.period.to) : null;
  const inRange = (iso) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !isNaN(t) && (fromMs === null || t >= fromMs) && (toMs === null || t <= toMs);
  };
  const periodSet = fromMs !== null || toMs !== null;
  return issues.filter((i) => {
    if (periodSet) {
      if (f.period.by === "created" && !inRange(i.created_at)) return false;
      if (f.period.by === "completed" && !(isDone(i) && inRange(i.completed_at))) return false;
      if (f.period.by === "worklog" && !(worklogsByIssue.get(i.issue_key) || []).some((w) => inRange(w.started_at))) return false;
    }
    if (f.sprints.length && !(i.sprints || []).some((s) => f.sprints.includes(s.name))) return false;
    if (f.services.length && !f.services.includes(i.service || NONE)) return false;
    if (f.squads.length && !f.squads.includes(i.squad || NONE)) return false;
    if (f.components.length && !f.components.includes(i.component || NONE)) return false;
    if (f.issueTypes.length && !f.issueTypes.includes(i.issue_type)) return false;
    if (f.assignees.length && !f.assignees.includes(i.assignee_id || UNASSIGNED)) return false;
    if (f.epics.length && !f.epics.includes(i.epic_key || UNASSIGNED)) return false;
    if (f.statusCategories.length && !f.statusCategories.includes(i.status_category)) return false;
    if (f.priorities.length && !f.priorities.includes(i.priority || NONE)) return false;
    if (f.blockedOnly && !i.is_blocked && !(i.blocked_days > 0)) return false;
    if (f.overdueOnly && !i.is_overdue) return false;
    if (!f.includeSubtasks && isSubtask(i)) return false;
    return true;
  });
}

// Distinct values for the filter controls.
function filterOptions(issues, worklogs) {
  const uniq = (f) => Array.from(new Set(issues.map(f).filter((x) => x !== null && x !== undefined && x !== ""))).sort((a, b) => String(a).localeCompare(String(b)));
  const sprints = new Map();
  for (const i of issues) for (const s of i.sprints || []) if (s && s.name) sprints.set(s.name, Math.max(sprints.get(s.name) || 0, Date.parse(s.start_date || s.end_date || 0) || 0));
  const assignees = new Map();
  for (const i of issues) if (i.assignee_id) assignees.set(i.assignee_id, i.assignee_name || i.assignee_id);
  const epics = new Map();
  for (const i of issues) if (i.epic_key) epics.set(i.epic_key, i.epic_name || "");
  return {
    sprints: Array.from(sprints.entries()).sort((a, b) => b[1] - a[1]).map((x) => x[0]),
    services: uniq((i) => i.service), squads: uniq((i) => i.squad), components: uniq((i) => i.component),
    issueTypes: uniq((i) => i.issue_type), priorities: uniq((i) => i.priority),
    statusCategories: ["To Do", "In Progress", "Done"],
    assignees: Array.from(assignees.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    epics: Array.from(epics.entries()).map(([key, name]) => ({ key, name })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })),
  };
}

// ---------------------------------------------------------------------------
// column helpers
// ---------------------------------------------------------------------------
// types: key (Jira issue key) | text | int | hours | days | pct | date | datetime | yesno
const C = (key, header, type, width) => ({ key, header, type: type || "text", width: width || undefined });

function yn(b) { return b ? "Yes" : "No"; }

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------
// input: { issues, worklogs, transitions, dependencies, sync:{lastSyncedAt, lastRunStatus}, filters, now (ms), generatedBy, jiraSiteUrl, title }
function buildReport(input) {
  const nowMs = input.now || Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const today = ammanYmd(nowMs);
  const filters = normalizeFilters(input.filters);

  // Age and overdue are "as of today", so they're recomputed at report time
  // (the stored values date from the last sync).
  const all = (input.issues || []).map((i) => {
    const done = isDone(i);
    const age = !done && i.created_at ? r2((nowMs - Date.parse(i.created_at)) / DAY) : null;
    const overdue = !!(i.due_date && !done && i.due_date < today);
    return { ...i, age_days: age, is_overdue: overdue };
  });
  const allByKey = new Map(all.map((i) => [i.issue_key, i]));

  const worklogsAll = input.worklogs || [];
  const wlByIssue = new Map();
  for (const w of worklogsAll) { if (!wlByIssue.has(w.issue_key)) wlByIssue.set(w.issue_key, []); wlByIssue.get(w.issue_key).push(w); }

  const scope = applyFilters(all, filters, wlByIssue);
  const keys = new Set(scope.map((i) => i.issue_key));
  const wl = worklogsAll.filter((w) => keys.has(w.issue_key));
  // Worklog hours "in period": only when the period is by worklog date.
  const fromMs = filters.period.from ? ammanDayStartMs(filters.period.from) : null;
  const toMs = filters.period.to ? ammanDayEndMs(filters.period.to) : null;
  const wlPeriod = filters.period.by === "worklog" && (fromMs !== null || toMs !== null)
    ? wl.filter((w) => { const t = Date.parse(w.started_at); return !isNaN(t) && (fromMs === null || t >= fromMs) && (toMs === null || t <= toMs); })
    : wl;
  const trByIssue = new Map();
  for (const t of input.transitions || []) { if (!keys.has(t.issue_key)) continue; if (!trByIssue.has(t.issue_key)) trByIssue.set(t.issue_key, []); trByIssue.get(t.issue_key).push(t); }
  for (const arr of trByIssue.values()) arr.sort((a, b) => Date.parse(a.changed_at) - Date.parse(b.changed_at));
  const deps = input.dependencies || [];
  const depById = new Map(deps.map((d) => [String(d.id), d]));
  const depLabel = (id) => { const d = depById.get(String(id)); return d ? d.entity + (d.vendor ? " / " + d.vendor : "") : ""; };

  const names = { assignees: {}, epics: {} };
  for (const i of all) { if (i.assignee_id) names.assignees[i.assignee_id] = i.assignee_name; if (i.epic_key && i.epic_name) names.epics[i.epic_key] = i.epic_name; }
  const filterLines = describeFilters(filters, names);

  const meta = {
    title: input.title || "SANAD PMO Delivery Report",
    generatedAt: nowIso, generatedBy: input.generatedBy || "", lastSyncedAt: (input.sync && input.sync.lastSyncedAt) || null,
    issueCount: scope.length, totalCached: all.length, filters: filterLines, filterValues: filters, timezone: TZ,
    jiraSiteUrl: input.jiraSiteUrl || "",
  };
  const caption = "Scope: " + (filterLines.length ? filterLines.join("; ") : "all synced issues") + " · " + scope.length + " tickets · synced " + (meta.lastSyncedAt ? fmtAmmanDateTime(meta.lastSyncedAt) : "never");

  // ---- reusable pieces ----
  const done = scope.filter(isDone);
  const basis = done.filter(hasEstimate); // "variance basis": Done tickets that carry an estimate
  const groupBy = (list, keyFn) => { const m = new Map(); for (const i of list) { const k = keyFn(i); if (!m.has(k)) m.set(k, []); m.get(k).push(i); } return m; };

  function groupStats(list, worklogHours) {
    const comp = list.filter(isDone);
    const b = comp.filter(hasEstimate);
    const est = sum(b.map((i) => i.original_estimate_h)), logged = sum(b.map((i) => i.logged_h));
    const v = logged - est;
    const unest = comp.filter((i) => !hasEstimate(i));
    const row = {
      tickets: list.length, completed: comp.length,
      estimated_h: r1(est), logged_h: r1(logged), variance_h: b.length ? r1(v) : null,
      variance_pct: est > 0 ? r1((v / est) * 100) : null,
      avg_variance_h: b.length ? r1(v / b.length) : null,
    };
    BANDS.forEach((bd, idx) => { row["band" + idx] = b.filter((i) => i.estimate_accuracy_band === bd).length; });
    row.unestimated_completed = unest.length;
    row.unestimated_logged_h = r1(sum(unest.map((i) => i.logged_h)));
    if (worklogHours !== undefined) row.worklog_h = r1(worklogHours);
    return row;
  }
  const bandCols = BANDS.map((bd, idx) => C("band" + idx, bd, "int", 16));
  const groupCols = (extra) => [].concat(extra, [
    C("tickets", "Tickets in scope", "int"), C("completed", "Completed", "int"),
    C("estimated_h", "Estimated (h)", "hours"), C("logged_h", "Logged (h)", "hours"),
    C("variance_h", "Net variance (h)", "hours"), C("variance_pct", "Variance %", "pct"), C("avg_variance_h", "Avg variance per ticket (h)", "hours"),
  ], bandCols, [C("unestimated_completed", "Completed without estimate", "int"), C("unestimated_logged_h", "Logged on those (h)", "hours")]);
  const VARIANCE_NOTE = "Variance = logged − estimated hours (positive = over). Estimated, logged and variance cover COMPLETED tickets that carry an estimate; completed tickets with no estimate are counted and their logged hours shown separately (never treated as zero) and are listed in Data Quality. Percentages are of the estimate.";

  const sheets = [];

  // =====================================================================
  // Sheet 1 — Cover
  // =====================================================================
  sheets.push({
    id: "cover", name: "Cover", title: "Cover",
    blocks: [{
      id: "cover", kind: "kv", title: "Report metadata",
      columns: [C("label", "Item", "text", 28), C("value", "Value", "text", 70)],
      rows: [
        { label: "Report", value: meta.title },
        { label: "Scope (active filters)", value: filterLines.length ? filterLines.join("\n") : "None — every synced issue" },
        { label: "Period covered", value: filters.period.from || filters.period.to ? (filters.period.from || "start") + " to " + (filters.period.to || "today") + " (Amman)" : "All dates" },
        { label: "Generated by", value: meta.generatedBy || "—" },
        { label: "Generated at", value: nowIso, valueType: "datetime" },
        { label: "Data last synced from Jira", value: meta.lastSyncedAt || "Never", valueType: meta.lastSyncedAt ? "datetime" : "text" },
        { label: "Tickets in this report", value: scope.length, valueType: "int" },
        { label: "Tickets in the synced cache", value: all.length, valueType: "int" },
        { label: "Time zone", value: "All dates are shown in Asia/Amman (UTC+03:00); stored in UTC." },
        { label: "Units", value: "Effort is in hours. Story points are not used." },
        { label: "Branding", value: "SANAD / MoDEE logo placeholder" },
      ],
    }],
  });

  // =====================================================================
  // Sheet 2 — Executive summary
  // =====================================================================
  const catCount = (c) => scope.filter((i) => i.status_category === c).length;
  const estAll = sum(scope.map((i) => i.original_estimate_h)), logAll = sum(scope.map((i) => i.logged_h));
  const estBasis = sum(basis.map((i) => i.original_estimate_h)), logBasis = sum(basis.map((i) => i.logged_h));
  const unestScope = scope.filter((i) => !isEpic(i) && !hasEstimate(i));
  const onOrUnder = basis.filter((i) => i.logged_h <= i.original_estimate_h);
  const cyc = done.map((i) => i.cycle_time_days).filter((x) => x !== null && x >= 0);
  const lead = done.map((i) => i.lead_time_days).filter((x) => x !== null && x >= 0);
  const extBlocked = scope.filter((i) => i.external_dependency_id);
  const overdue = scope.filter((i) => i.is_overdue);
  const spill = scope.filter((i) => (i.sprint_count || 0) > 1);
  const top5 = basis.map((i) => ({ i, abs: Math.abs(i.logged_h - i.original_estimate_h) })).sort((a, b) => b.abs - a.abs).slice(0, 5);

  sheets.push({
    id: "summary", name: "Executive Summary", title: "Executive Summary",
    blocks: [
      {
        id: "kpis", kind: "kv", title: "Key figures",
        columns: [C("label", "Measure", "text", 52), C("value", "Value", "text", 18), C("note", "How it is calculated", "text", 80)],
        rows: [
          { label: "Total tickets in scope", value: scope.length, valueType: "int", note: "All issue types, including epics and sub-tasks unless excluded in the filters." },
          { label: "  To Do", value: catCount("To Do"), valueType: "int", note: "Jira status category." },
          { label: "  In Progress", value: catCount("In Progress"), valueType: "int", note: "" },
          { label: "  Done", value: catCount("Done"), valueType: "int", note: "" },
          { label: "Total estimated hours (all tickets)", value: r1(estAll), valueType: "hours", note: "Sum of original estimates. Tickets without an estimate add nothing here." },
          { label: "Total logged hours (all tickets)", value: r1(logAll), valueType: "hours", note: "Sum of time logged on every ticket, including ones with no estimate." },
          { label: "Net variance, all tickets (h)", value: r1(logAll - estAll), valueType: "hours", note: "Logged − estimated across everything in scope (in-progress work included)." },
          { label: "Net variance, completed & estimated tickets (h)", value: basis.length ? r1(logBasis - estBasis) : null, valueType: "hours", note: "Like-for-like: Done tickets that have an estimate (" + basis.length + " tickets)." },
          { label: "Net variance, completed & estimated tickets (%)", value: estBasis > 0 ? r1(((logBasis - estBasis) / estBasis) * 100) : null, valueType: "pct", note: "Variance hours ÷ estimated hours on the same tickets." },
          { label: "Tickets delivered on or under estimate", value: basis.length ? r1((onOrUnder.length / basis.length) * 100) : null, valueType: "pct", note: onOrUnder.length + " of " + basis.length + " completed tickets with an estimate (logged ≤ estimate)." },
          { label: "Tickets with no estimate (excluding epics)", value: unestScope.length, valueType: "int", note: "Shown in Data Quality, never dropped from totals." },
          { label: "Average cycle time (days)", value: r1(avg(cyc)), valueType: "days", note: "Started → completed, completed tickets (" + cyc.length + ")." },
          { label: "Median cycle time (days)", value: r1(median(cyc)), valueType: "days", note: "Median is steadier than the average when a few tickets are outliers." },
          { label: "Average lead time (days)", value: r1(avg(lead)), valueType: "days", note: "Created → completed, completed tickets (" + lead.length + ")." },
          { label: "Median lead time (days)", value: r1(median(lead)), valueType: "days", note: "" },
          { label: "Tickets blocked by external entities", value: extBlocked.length, valueType: "int", note: "Tickets linked to a government-entity / vendor dependency." },
          { label: "Blocked days on those tickets", value: r1(sum(extBlocked.map((i) => i.blocked_days))), valueType: "days", note: "Time in a blocked status or flagged as an impediment." },
          { label: "Overdue tickets", value: overdue.length, valueType: "int", note: "Due date before today (Amman) and not Done." },
          { label: "Sprint spillover (tickets in more than one sprint)", value: spill.length, valueType: "int", note: "" },
        ],
      },
      {
        id: "top5", kind: "table", title: "Top 5 variance contributors (by absolute hours)",
        note: "Completed tickets with an estimate; largest gap between logged and estimated hours first.",
        columns: [C("issue_key", "Issue", "key", 14), C("summary", "Summary", "text", 50), C("assignee_name", "Assignee", "text", 22), C("original_estimate_h", "Estimated (h)", "hours"), C("logged_h", "Logged (h)", "hours"), C("variance_h", "Variance (h)", "hours"), C("variance_pct", "Variance %", "pct")],
        rows: top5.map(({ i }) => ({ issue_key: i.issue_key, summary: i.summary, assignee_name: i.assignee_name || "(Unassigned)", original_estimate_h: i.original_estimate_h, logged_h: i.logged_h, variance_h: r1(i.logged_h - i.original_estimate_h), variance_pct: r1(((i.logged_h - i.original_estimate_h) / i.original_estimate_h) * 100) })),
      },
    ],
  });

  // =====================================================================
  // Sheet 3 — Full ticket register
  // =====================================================================
  const sprintNames = (i) => (i.sprints || []).map((s) => s.name).filter(Boolean).join("; ");
  const registerCols = [
    C("issue_key", "Issue key", "key", 14), C("summary", "Summary", "text", 50), C("issue_type", "Issue type", "text", 12), C("parent_key", "Parent", "key", 14), C("epic_key", "Epic key", "key", 14), C("epic_name", "Epic name", "text", 28),
    C("service", "Service", "text", 20), C("component", "Component", "text", 16), C("squad", "Squad / team", "text", 18), C("labels", "Labels", "text", 22), C("priority", "Priority", "text", 11), C("fix_version", "Fix version", "text", 16), C("release", "Release", "text", 16),
    C("status", "Status", "text", 16), C("status_category", "Status category", "text", 14), C("sprints", "Sprints", "text", 24), C("sprint_count", "Sprint count", "int", 10),
    C("assignee_id", "Assignee id", "text", 16), C("assignee_name", "Assignee", "text", 22), C("reporter_name", "Reporter", "text", 22),
    C("created_at", "Created", "datetime", 17), C("started_at", "Started", "datetime", 17), C("completed_at", "Completed", "datetime", 17), C("due_date", "Due date", "date", 12),
    C("original_estimate_h", "Original estimate (h)", "hours", 12), C("remaining_estimate_h", "Remaining estimate (h)", "hours", 12), C("logged_h", "Logged (h)", "hours", 11),
    C("variance_h", "Variance (h)", "hours", 11), C("variance_pct", "Variance %", "pct", 11), C("estimate_accuracy_band", "Estimate accuracy band", "text", 20), C("cycle_time_days", "Cycle time (days)", "days", 11), C("lead_time_days", "Lead time (days)", "days", 11), C("age_days", "Age (days)", "days", 10),
    C("is_blocked", "Blocked", "yesno", 9), C("blocked_days", "Blocked days", "days", 10), C("external_dependency_id", "External dependency", "text", 22), C("was_reopened", "Reopened", "yesno", 9), C("reopen_count", "Reopen count", "int", 9), C("is_overdue", "Overdue", "yesno", 9),
  ];
  const registerRow = (i) => ({
    issue_key: i.issue_key, summary: i.summary, issue_type: i.issue_type, parent_key: i.parent_key, epic_key: i.epic_key, epic_name: i.epic_name,
    service: i.service, component: i.component, squad: i.squad, labels: (i.labels || []).join("; "), priority: i.priority, fix_version: i.fix_version, release: i.release,
    status: i.status, status_category: i.status_category, sprints: sprintNames(i), sprint_count: i.sprint_count || 0,
    assignee_id: i.assignee_id, assignee_name: i.assignee_name, reporter_name: i.reporter_name,
    created_at: i.created_at, started_at: i.started_at, completed_at: i.completed_at, due_date: i.due_date,
    original_estimate_h: i.original_estimate_h, remaining_estimate_h: i.remaining_estimate_h, logged_h: i.logged_h,
    variance_h: i.variance_h, variance_pct: i.variance_pct, estimate_accuracy_band: i.estimate_accuracy_band,
    cycle_time_days: i.cycle_time_days, lead_time_days: i.lead_time_days, age_days: i.age_days,
    is_blocked: yn(i.is_blocked), blocked_days: i.blocked_days, external_dependency_id: i.external_dependency_id ? depLabel(i.external_dependency_id) || String(i.external_dependency_id) : "",
    was_reopened: yn(i.was_reopened), reopen_count: i.reopen_count, is_overdue: yn(i.is_overdue),
  });
  const byKeyAsc = (a, b) => String(a.issue_key).localeCompare(String(b.issue_key), undefined, { numeric: true });
  sheets.push({
    id: "register", name: "Ticket Register", title: "Full Ticket Register",
    blocks: [{ id: "register", kind: "table", title: "Every ticket in scope", note: "One row per ticket — identity, classification, ownership, dates, effort, variance, flags. Age and overdue are as of the day the report was generated.", columns: registerCols, rows: scope.slice().sort(byKeyAsc).map(registerRow) }],
  });

  // =====================================================================
  // Sheet 4 — Variance by ticket
  // =====================================================================
  const vtRows = scope.map((i) => ({
    issue_key: i.issue_key, issue_type: i.issue_type, component: i.component, assignee_name: i.assignee_name || "(Unassigned)",
    epic: i.epic_key ? i.epic_key + (i.epic_name ? " – " + i.epic_name : "") : "", service: i.service,
    original_estimate_h: i.original_estimate_h, logged_h: i.logged_h, variance_h: i.variance_h, variance_pct: i.variance_pct, estimate_accuracy_band: i.estimate_accuracy_band,
    sprint: latestSprint(i) || "", created_at: i.created_at, completed_at: i.completed_at,
  })).sort((a, b) => {
    const av = a.variance_h === null ? -1 : Math.abs(a.variance_h), bv = b.variance_h === null ? -1 : Math.abs(b.variance_h);
    return bv - av || String(a.issue_key).localeCompare(String(b.issue_key), undefined, { numeric: true });
  });
  sheets.push({
    id: "variance_tickets", name: "Variance by Ticket", title: "Variance Report — by ticket",
    blocks: [{
      id: "variance_tickets", kind: "table", title: "Estimated vs logged hours per ticket",
      note: "Largest absolute variance first; tickets with no estimate are kept at the end (grey) rather than dropped. Sprint = the ticket's latest sprint. Over estimate = red, under = green.",
      columns: [C("issue_key", "Issue key", "key", 14), C("issue_type", "Type", "text", 12), C("component", "Component", "text", 16), C("assignee_name", "Assignee", "text", 22), C("epic", "Epic", "text", 30), C("service", "Service", "text", 20),
        C("original_estimate_h", "Estimated (h)", "hours", 12), C("logged_h", "Logged (h)", "hours", 11), C("variance_h", "Variance (h)", "hours", 11), C("variance_pct", "Variance %", "pct", 11), C("estimate_accuracy_band", "Accuracy band", "text", 20),
        C("sprint", "Sprint", "text", 20), C("created_at", "Created", "date", 12), C("completed_at", "Completed", "date", 12)],
      rows: vtRows, colorBy: "estimate_accuracy_band",
    }],
  });

  // =====================================================================
  // Sheet 5 — Variance by team member
  // =====================================================================
  const memberKey = (i) => i.assignee_id || UNASSIGNED;
  const byAssignee = groupBy(scope, memberKey);
  const hoursByAuthor = new Map(), authorNames = new Map();
  for (const w of wlPeriod) { const k = w.author_id || UNASSIGNED; hoursByAuthor.set(k, (hoursByAuthor.get(k) || 0) + (w.time_spent_h || 0)); if (w.author_name) authorNames.set(k, w.author_name); }
  const memberIds = new Set([...byAssignee.keys(), ...hoursByAuthor.keys()]);
  const memberRows = Array.from(memberIds).map((k) => {
    const list = byAssignee.get(k) || [];
    const name = k === UNASSIGNED ? "(Unassigned)" : (list[0] && list[0].assignee_name) || authorNames.get(k) || k;
    return { member: name, ...groupStats(list, hoursByAuthor.get(k) || 0) };
  }).sort((a, b) => a.member.localeCompare(b.member));
  sheets.push({
    id: "variance_members", name: "Variance by Member", title: "Variance Report — by team member",
    blocks: [{
      id: "variance_members", kind: "table", title: "Estimation calibration by team member",
      note: "This sheet is for estimation calibration, not individual performance ranking. Over-logging is usually an estimation or scope problem, not a person problem. " + VARIANCE_NOTE + " “Worklog hours” are the hours this person logged on tickets in scope" + (filters.period.by === "worklog" && (filters.period.from || filters.period.to) ? " within the period" : "") + " — they can exceed the completed tickets' hours because they include work on tickets still open and work on other people's tickets. Members are listed alphabetically.",
      columns: groupCols([C("member", "Team member", "text", 26)]).concat([C("worklog_h", "Worklog hours (h)", "hours", 14)]),
      rows: memberRows,
    }],
  });

  // =====================================================================
  // Sheet 6 — Variance by squad / component / service (three sheets)
  // =====================================================================
  function groupSheet(id, name, title, label, keyFn) {
    const m = groupBy(scope, (i) => keyFn(i) || NONE);
    const hours = new Map();
    for (const w of wlPeriod) { const iss = allByKey.get(w.issue_key); const k = (iss && keyFn(iss)) || NONE; hours.set(k, (hours.get(k) || 0) + (w.time_spent_h || 0)); }
    const rows = Array.from(m.entries()).map(([k, list]) => ({ group: k, ...groupStats(list, hours.get(k) || 0) })).sort((a, b) => a.group.localeCompare(b.group));
    return {
      id, name, title,
      blocks: [{ id, kind: "table", title: "By " + label.toLowerCase(), note: VARIANCE_NOTE + " Groups are listed alphabetically; “" + NONE + "” holds tickets with no " + label.toLowerCase() + " set.", columns: groupCols([C("group", label, "text", 24)]).concat([C("worklog_h", "Worklog hours (h)", "hours", 14)]), rows }],
    };
  }
  sheets.push(groupSheet("variance_squad", "Variance by Squad", "Variance Report — by squad / team", "Squad", (i) => i.squad));
  sheets.push(groupSheet("variance_component", "Variance by Component", "Variance Report — by component", "Component", (i) => i.component));
  sheets.push(groupSheet("variance_service", "Variance by Service", "Variance Report — by SANAD service", "Service", (i) => i.service));

  // =====================================================================
  // Sheet 7 — Epic rollup
  // =====================================================================
  const epicGroups = groupBy(scope.filter((i) => i.epic_key && !isEpic(i)), (i) => i.epic_key);
  const epicRows = Array.from(epicGroups.entries()).map(([ek, kids]) => {
    const epic = allByKey.get(ek);
    const doneKids = kids.filter(isDone), open = kids.filter((i) => !isDone(i));
    const est = sum(kids.map((i) => i.original_estimate_h)), logged = sum(kids.map((i) => i.logged_h));
    const created = kids.map((i) => Date.parse(i.created_at)).filter((x) => !isNaN(x));
    const completed = doneKids.map((i) => Date.parse(i.completed_at)).filter((x) => !isNaN(x));
    const epicDue = epic && epic.due_date;
    const overOpen = open.filter((i) => i.is_overdue);
    const slipped = overOpen.length > 0 || !!(epicDue && epicDue < today && open.length > 0);
    const kidsWithEst = kids.filter(hasEstimate);
    const overBudget = sum(kidsWithEst.map((i) => i.logged_h)) > sum(kidsWithEst.map((i) => i.original_estimate_h)) && open.length > 0;
    const blocked = open.some((i) => i.is_blocked);
    const forecast = slipped ? "Slipped" : blocked || overBudget ? "At risk" : "On track";
    const why = slipped ? (overOpen.length ? overOpen.length + " open ticket(s) overdue" : "epic due date passed with work open") : blocked ? "an open ticket is blocked" : overBudget ? "logged hours already exceed the estimate on open work" : "";
    const depNames = Array.from(new Set(kids.map((i) => i.external_dependency_id).filter(Boolean).map((id) => depLabel(id)).filter(Boolean)));
    return {
      epic_key: ek, epic_name: (epic && epic.summary) || kids[0].epic_name || "", children: kids.length, done: doneKids.length,
      pct_complete: r1((doneKids.length / kids.length) * 100), estimated_h: r1(est), logged_h: r1(logged), variance_h: r1(logged - est), variance_pct: est > 0 ? r1(((logged - est) / est) * 100) : null,
      earliest_created: created.length ? new Date(Math.min(...created)).toISOString() : null,
      latest_completed: completed.length && !open.length ? new Date(Math.max(...completed)).toISOString() : (completed.length ? new Date(Math.max(...completed)).toISOString() : null),
      forecast, forecast_reason: why, epic_due_date: epicDue || null, dependencies: depNames.join("; "),
    };
  }).sort((a, b) => a.epic_key.localeCompare(b.epic_key, undefined, { numeric: true }));
  sheets.push({
    id: "epics", name: "Epic Rollup", title: "Epic Rollup",
    blocks: [{
      id: "epics", kind: "table", title: "Progress and variance per epic",
      note: "Children = tickets in scope whose epic is this one (sub-tasks inherit their parent's epic). Forecast: Slipped = an open ticket is overdue, or the epic's own due date has passed with work still open; At risk = not slipped but an open ticket is blocked, or hours logged already exceed the estimate on work still open; On track otherwise. Tickets with no epic are listed in Data Quality.",
      columns: [C("epic_key", "Epic", "key", 14), C("epic_name", "Epic name", "text", 36), C("children", "Child tickets", "int"), C("done", "Done", "int"), C("pct_complete", "% complete", "pct"),
        C("estimated_h", "Estimated (h)", "hours"), C("logged_h", "Logged (h)", "hours"), C("variance_h", "Variance (h)", "hours"), C("variance_pct", "Variance %", "pct"),
        C("earliest_created", "Earliest created", "date", 13), C("latest_completed", "Latest completed", "date", 13), C("epic_due_date", "Epic due date", "date", 13),
        C("forecast", "Forecast", "text", 11), C("forecast_reason", "Why", "text", 44), C("dependencies", "External dependencies", "text", 36)],
      rows: epicRows,
    }],
  });

  // =====================================================================
  // Sheet 8 — Status & flow
  // =====================================================================
  const statusRows = Array.from(groupBy(scope, (i) => i.status + "\u0000" + i.status_category).entries()).map(([k, l]) => { const [s, c] = k.split("\u0000"); return { status: s, status_category: c, tickets: l.length }; })
    .sort((a, b) => ["To Do", "In Progress", "Done"].indexOf(a.status_category) - ["To Do", "In Progress", "Done"].indexOf(b.status_category) || a.status.localeCompare(b.status));
  const catRows = ["To Do", "In Progress", "Done"].map((c) => ({ status_category: c, tickets: catCount(c) }));
  const typeOrder = ["Epic", "User Story", "Story", "Task", "Sub-task", "Bug", "Spike"];
  const typeRows = Array.from(groupBy(scope, (i) => i.issue_type).entries()).map(([t, l]) => ({ issue_type: t, tickets: l.length }))
    .sort((a, b) => (typeOrder.indexOf(a.issue_type) + 100) % 100 - (typeOrder.indexOf(b.issue_type) + 100) % 100 || a.issue_type.localeCompare(b.issue_type));
  const statusesInScope = Array.from(new Set(scope.map((i) => i.status))).sort();
  const compRows = Array.from(groupBy(scope, (i) => i.component || NONE).entries()).map(([c, l]) => {
    const row = { component: c, total: l.length };
    statusesInScope.forEach((s, idx) => { row["s" + idx] = l.filter((i) => i.status === s).length; });
    return row;
  }).sort((a, b) => a.component.localeCompare(b.component));
  // time in status: every visit to a status, from the status history
  const visits = new Map();
  for (const i of scope) {
    const tr = trByIssue.get(i.issue_key) || [];
    const segs = [];
    if (tr.length) {
      segs.push({ s: tr[0].from_status, from: Date.parse(i.created_at), to: Date.parse(tr[0].changed_at) });
      for (let n = 0; n < tr.length; n++) segs.push({ s: tr[n].to_status, from: Date.parse(tr[n].changed_at), to: n + 1 < tr.length ? Date.parse(tr[n + 1].changed_at) : (isDone(i) ? NaN : nowMs) });
    } else if (!isDone(i)) segs.push({ s: i.status, from: Date.parse(i.created_at), to: nowMs });
    for (const sg of segs) {
      if (!sg.s || isNaN(sg.from) || isNaN(sg.to) || sg.to < sg.from) continue;
      if (!visits.has(sg.s)) visits.set(sg.s, []);
      visits.get(sg.s).push((sg.to - sg.from) / DAY);
    }
  }
  const tisRows = Array.from(visits.entries()).map(([s, d]) => ({ status: s, visits: d.length, avg_days: r1(avg(d)), median_days: r1(median(d)), total_days: r1(sum(d)) })).sort((a, b) => b.total_days - a.total_days);
  const AGING = [["0–7 days"], ["8–14 days"], ["15–30 days"], ["30+ days"]];
  const openWork = scope.filter((i) => !isDone(i) && !isEpic(i) && i.age_days !== null);
  // buckets are mutually exclusive: <=7, <=14, <=30, >30 days old
  const bucketOf = (age) => (age <= 7 ? 0 : age <= 14 ? 1 : age <= 30 ? 2 : 3);
  const agingRows = AGING.map(([label], idx) => ({ bucket: label, tickets: openWork.filter((i) => bucketOf(i.age_days) === idx).length }));
  const periodFrom = fromMs, periodTo = toMs;
  const inP = (iso) => { const t = Date.parse(iso); return !isNaN(t) && (periodFrom === null || t >= periodFrom) && (periodTo === null || t <= periodTo); };
  const bugs = scope.filter((i) => /bug/i.test(i.issue_type));
  const bugsCreated = bugs.filter((i) => inP(i.created_at)).length, bugsResolved = bugs.filter((i) => isDone(i) && inP(i.completed_at)).length;
  const bugSummary = [{ measure: "Bugs created in period", bugs: bugsCreated }, { measure: "Bugs resolved in period", bugs: bugsResolved }, { measure: "Bugs open now", bugs: bugs.filter((i) => !isDone(i)).length }];
  const openBugs = bugs.filter((i) => !isDone(i));
  const prios = Array.from(new Set(openBugs.map((i) => i.priority || NONE))).sort();
  const bugPrioRows = prios.map((p) => { const l = openBugs.filter((i) => (i.priority || NONE) === p); const row = { priority: p, open_bugs: l.length }; AGING.forEach((a, idx) => { row["age" + idx] = l.filter((i) => bucketOf(i.age_days || 0) === idx).length; }); return row; });
  sheets.push({
    id: "flow", name: "Status & Flow", title: "Status & Flow Analysis",
    blocks: [
      { id: "flow_status", kind: "table", title: "Tickets by status", columns: [C("status", "Status", "text", 24), C("status_category", "Status category", "text", 16), C("tickets", "Tickets", "int")], rows: statusRows },
      { id: "flow_category", kind: "table", title: "Tickets by status category", columns: [C("status_category", "Status category", "text", 24), C("tickets", "Tickets", "int")], rows: catRows },
      { id: "flow_type", kind: "table", title: "Tickets by issue type", columns: [C("issue_type", "Issue type", "text", 24), C("tickets", "Tickets", "int")], rows: typeRows },
      { id: "flow_component", kind: "table", title: "Tickets by component and status", columns: [C("component", "Component", "text", 24), C("total", "Total", "int")].concat(statusesInScope.map((s, idx) => C("s" + idx, s, "int", 12))), rows: compRows },
      { id: "flow_time", kind: "table", title: "Time in status (days per visit)", note: "Each time a ticket sits in a status counts as one visit. Tickets that are Done are not counted in their final status; open tickets count up to today.", columns: [C("status", "Status", "text", 24), C("visits", "Visits", "int"), C("avg_days", "Average (days)", "days"), C("median_days", "Median (days)", "days"), C("total_days", "Total (days)", "days")], rows: tisRows },
      { id: "flow_aging", kind: "table", title: "Aging work in progress", note: "Open tickets (excluding epics) by days since creation, as of the day the report was generated.", columns: [C("bucket", "Age", "text", 24), C("tickets", "Open tickets", "int")], rows: agingRows },
      { id: "flow_bugs", kind: "table", title: "Bugs", note: "Created / resolved use the report period when one is set (otherwise all dates).", columns: [C("measure", "Measure", "text", 28), C("bugs", "Bugs", "int")], rows: bugSummary },
      { id: "flow_bug_prio", kind: "table", title: "Open bugs by priority and age", columns: [C("priority", "Priority", "text", 24), C("open_bugs", "Open bugs", "int")].concat(AGING.map((a, idx) => C("age" + idx, a[0], "int", 12))), rows: bugPrioRows },
    ],
  });

  // =====================================================================
  // Sheet 9 — Dependency & blocker report
  // =====================================================================
  const linked = new Map();
  for (const i of all) if (i.external_dependency_id) { const k = String(i.external_dependency_id); if (!linked.has(k)) linked.set(k, []); linked.get(k).push(i); }
  const OPEN_DEP = ["Requested", "In progress"];
  const depRows = deps.map((d) => {
    const iss = linked.get(String(d.id)) || [];
    const isOpen = OPEN_DEP.includes(d.status);
    const overdueDays = isOpen && d.promised_date && d.promised_date < today ? Math.round((ammanDayStartMs(today) - ammanDayStartMs(d.promised_date)) / DAY) : 0;
    return {
      entity: d.entity, vendor: d.vendor || "", needed: d.needed || "", owner_name: d.owner_name || "", promised_date: d.promised_date || null, status: d.status,
      days_overdue: overdueDays, last_contact_date: d.last_contact_date || null, next_followup_date: d.next_followup_date || null,
      blocked_issues: iss.map((i) => i.issue_key).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(", "), blocked_issue_count: iss.length, blocked_days: r1(sum(iss.map((i) => i.blocked_days))),
      in_scope: iss.filter((i) => keys.has(i.issue_key)).length,
    };
  }).sort((a, b) => b.days_overdue - a.days_overdue || a.entity.localeCompare(b.entity));
  sheets.push({
    id: "dependencies", name: "Dependencies", title: "Dependency & Blocker Report",
    blocks: [{
      id: "dependencies", kind: "table", title: "What external entities and vendors owe us",
      note: "Dependencies are tracked in the Dependencies tab of the Reporting page and linked to the Jira tickets they block. Days overdue counts only while a request is still Requested / In progress. Blocked days = blocked time summed over the linked tickets (all tickets linked, whether or not the report filters include them).",
      columns: [C("entity", "Government entity", "text", 26), C("vendor", "Vendor", "text", 20), C("needed", "What is needed", "text", 34), C("owner_name", "Owner", "text", 20), C("promised_date", "Promised date", "date", 13), C("status", "Status", "text", 13), C("days_overdue", "Days overdue", "int", 11),
        C("last_contact_date", "Last contact", "date", 13), C("next_followup_date", "Next follow-up", "date", 13), C("blocked_issues", "Blocked issue keys", "text", 40), C("blocked_issue_count", "Blocked tickets", "int", 11), C("blocked_days", "Total blocked days", "days", 12)],
      rows: depRows,
    }],
  });

  // =====================================================================
  // Sheet 11 — Data quality
  // =====================================================================
  const dq = [];
  const add = (i, category, reason) => dq.push({ issue_key: i.issue_key, category, reason, summary: i.summary, issue_type: i.issue_type, status: i.status, assignee_name: i.assignee_name || "(Unassigned)" });
  for (const i of scope) {
    if (!isEpic(i) && !hasEstimate(i)) add(i, "Unestimated", i.original_estimate_h === 0 ? "Original estimate is 0 hours" : "No original estimate");
    if (isDone(i) && !(i.logged_h > 0)) add(i, "Done with no logged time", "Marked Done with 0 hours logged");
    if (!isEpic(i) && !i.assignee_id) add(i, "No assignee", "Nobody is assigned");
    if (!isEpic(i) && !i.epic_key) add(i, "No epic", "Not linked to an epic");
    if (i.started_at && i.completed_at && Date.parse(i.completed_at) < Date.parse(i.started_at)) add(i, "Completed before started", "Completed " + (ammanYmd(i.completed_at)) + " is before it started " + ammanYmd(i.started_at));
    if (i.was_reopened) add(i, "Reopened", "Reopened " + i.reopen_count + " time(s)");
  }
  dq.sort((a, b) => a.category.localeCompare(b.category) || a.issue_key.localeCompare(b.issue_key, undefined, { numeric: true }));
  const dqSummary = Array.from(groupBy(dq, (r) => r.category).entries()).map(([c, l]) => ({ category: c, tickets: l.length }));
  sheets.push({
    id: "data_quality", name: "Data Quality", title: "Data Quality",
    blocks: [
      { id: "dq_summary", kind: "table", title: "Summary", columns: [C("category", "Check", "text", 30), C("tickets", "Tickets", "int")], rows: dqSummary },
      { id: "dq_rows", kind: "table", title: "Tickets that need attention", note: "None of these are excluded from any total. Epics are not checked for estimate, assignee or epic link (epics normally carry none).", columns: [C("issue_key", "Issue key", "key", 14), C("category", "Check", "text", 26), C("reason", "Reason", "text", 50), C("summary", "Summary", "text", 50), C("issue_type", "Type", "text", 12), C("status", "Status", "text", 16), C("assignee_name", "Assignee", "text", 22)], rows: dq },
    ],
  });

  // =====================================================================
  // Pivot-friendly flat tables (Excel + CSV)
  // =====================================================================
  const month = (iso) => (iso ? (ammanYmd(iso) || "").slice(0, 7) : null);
  const pivotCols = [
    C("issue_key", "issue_key", "key", 14), C("summary", "summary", "text", 40), C("issue_type", "issue_type", "text", 12), C("epic_key", "epic_key", "text", 14), C("epic_name", "epic_name", "text", 24),
    C("service", "service", "text", 18), C("squad", "squad", "text", 16), C("component", "component", "text", 14), C("status", "status", "text", 14), C("status_category", "status_category", "text", 14), C("priority", "priority", "text", 10),
    C("release", "release", "text", 14), C("sprint", "sprint", "text", 16), C("assignee", "assignee", "text", 20), C("reporter", "reporter", "text", 20),
    C("created", "created", "date", 12), C("created_month", "created_month", "text", 12), C("completed", "completed", "date", 12), C("completed_month", "completed_month", "text", 14), C("due_date", "due_date", "date", 12),
    C("estimate_h", "estimate_h", "hours", 11), C("remaining_h", "remaining_h", "hours", 11), C("logged_h", "logged_h", "hours", 10), C("variance_h", "variance_h", "hours", 10), C("variance_pct", "variance_pct", "pct", 11), C("accuracy_band", "accuracy_band", "text", 20),
    C("cycle_days", "cycle_days", "days", 10), C("lead_days", "lead_days", "days", 10), C("age_days", "age_days", "days", 10), C("blocked_days", "blocked_days", "days", 11),
    C("is_blocked", "is_blocked", "yesno", 10), C("is_overdue", "is_overdue", "yesno", 10), C("was_reopened", "was_reopened", "yesno", 11), C("reopen_count", "reopen_count", "int", 11), C("tickets", "tickets", "int", 8), C("completed_flag", "completed_flag", "int", 12),
  ];
  const pivotRows = scope.slice().sort(byKeyAsc).map((i) => ({
    issue_key: i.issue_key, summary: i.summary, issue_type: i.issue_type, epic_key: i.epic_key, epic_name: i.epic_name, service: i.service || NONE, squad: i.squad || NONE, component: i.component || NONE,
    status: i.status, status_category: i.status_category, priority: i.priority || NONE, release: i.release || NONE, sprint: latestSprint(i) || NONE, assignee: i.assignee_name || "(Unassigned)", reporter: i.reporter_name,
    created: i.created_at, created_month: month(i.created_at), completed: i.completed_at, completed_month: month(i.completed_at), due_date: i.due_date,
    estimate_h: i.original_estimate_h, remaining_h: i.remaining_estimate_h, logged_h: i.logged_h, variance_h: i.variance_h, variance_pct: i.variance_pct, accuracy_band: i.estimate_accuracy_band,
    cycle_days: i.cycle_time_days, lead_days: i.lead_time_days, age_days: i.age_days, blocked_days: i.blocked_days,
    is_blocked: yn(i.is_blocked), is_overdue: yn(i.is_overdue), was_reopened: yn(i.was_reopened), reopen_count: i.reopen_count, tickets: 1, completed_flag: isDone(i) ? 1 : 0,
  }));
  sheets.push({ id: "pivot_source", name: "PIVOT_SOURCE", title: "PIVOT_SOURCE", raw: true,
    blocks: [{ id: "pivot_source", kind: "table", title: "One flat row per ticket — insert a PivotTable from here", note: "Fully denormalised: every dimension is on the row, empty dimensions read “" + NONE + "”. “tickets” is always 1 and “completed_flag” 1 for Done, so they can be summed in a pivot.", columns: pivotCols, rows: pivotRows }] });
  const wlCols = [
    C("worklog_id", "worklog_id", "text", 12), C("issue_key", "issue_key", "key", 14), C("author", "author", "text", 22), C("work_date", "work_date", "date", 12), C("work_month", "work_month", "text", 12), C("hours", "hours", "hours", 9),
    C("issue_type", "issue_type", "text", 12), C("epic_key", "epic_key", "text", 14), C("service", "service", "text", 18), C("squad", "squad", "text", 16), C("component", "component", "text", 14), C("status_category", "status_category", "text", 14), C("assignee", "assignee", "text", 20),
  ];
  const wlRows = wlPeriod.map((w) => { const i = allByKey.get(w.issue_key) || {}; return {
    worklog_id: w.worklog_id, issue_key: w.issue_key, author: w.author_name || "(Unknown)", work_date: w.started_at, work_month: month(w.started_at), hours: w.time_spent_h,
    issue_type: i.issue_type, epic_key: i.epic_key, service: i.service || NONE, squad: i.squad || NONE, component: i.component || NONE, status_category: i.status_category, assignee: i.assignee_name || "(Unassigned)",
  }; }).sort((a, b) => (Date.parse(a.work_date) || 0) - (Date.parse(b.work_date) || 0));
  sheets.push({ id: "pivot_worklogs", name: "PIVOT_WORKLOGS", title: "PIVOT_WORKLOGS", raw: true,
    blocks: [{ id: "pivot_worklogs", kind: "table", title: "One flat row per worklog entry — hours by person and day", note: "Worklogs on tickets in scope" + (filters.period.by === "worklog" && (filters.period.from || filters.period.to) ? ", within the period" : "") + ". work_date is the day the work was done, not the day it was logged.", columns: wlCols, rows: wlRows }] });

  // =====================================================================
  // Sheet 10 — charts (data only; drawn by public/reportingCharts.js)
  // =====================================================================
  const charts = buildChartData({ scope, basis, wl, deps: depRows, caption, nowMs, fromMs, toMs, latestSprint });
  sheets.splice(sheets.findIndex((s) => s.id === "dependencies") + 1, 0, { id: "charts", name: "Charts", title: "Charts", charts: true, blocks: [] });

  // Sheet guide on the Cover: what each sheet is for.
  const GUIDE = {
    summary: "Headline numbers for the scope, with how each is calculated, and the five biggest variance contributors.",
    register: "Every ticket, one row each — identity, classification, ownership, dates, effort, variance and flags.",
    variance_tickets: "Estimated vs logged hours per ticket, largest gap first; tickets without an estimate kept at the end.",
    variance_members: "Estimation calibration per team member (not a performance ranking).",
    variance_squad: "Estimated vs logged hours per squad / team.",
    variance_component: "Estimated vs logged hours per component.",
    variance_service: "Estimated vs logged hours per SANAD service.",
    epics: "Progress, effort, variance and delivery forecast per epic.",
    flow: "Tickets by status, type and component; time in status; aging work in progress; bugs.",
    dependencies: "What government entities and vendors owe the programme, and the tickets they block.",
    charts: "The charts, each with its scope caption.",
    data_quality: "Tickets that are missing an estimate, assignee or epic, are Done with no logged time, or look inconsistent — nothing is excluded from totals.",
    pivot_source: "One flat row per ticket for building PivotTables (Insert > PivotTable).",
    pivot_worklogs: "One flat row per worklog entry — hours by person and day for PivotTables.",
  };
  sheets[0].blocks.push({
    id: "guide", kind: "table", title: "Sheets in this workbook",
    columns: [C("sheet", "Sheet", "text", 28), C("about", "What it contains", "text", 70)],
    rows: sheets.filter((x) => GUIDE[x.id]).map((x) => ({ sheet: x.name, about: GUIDE[x.id] })),
  });

  return { meta, sheets, charts, caption };
}

// ---------------------------------------------------------------------------
// chart data (§4)
// ---------------------------------------------------------------------------
function buildChartData(ctx) {
  const { scope, basis, deps, caption, nowMs, fromMs, toMs, latestSprint: ls } = ctx;
  const chartList = [];
  const mkGrouped = (id, title, keyFn, label) => {
    const m = new Map();
    for (const i of basis) { const k = keyFn(i) || NONE; if (!m.has(k)) m.set(k, { est: 0, logged: 0, n: 0 }); const g = m.get(k); g.est += i.original_estimate_h; g.logged += i.logged_h; g.n++; }
    const rows = Array.from(m.entries()).map(([k, g]) => ({ label: k, est: r1(g.est), logged: r1(g.logged), n: g.n }));
    return { id, type: "grouped", title, xLabel: label, yLabel: "Hours (h)", series: [{ key: "est", name: "Estimated (h)" }, { key: "logged", name: "Logged (h)" }], rows, caption, group: "est_vs_logged" };
  };
  const bySprint = mkGrouped("est_logged_sprint", "Estimated vs logged hours — by sprint", (i) => ls(i), "Sprint (latest sprint of each ticket)");
  bySprint.rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const bySquad = mkGrouped("est_logged_squad", "Estimated vs logged hours — by team", (i) => i.squad, "Squad / team");
  const byComp = mkGrouped("est_logged_component", "Estimated vs logged hours — by component", (i) => i.component, "Component");
  for (const c of [bySquad, byComp]) c.rows.sort((a, b) => a.label.localeCompare(b.label));
  chartList.push(byComp, bySquad, bySprint);

  chartList.push({
    id: "variance_hist", type: "bars", title: "Variance % distribution — completed tickets", xLabel: "Estimate accuracy band", yLabel: "Tickets (count)",
    rows: BANDS.map((b) => ({ label: b, value: basis.filter((i) => i.estimate_accuracy_band === b).length, tone: b === BAND.ON ? "good" : /Over/.test(b) ? "over" : "under" })), caption,
  });
  const cats = ["To Do", "In Progress", "Done"];
  chartList.push({ id: "status_donut", type: "donut", title: "Status distribution — by status category", yLabel: "Tickets (count)", rows: cats.map((c) => ({ label: c, value: scope.filter((i) => i.status_category === c).length })), caption });
  const comps = Array.from(new Set(scope.map((i) => i.component || NONE))).sort();
  chartList.push({
    id: "status_stack", type: "stacked", title: "Status category by component", xLabel: "Component", yLabel: "Tickets (count)", series: cats.map((c) => ({ key: c, name: c })),
    rows: comps.map((c) => { const l = scope.filter((i) => (i.component || NONE) === c); const row = { label: c }; cats.forEach((k) => { row[k] = l.filter((i) => i.status_category === k).length; }); return row; }), caption,
  });
  const types = Array.from(new Set(scope.map((i) => i.issue_type))).sort();
  chartList.push({ id: "issue_types", type: "bars", title: "Issue type breakdown", xLabel: "Issue type", yLabel: "Tickets (count)", rows: types.map((t) => ({ label: t, value: scope.filter((i) => i.issue_type === t).length })), caption });

  // cumulative created vs completed
  const created = scope.map((i) => Date.parse(i.created_at)).filter((x) => !isNaN(x));
  const completed = scope.filter(isDone).map((i) => Date.parse(i.completed_at)).filter((x) => !isNaN(x));
  let line = { id: "flow_cumulative", type: "line", title: "Cumulative created vs completed", xLabel: "Date (Amman)", yLabel: "Tickets (cumulative count)", series: [{ key: "created", name: "Created" }, { key: "completed", name: "Completed" }], rows: [], caption };
  if (created.length) {
    const lo = Math.min(...created, ...(completed.length ? completed : [Infinity]));
    const hi = Math.max(...created, ...(completed.length ? completed : [-Infinity]), 0);
    const spanDays = (hi - lo) / DAY;
    const monthly = spanDays > 120;
    const bucketStart = (ms) => { const y = ammanYmd(ms); if (monthly) return y.slice(0, 7) + "-01"; const d = new Date(Date.parse(y + "T00:00:00Z")); const dow = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - dow * DAY).toISOString().slice(0, 10); };
    const cb = new Map(), kb = new Map();
    for (const t of created) { const b = bucketStart(t); cb.set(b, (cb.get(b) || 0) + 1); }
    for (const t of completed) { const b = bucketStart(t); kb.set(b, (kb.get(b) || 0) + 1); }
    const labels = Array.from(new Set([...cb.keys(), ...kb.keys()])).sort();
    let a = 0, b = 0;
    line.rows = labels.map((l) => { a += cb.get(l) || 0; b += kb.get(l) || 0; return { label: monthly ? l.slice(0, 7) : l, created: a, completed: b }; });
    line.xLabel = monthly ? "Month (Amman)" : "Week starting (Amman)";
  }
  chartList.push(line);

  // cycle-time scatter
  const pts = scope.filter((i) => isDone(i) && i.cycle_time_days !== null && i.cycle_time_days >= 0 && i.completed_at).map((i) => ({ key: i.issue_key, x: Date.parse(i.completed_at), y: i.cycle_time_days, type: i.issue_type }));
  chartList.push({ id: "cycle_scatter", type: "scatter", title: "Cycle time per completed ticket", xLabel: "Completed date (Amman)", yLabel: "Cycle time (days)", points: pts.slice(0, 3000), caption });

  // aging WIP
  const bucketOf = (age) => (age <= 7 ? 0 : age <= 14 ? 1 : age <= 30 ? 2 : 3);
  const open = scope.filter((i) => !isDone(i) && !isEpic(i) && i.age_days !== null);
  chartList.push({ id: "aging_wip", type: "hbars", title: "Aging work in progress", xLabel: "Open tickets (count)", yLabel: "Age since creation", rows: ["0–7 days", "8–14 days", "15–30 days", "30+ days"].map((l, idx) => ({ label: l, value: open.filter((i) => bucketOf(i.age_days) === idx).length })), caption });

  // top 10 variance contributors
  const top = basis.map((i) => ({ key: i.issue_key, v: i.logged_h - i.original_estimate_h })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 10);
  chartList.push({ id: "top_variance", type: "hbars", title: "Top 10 variance contributors", xLabel: "Variance (h) — over (+) / under (−) the estimate", yLabel: "Ticket", diverging: true, rows: top.map((t) => ({ label: t.key, value: r1(t.v) })), caption });

  // dependency ageing
  chartList.push({ id: "dependency_ageing", type: "hbars", title: "Dependency ageing", xLabel: "Days overdue", yLabel: "Government entity", rows: deps.filter((d) => d.days_overdue > 0).map((d) => ({ label: d.entity + (d.vendor ? " / " + d.vendor : ""), value: d.days_overdue })).sort((a, b) => b.value - a.value).slice(0, 15), caption });
  return chartList;
}

// The in-app view shows the first `max` rows of each long table (the full data
// is always in the Excel/CSV download). Every cut table says how many rows it
// really has, so the page can never pass a partial table off as complete.
function capRows(report, max, rawMax) {
  const out = { ...report, sheets: report.sheets.map((sh) => ({ ...sh, blocks: sh.blocks.map((b) => {
    const limit = sh.raw ? rawMax || 50 : max;
    if (b.kind !== "table" || b.rows.length <= limit) return { ...b, totalRows: b.rows.length };
    return { ...b, rows: b.rows.slice(0, limit), totalRows: b.rows.length };
  }) })) };
  return out;
}

module.exports = {
  capRows,
  TZ, BANDS, UNASSIGNED, NONE,
  ammanParts, ammanYmd, ammanWall, ammanDayStartMs, ammanDayEndMs, ymdAddDays, fmtAmmanDateTime,
  normalizeFilters, describeFilters, applyFilters, filterOptions, buildReport,
};
