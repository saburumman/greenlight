// Postgres cache for the Reporting module (REPORTING_SPEC.md §2.2).
//
// The four cache tables are real relational tables (not the app's JSONB
// documents) because the reports pivot/aggregate over them. Reporting is
// Postgres-only: without DATABASE_URL the Reporting API answers "needs the
// database" (see routes/reporting.js) rather than keeping a second JSON
// implementation. Tables are created idempotently at startup
// (ensureSchema) and are also shipped as supabase/migrations/0003_*.sql.
//
// createReportingStore(pool) takes anything with .query()/.connect() (the
// shared pg Pool in production, a real Postgres in tests).

const SCHEMA_SQL = `
create table if not exists reporting_issues (
  issue_key text primary key,
  summary text not null default '',
  issue_type text not null default 'Task',
  parent_key text, epic_key text, epic_name text,
  service text, component text, squad text,
  labels text[] not null default '{}',
  priority text, fix_version text, release text,
  status text not null default 'Unknown',
  status_category text not null default 'To Do',
  assignee_id text, assignee_name text, reporter_name text,
  sprints jsonb not null default '[]'::jsonb,
  sprint_count integer not null default 0,
  created_at timestamptz, started_at timestamptz, completed_at timestamptz,
  due_date date,
  original_estimate_h numeric(10,2), remaining_estimate_h numeric(10,2),
  logged_h numeric(10,2) not null default 0,
  is_blocked boolean not null default false,
  blocked_days numeric(8,2) not null default 0,
  external_dependency_id text,
  was_reopened boolean not null default false,
  reopen_count integer not null default 0,
  variance_h numeric(10,2), variance_pct numeric(10,2),
  estimate_accuracy_band text not null default 'Unestimated',
  cycle_time_days numeric(8,2), lead_time_days numeric(8,2), age_days numeric(8,2),
  is_overdue boolean not null default false,
  synced_at timestamptz not null default now()
);
create index if not exists idx_reporting_issues_epic on reporting_issues (epic_key);
create index if not exists idx_reporting_issues_assignee on reporting_issues (assignee_id);
create index if not exists idx_reporting_issues_category on reporting_issues (status_category);
create index if not exists idx_reporting_issues_completed on reporting_issues (completed_at);

create table if not exists reporting_worklogs (
  worklog_id text primary key,
  issue_key text not null,
  author_id text, author_name text,
  started_at timestamptz,
  time_spent_h numeric(10,2) not null default 0,
  comment text not null default ''
);
create index if not exists idx_reporting_worklogs_issue on reporting_worklogs (issue_key);
create index if not exists idx_reporting_worklogs_author on reporting_worklogs (author_id, started_at);

create table if not exists reporting_status_transitions (
  id bigserial primary key,
  issue_key text not null,
  from_status text, to_status text,
  changed_at timestamptz not null,
  changed_by text
);
create index if not exists idx_reporting_transitions_issue on reporting_status_transitions (issue_key, changed_at);

create table if not exists reporting_sync_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  issues_synced integer not null default 0,
  worklogs_synced integer not null default 0,
  status text not null default 'running',
  error text
);

create table if not exists reporting_settings (
  id smallint primary key default 1,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint reporting_settings_singleton check (id = 1)
);
`;

const ISSUE_COLS = [
  "issue_key", "summary", "issue_type", "parent_key", "epic_key", "epic_name", "service", "component", "squad",
  "labels", "priority", "fix_version", "release", "status", "status_category", "assignee_id", "assignee_name", "reporter_name",
  "sprints", "sprint_count", "created_at", "started_at", "completed_at", "due_date",
  "original_estimate_h", "remaining_estimate_h", "logged_h", "is_blocked", "blocked_days", "external_dependency_id",
  "was_reopened", "reopen_count", "variance_h", "variance_pct", "estimate_accuracy_band",
  "cycle_time_days", "lead_time_days", "age_days", "is_overdue",
];

function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch) || typeof base !== "object" || typeof patch !== "object" || base === null || patch === null) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
  return out;
}

function createReportingStore(pool, defaults) {
  const DEFAULTS = defaults || require("./reportingLogic").DEFAULT_SETTINGS;
  const q = (text, params) => pool.query(text, params);

  async function ensureSchema() { await q(SCHEMA_SQL); }

  // ---- settings (scope, mappings, auto-sync, plus the sync `state`) ----
  async function getSettings() {
    const { rows } = await q("select data from reporting_settings where id = 1");
    return deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), rows.length ? rows[0].data : {});
  }
  async function putSettings(data) {
    await q(
      `insert into reporting_settings (id, data, updated_at) values (1, $1::jsonb, now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      [JSON.stringify(data)]
    );
  }
  async function saveSettings(patch) { // user-editable parts; keeps `state`
    const cur = await getSettings();
    const next = { ...cur, ...patch, state: cur.state };
    await putSettings(next);
    return next;
  }
  async function saveState(patch) { // sync bookkeeping (lastSyncedAt, resume checkpoint…)
    const cur = await getSettings();
    cur.state = { ...(cur.state || {}), ...patch };
    await putSettings(cur);
    return cur.state;
  }

  // ---- sync runs ----
  async function startRun(startedAtIso) {
    const { rows } = await q("insert into reporting_sync_runs (started_at, status) values ($1, 'running') returning id", [startedAtIso]);
    return String(rows[0].id);
  }
  async function updateRun(id, counts) {
    await q("update reporting_sync_runs set issues_synced = $2, worklogs_synced = $3 where id = $1", [id, counts.issues, counts.worklogs]);
  }
  async function finishRun(id, status, error, counts) {
    await q(
      `update reporting_sync_runs set finished_at = now(), status = $2, error = $3,
         issues_synced = coalesce($4, issues_synced), worklogs_synced = coalesce($5, worklogs_synced) where id = $1`,
      [id, status, error ? String(error).slice(0, 1000) : null, counts ? counts.issues : null, counts ? counts.worklogs : null]
    );
  }
  // A run left 'running' by a crash/restart must not block the next sync.
  async function markStaleRuns(maxAgeMs) {
    await q(
      `update reporting_sync_runs set status = 'failed', finished_at = now(), error = 'Interrupted (server restarted or the sync stopped responding).'
       where status = 'running' and started_at < now() - ($1::bigint * interval '1 millisecond')`,
      [Math.round(maxAgeMs)]
    );
  }
  async function getRunning() {
    const { rows } = await q("select * from reporting_sync_runs where status = 'running' order by id desc limit 1");
    return rows[0] || null;
  }
  async function listRuns(n) {
    const { rows } = await q("select * from reporting_sync_runs order by id desc limit $1", [n || 10]);
    return rows;
  }

  // ---- issues ----
  function multiInsert(table, cols, rows, suffix) {
    if (!rows.length) return null;
    const params = [];
    const values = rows.map((r) => "(" + cols.map((c) => { params.push(r[c]); return "$" + params.length; }).join(",") + ")");
    return { text: `insert into ${table} (${cols.join(",")}) values ${values.join(",")} ${suffix || ""}`, params };
  }

  // items: [{ row, transitions, worklogs }] — one transaction per batch.
  async function saveIssueBatch(items) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const it of items) {
        const r = it.row;
        const vals = ISSUE_COLS.map((c) => (c === "sprints" ? JSON.stringify(r.sprints || []) : r[c]));
        const ph = ISSUE_COLS.map((c, i) => (c === "sprints" ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(",");
        const upd = ISSUE_COLS.filter((c) => c !== "issue_key").map((c) => `${c} = excluded.${c}`).join(", ");
        await client.query(
          `insert into reporting_issues (${ISSUE_COLS.join(",")}, synced_at) values (${ph}, now())
           on conflict (issue_key) do update set ${upd}, synced_at = now()`,
          vals
        );
        await client.query("delete from reporting_status_transitions where issue_key = $1", [r.issue_key]);
        const tr = multiInsert("reporting_status_transitions", ["issue_key", "from_status", "to_status", "changed_at", "changed_by"],
          (it.transitions || []).map((t) => ({ issue_key: r.issue_key, ...t })));
        if (tr) await client.query(tr.text, tr.params);
        await client.query("delete from reporting_worklogs where issue_key = $1", [r.issue_key]);
        const wl = multiInsert("reporting_worklogs", ["worklog_id", "issue_key", "author_id", "author_name", "started_at", "time_spent_h", "comment"],
          it.worklogs || [], "on conflict (worklog_id) do update set issue_key = excluded.issue_key, author_id = excluded.author_id, author_name = excluded.author_name, started_at = excluded.started_at, time_spent_h = excluded.time_spent_h, comment = excluded.comment");
        if (wl) await client.query(wl.text, wl.params);
      }
      await client.query("commit");
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  // After a FULL sync: whatever the scope no longer returns is gone.
  async function deleteIssuesNotIn(keys) {
    const arr = Array.from(keys);
    const del = await q("delete from reporting_issues where not (issue_key = any($1::text[]))", [arr]);
    await q("delete from reporting_worklogs where issue_key not in (select issue_key from reporting_issues)");
    await q("delete from reporting_status_transitions where issue_key not in (select issue_key from reporting_issues)");
    return del.rowCount || 0;
  }

  // Sub-tasks inherit their parent's epic; epic names come from the Epic row.
  async function postProcessEpics() {
    await q(`update reporting_issues c set epic_key = p.epic_key, epic_name = p.epic_name
             from reporting_issues p where c.parent_key = p.issue_key and c.epic_key is null and p.epic_key is not null`);
    await q(`update reporting_issues c set epic_name = e.summary
             from reporting_issues e where c.epic_key = e.issue_key and c.epic_name is distinct from e.summary`);
  }
  async function epicKeysMissingName() {
    const { rows } = await q("select distinct epic_key from reporting_issues where epic_key is not null and epic_name is null");
    return rows.map((r) => r.epic_key);
  }
  async function setEpicNames(map) {
    for (const k of Object.keys(map)) await q("update reporting_issues set epic_name = $2 where epic_key = $1 and epic_name is null", [k, map[k]]);
  }

  async function counts() {
    const { rows } = await q(
      `select (select count(*) from reporting_issues)::int as issues,
              (select count(*) from reporting_worklogs)::int as worklogs,
              (select count(*) from reporting_status_transitions)::int as transitions`
    );
    return rows[0];
  }

  return {
    ensureSchema, getSettings, saveSettings, saveState,
    startRun, updateRun, finishRun, markStaleRuns, getRunning, listRuns,
    saveIssueBatch, deleteIssuesNotIn, postProcessEpics, epicKeysMissingName, setEpicNames, counts,
  };
}

module.exports = { createReportingStore, SCHEMA_SQL, ISSUE_COLS };
