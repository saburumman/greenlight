# REPORTING_SPEC.md — SANAD PMO Reporting Module

> **How to use this file:** commit it to the repo root (alongside `PRD.md` / `SCHEMA.md` if you keep them).
> In Cursor, open agent mode and say: *"Read REPORTING_SPEC.md, including §8 and §9. Implement Phase 0 only. Do not start Phase 1 until I confirm."*
> Build the phases in order. Never let the agent scaffold all phases at once.
>
> **Changes from the first draft (marked ▲):** §8 (new restricted Reporting page + access toggle managed from Know the Team), §9 (how this fits the existing Greenlight codebase), a new **Phase 0**, and the Phase list in §6. Everything else is unchanged.

---

## 0. Context the agent must respect

- **Platform:** SANAD — Jordan's national digital government services platform (MoDEE).
- **Delivery model:** ScrumBan, 10-step flow from backlog prioritization to production deployment.
- **Critical constraint: the Jira project does NOT use story points. All estimation is in HOURS.**
  Every estimate/actual field in this module is hours. Never generate story-point logic, velocity-in-points charts, or burndown-by-points.
- **Teams covered (~50 people):** Product, Business, UI/UX, Backend, Frontend, DevOps, Architect, QA, Tech Support.
- **Frontend splits two ways:** Mobile (Flutter) and Web (Angular). These must be separable dimensions in every report.
- **Backend is largely a proxy layer** over APIs published on the GSB (Government Service Bus). Delivery is therefore gated by external government entities and their vendors — this is the main source of schedule variance and must be visible in the reports, not hidden.
- **Audience:** the PMO (2 people), team leads, and executive stakeholders at MoDEE. Reports must be defensible — every number traceable to a Jira issue key.

---

## 1. Scope of this module

Two headline deliverables, both exportable to Excel:

1. **Full Summary Report** — the complete state of delivery for a selected period/scope.
2. **Variance Report** — estimated hours vs. actual logged hours, sliced by ticket, person, team, epic, and service.

Plus the supporting data the PMO needs to defend both.

▲ The module lives on **its own restricted page ("Reporting")** that only people granted access in **Know the Team** can open — see §8.

---

## 2. Data layer

### 2.1 Source
Jira Cloud REST API v3, read-only, with an API token in env vars (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`). Never hardcode credentials. (▲ See §9.3 — reuse the app's existing Jira configuration if it already provides a server-side credential.)

Required endpoints:

| Need | Endpoint |
|---|---|
| Issues matching a JQL scope | `POST /rest/api/3/search/jql` (paginate with `nextPageToken`) |
| Status transition history (for started/completed/blocked dates) | same call with `expand=changelog`, or `GET /rest/api/3/issue/{key}?expand=changelog` |
| Per-person, per-day logged hours | `GET /rest/api/3/issue/{key}/worklog` |
| Worklogs changed since last sync (incremental) | `GET /rest/api/3/worklog/updated` then `POST /rest/api/3/worklog/list` |
| Sprint membership and dates | `GET /rest/agile/1.0/board/{boardId}/sprint` |
| Field name → field ID map (custom fields) | `GET /rest/api/3/field` |

**Do not call Jira live on page load.** Sync into a local cache (Supabase/Postgres) on a schedule and on a manual "Sync now" button. Record `last_synced_at` and display it on every report header — a PMO report with an unknown data age is worthless.

### 2.2 Cache tables

**`issues`** — one row per Jira issue:

| Field | Notes |
|---|---|
| `issue_key` | PK, e.g. SANAD-1423 |
| `summary` | |
| `issue_type` | Epic, User Story, Task, Sub-task, Bug, Spike |
| `parent_key`, `epic_key`, `epic_name` | for rollups |
| `service` | the SANAD service this belongs to (map from Jira project/component/label — make the mapping configurable, not hardcoded) |
| `component` | Mobile, Web, BE, DevOps, QA, Architecture, UI/UX |
| `squad` / `team` | |
| `labels[]`, `priority`, `fix_version`, `release` | |
| `status`, `status_category` | To Do / In Progress / Done |
| `assignee_id`, `assignee_name`, `reporter_name` | |
| `sprints[]` | an issue can span sprints — keep the array AND a `sprint_count` for spillover analysis |
| `created_at` | **required output field** |
| `started_at` | first transition into any In Progress status (from changelog) |
| `completed_at` | **required output field** — first transition into a Done-category status; if reopened and re-closed, use the LAST one and set `was_reopened = true` |
| `due_date` | |
| `original_estimate_h` | `timeoriginalestimate` ÷ 3600 |
| `remaining_estimate_h` | |
| `logged_h` | `timespent` ÷ 3600 |
| `is_blocked`, `blocked_days` | from flagged field / blocked status time in changelog |
| `external_dependency_id` | FK to the dependency tracker (entity/vendor/GSB blocker) |
| `was_reopened`, `reopen_count` | |

**`worklogs`** — one row per worklog entry. This is what makes per-person variance possible; the issue-level `timespent` total is not enough:
`worklog_id`, `issue_key`, `author_id`, `author_name`, `started_at` (date work was done, not logged), `time_spent_h`, `comment`.

**`status_transitions`** — `issue_key`, `from_status`, `to_status`, `changed_at`, `changed_by`. Powers cycle time, time-in-status, and blocked-days.

**`sync_runs`** — `started_at`, `finished_at`, `issues_synced`, `worklogs_synced`, `status`, `error`. The PMO must be able to prove the data is current.

### 2.3 Derived fields (compute once, store them)

- `variance_h` = `logged_h` − `original_estimate_h` (positive = over estimate)
- `variance_pct` = `variance_h` ÷ `original_estimate_h` × 100 (null-safe: if no estimate, flag as `UNESTIMATED`, never divide by zero and never silently treat as 0)
- `cycle_time_days` = `completed_at` − `started_at`
- `lead_time_days` = `completed_at` − `created_at`
- `age_days` = today − `created_at`, for anything not Done
- `is_overdue` = `due_date` < today AND not Done
- `estimate_accuracy_band`: `On target (±10%)`, `Under 10–25%`, `Under >25%`, `Over 10–25%`, `Over >25%`, `Unestimated`

**Data-quality rule:** tickets with no original estimate, or Done tickets with zero logged hours, must appear in a dedicated **Data Quality** sheet rather than being excluded from totals. Silent exclusion is how PMO reports lose credibility.

---

## 3. Report sections (every one must be an Excel sheet AND an in-app view)

### Sheet 1 — Cover / Report Metadata
Report title, scope (JQL or filter description), period covered, generated-by, generated-at, `last_synced_at`, issue count, SANAD branding placeholder.

### Sheet 2 — Executive Summary
Single-screen KPI block:
- Total tickets in scope, split by status category
- Total estimated hours vs. total logged hours vs. net variance (h and %)
- % of tickets delivered on or under estimate
- Average cycle time and lead time (and median — report both, medians are more honest with outliers)
- Count of tickets blocked by external government entities, and total blocked days
- Count of overdue tickets
- Top 5 variance contributors (by absolute hours)
- Sprint spillover count (tickets appearing in >1 sprint)

### Sheet 3 — Full Ticket Register
Every field in §2.2 + §2.3, one row per ticket, formatted as a native **Excel Table** with filters on. This is the sheet the PMO will pivot from. Column order: identity → classification → ownership → dates → effort → variance → flags.

### Sheet 4 — Variance Report (by ticket)
Issue key, type, component, assignee, epic, service, estimate, logged, variance h, variance %, accuracy band, sprint, created, completed. Sorted by absolute variance descending. Conditional formatting: red over, green under, grey unestimated.

### Sheet 5 — Variance by Team Member
Per person: tickets completed, total estimated, total logged, net variance, variance %, average variance per ticket, estimate accuracy band distribution, total worklog hours in period (from `worklogs`, which may exceed the sum of their completed tickets — show both).
**Framing rule:** this sheet is for estimation calibration, not individual performance ranking. Include that sentence as a note on the sheet. Over-logging is usually an estimation problem or a scope problem, not a person problem.

### Sheet 6 — Variance by Team / Component / Service
Same measures rolled up by squad, by component (Mobile / Web / BE / DevOps / QA), and by SANAD service. Three stacked blocks on one sheet or three sheets — agent's call, but keep them pivot-friendly.

### Sheet 7 — Epic Rollup
Per epic: child count, % complete, estimated vs. logged, variance, earliest created, latest completed, forecast status (`On track` / `At risk` / `Slipped`), linked external dependencies.

### Sheet 8 — Status & Flow Analysis
- Ticket count by status and by status category
- Count by issue type (Epic, User Story, Task, Sub-task, Bug, Spike)
- Count by component, cross-tabbed with status
- Average time-in-status per status (where the work actually sits)
- Aging work-in-progress: open tickets bucketed 0–7 / 8–14 / 15–30 / 30+ days
- Bug-specific block: bugs created vs. resolved in period, open bug count by priority and age

### Sheet 9 — Dependency & Blocker Report
Per external dependency: government entity, vendor, what is needed (API spec / swagger on GSB / test data / sign-off), owner name, promised date, current status, days overdue, last contact date, next follow-up date, and the list of blocked issue keys with their total blocked days. This sheet is what turns "we're late" into "we're late because X owes us Y since Z."

### Sheet 10 — Charts
See §4.

### Sheet 11 — Data Quality
Unestimated tickets, Done tickets with zero logged time, tickets with no assignee, tickets with no epic, tickets with `completed_at` before `started_at`, reopened tickets. Each with issue key and a one-line reason.

---

## 4. Charts and visuals

### In-app
Required charts (▲ library choice: see §9.2 — the existing app has no React, so the default is hand-drawn SVG/HTML charts like the Statistics page; use Recharts only if the Reporting UI is deliberately built as a separate React app):
1. Estimated vs. logged hours — grouped bars by sprint, by team, by component (toggleable dimension)
2. Variance % distribution — histogram across accuracy bands
3. Status distribution — donut by status category + stacked bar by component
4. Issue type breakdown — bar
5. Cumulative created vs. completed over time — line, for flow health
6. Cycle time scatter — each dot one ticket, x = completed date, y = cycle days, colored by type; outliers are the conversation starters
7. Aging WIP — horizontal bars by age bucket
8. Top 10 variance contributors — horizontal bar
9. Dependency ageing — horizontal bars, days overdue per entity

Every chart: title, axis labels with units (`hours`, `days`), and a caption stating the scope and sync time. No chart ships without units.

### In Excel — read this carefully
`exceljs` (the usual Node choice) **cannot create native Excel charts.** Do not let the agent claim otherwise or fake it. The approach:

**Phase 2 (default):** write all data sheets with `exceljs` as native Excel Tables with filters, frozen header rows, correct number formats (hours to 1 decimal, percentages as real percent-formatted numbers not strings, dates as real Excel dates). Pre-build a `PIVOT_SOURCE` sheet — one flat, clean, fully-denormalized table — so the PMO can insert a PivotTable and chart in Excel in two clicks. Additionally render the in-app charts to PNG and embed them on the **Charts** sheet as images, each with a caption.

**Phase 4 (optional upgrade):** if the PMO needs charts that stay live and editable inside Excel, add a small Python export service using **XlsxWriter**, which does support real native Excel charts. Keep it as a separate endpoint; do not rewrite the Node export.

### CSV
Every sheet also downloadable as standalone CSV, UTF-8 **with BOM** — Arabic text in summaries will otherwise render as mojibake when opened in Excel on Windows.

---

## 5. Filters (apply to every report and carry into the export)

Period (date range, by created / completed / worklog date — user picks which), sprint(s), service, squad, component, issue type, assignee, epic, status category, priority, blocked-only toggle, overdue-only toggle, include/exclude sub-tasks.

The active filter set must be printed on the Cover sheet. A report whose scope can't be reconstructed is not auditable.

---

## 6. Build phases

**▲ Phase 0 — Restricted page shell + access control (§8).** The "Reporting" nav item and empty page, the access toggle in Know the Team, server-side enforcement, audit events, tests. No Jira work yet. Ship when every acceptance check in §8.8 passes.

**Phase 1 — Data layer only.** Jira client, pagination, rate-limit handling with backoff, the four cache tables, sync job, sync-status UI. Ship when a manual sync populates real SANAD data and `sync_runs` shows a clean run. No reports yet. (Every route added here is behind the §8 guard.)

**Phase 2 — Core reports + Excel export.** Sheets 1–5 and 11, plus the Excel writer. Ship when the PMO Manager can download a workbook and pivot it.

**Phase 3 — Remaining sheets + in-app charts.** Sheets 6–10, charts, filters, PNG embedding.

**Phase 4 — Optional.** Native Excel charts via XlsxWriter, scheduled email delivery, saved report presets.

---

## 7. Non-negotiables for the agent

1. Hours, never story points.
2. Never silently drop rows from totals — surface them in Data Quality.
3. Every number traceable to an issue key; include the key in every detail row.
4. Real Excel types: dates as dates, percentages as percentages, hours as numbers. No numbers stored as text.
5. UTF-8 with BOM on CSV; Arabic must survive the round trip.
6. Read-only against Jira. No write endpoints to Jira in this module, ever.
7. Timezone: Asia/Amman (UTC+03:00) for all displayed dates. Store UTC, render Amman.
8. Rate limits: respect `Retry-After`, exponential backoff, resumable sync.
9. No new columns or fields not listed in this spec or `SCHEMA.md` without asking. (The access field in §8 is the one deliberate exception.)
10. Seed and test against at least three real SANAD services before declaring a phase done.
11. ▲ Every Reporting API route, export download and sync trigger is protected **on the server**; hiding the menu item is never the control.
12. ▲ No dependency, framework or build step is added without asking (see §9).

---

## 8. ▲ Restricted "Reporting" page with team-managed access

### 8.1 Goal
Reporting is a **new, dedicated page** (route `#/reporting`, sidebar item "Reporting") — it is not part of Statistics and not part of a release. Who may open it is decided per person with an **access toggle on their Know the Team card**. Statistics keeps its own existing toggle; the two pages are independent.

### 8.2 Identity — what the app already has (inspect before coding)
- Atlassian OAuth sign-in is mandatory; every API request has `req.authUser` (`name`, `email`) via `requireAuth`.
- A signed-in user links themselves to their Know the Team card ("This is me" → `PUT /api/team/:id/link-me`, stored as `member.linkedEmail`). `resolveActor(authUser, team)` (`server/assignmentLogic.js`) turns a request into `{id, name}` of the team member.
- Statistics already uses this pattern with `member.statisticsAccess`. Reporting must reuse the same pattern, not invent a second one.

### 8.3 Permission model
- Add one explicit boolean on the existing TeamMember record: **`reportingAccess`** (default OFF; a member with no key = no access). Do not create a second user/permission table and do not duplicate TeamMember.
- Put the page→field mapping in **one** shared server module (e.g. `server/pageAccess.js`):
  `RESTRICTED_PAGES = { statistics: { field: "statisticsAccess", label: "Statistics" }, reporting: { field: "reportingAccess", label: "Reporting" } }`
  with `hasPageAccess(authUser, team, page)` and `canChangePageAccess(actorMember, targetId, team, page, enable)`. No member names, ids or emails hard-coded anywhere.
- Existing members get Reporting access OFF. No data migration is needed (missing key = OFF). Nobody gains access by upgrading.

### 8.4 Access toggle in Know the Team
- Each team card shows an **"Access"** block with one switch per restricted page: `Statistics  [ON/OFF]`, `Reporting  [ON/OFF]`, rendered with the existing `toggleSwitch` / `.switch` styles and the card's visual language (no new design system).
- The current state is always visible (ON/OFF text next to the switch, not colour alone).
- Toggling saves **immediately** through a **dedicated endpoint** `PUT /api/team/:id/access/:page` with body `{ "enabled": true|false }` — not through the generic profile Edit form. The generic `POST`/`PUT /api/team` handlers must **ignore** `statisticsAccess`/`reportingAccess` in their body so a profile edit can never change access. (Today the generic PUT still accepts `statisticsAccess` — fix that as part of this phase and remove the switch from the Edit modal.)
- The switch is **disabled with an explanation tooltip** when the viewer isn't allowed to change it (§8.6). A rejected request reverts the switch and shows the server's message in a toast.
- After a change, the affected person's nav item appears/disappears on their next load or request — no rebuild or redeploy.

### 8.5 Enforcement (server first, UI second)
- Add middleware `requireReportingAccess` (built on `hasPageAccess`). It loads the team from the database **on every request** (no caching of permission), resolves the caller via `resolveActor`, and responds **403 `{error:"You don't have access to Reporting."}`** otherwise. A caller whose sign-in is not linked to a team card has no access.
- Mount it on **every** Reporting route: `/api/reporting/*` — sync trigger, sync status, report data, filters metadata, Excel download, CSV download, PNG/chart endpoints. The report-generation code must never be reachable from a route that skips the guard.
- Statistics: `statisticsAccess` currently only gates the UI. Introduce `requireStatisticsAccess` the same way and move the Statistics audit-derived data behind it (e.g. `GET /api/statistics/activity`), so the structured "who changed whose regression" data (`audit.meta`) is only returned to people with access; plain `/api/audit` returns entries **without `meta`** to everyone else. Do not change how the rest of the app reads releases.
- UI: the sidebar and landing page hide Reporting without access; opening `#/reporting` directly shows a clear "You don't have access" page and makes **no** Reporting API calls; if the server answers 403 (for example access was just revoked) the page switches to the same no-access state.
- Revoking access takes effect on the very next request because nothing is cached.

### 8.6 Who may change access (no self-grant)
The app has no admin role, so use the smallest explicit rule and document it in the README:
1. A person **with** the page's access may grant or revoke it for **other** members.
2. Nobody may **grant** themselves access. (Revoking your own access is allowed.)
3. **Bootstrap:** if **no** member currently has access to that page, any signed-in user linked to a team card may grant it — including to themselves — so the first holder can be created. This is the only exception and must be stated in the README.
4. A signed-in user who is not linked to a card cannot change access.
Enforce this in the endpoint; the UI only mirrors it. Return 403 with a specific message for each denial.

### 8.7 Audit
Every access change writes a server-side audit event (the browser may not post these):
- Actions `REPORTING_ACCESS_GRANTED`, `REPORTING_ACCESS_REVOKED` (and `STATISTICS_ACCESS_GRANTED` / `STATISTICS_ACCESS_REVOKED` for the existing flag) — add them to `VALID_ACTIONS`, to `SERVER_ONLY_ACTIONS`, and to the client's `AUDIT_ACTION_LABELS`.
- `teamMemberId` / `userName` = who made the change (via `resolveActor`); `entityType: "TeamMember"`, `entityId` = the affected member's id; `details` = e.g. `Reporting access granted to Saraa`; `createdAt` = server time. Optionally `meta.targetMemberId`, `meta.page` (add to the allow-list in `auditWriter.cleanMeta`).
- Write an event only when the value actually changes (re-sending the same state is a no-op).
- Reporting **actions** (sync started/finished, export downloaded) should also be audited (`REPORT_SYNC_RUN`, `REPORT_EXPORTED`) with the filter summary in `details`.

### 8.8 Acceptance checks for Phase 0 (write automated tests for each)
1. Toggling Reporting on a card persists and survives a reload; the card shows the state.
2. A member without access gets **403** from every `/api/reporting/*` route and cannot open `#/reporting` (no API calls made).
3. A member with access can open the page normally.
4. Revoking access: the next request is 403 with no restart.
5. Grant and revoke each create an audit entry with actor, target and time; a no-op toggle creates none.
6. Self-grant is rejected (outside bootstrap); bootstrap works only when nobody has access; generic profile edit cannot change either flag.
7. Existing releases, Jira sync, regression assignment, incidents, Test Data, AI assessment, release notes, Statistics and Audit still work (run the existing test scripts and `node --check`).

### 8.9 Security limitations — state these in the README, don't hide them
- **The link is the weak point.** Access follows `member.linkedEmail`, and today `PUT /api/team/:id/link-me` lets any signed-in user link themselves to **any** card — it only clears the link from the card that previously held *their own* email, and it overwrites a link that someone else already holds. That means a signed-in user could link to a privileged person's card and inherit their access. **Phase 0 must fix this**: refuse to link to a card that is already linked to a different email (unlinking is done by the current holder, or by someone with access to that page), and audit link changes.
- There are no admin roles, so "who can manage access" is the rule in §8.6, not a role system.
- Reporting data originates from Jira and is cached in the app's own database; protecting the page does not change who can see the same issues in Jira itself.
- Release data (tickets, regression results) is still served to every signed-in user by the existing release API. Statistics access hides the analytics view and the audit-derived detail, it does not make release data confidential.

---

## 9. ▲ Fit with the existing Greenlight codebase (read before coding)

The agent must inspect these first and report back what it found before writing Phase 0 code.

### 9.1 Stack
Node/Express server (`server/index.js`, routers under `server/routes/`), a plain-JavaScript browser app (`public/app.js`, `public/styles.css`, no framework, no build step), data in a document store (`server/db/jsonStore.js` locally, `server/db/pgStore.js` on Supabase Postgres as JSONB). `exceljs` and `pg` are already dependencies. The UI follows the existing design tokens (`--surface`, `--border`, `--accent`, status tokens, dark mode via `[data-theme]`).

### 9.2 Conflicts with this spec — decide before Phase 3
- **Recharts needs React.** The app has none. Default decision: draw charts as inline SVG/HTML exactly like the existing Statistics page (no new dependency, light/dark aware, tooltips via `data-tip`). If the PMO wants Recharts, build Reporting as a separate React app and ask first — that adds a build pipeline.
- **PNG embedding** of in-app charts needs a headless renderer; pick one deliberately (ask), or render the Excel "Charts" sheet's images server-side from the same chart data.
- **Relational cache tables.** The app stores JSONB documents. The four reporting tables (`issues`, `worklogs`, `status_transitions`, `sync_runs`) should be real Postgres tables added through a new file in `supabase/migrations/`, mirrored in `supabase/schema.sql`. Reporting is **Postgres-only**; in local JSON mode show a clear "needs Supabase" message rather than building a second implementation.

### 9.3 Jira access
Inspect `server/jiraClient.js` and `server/jiraConfig.js` first. The existing Jira integration may be per-user or site-wide; a **scheduled** sync needs a server-side credential. Reuse existing configuration where it exists and add the `JIRA_*` env vars only if it doesn't, documenting them in `render.yaml`/README. Never log tokens; read-only calls only.

### 9.4 Reuse, don't rebuild
- Navigation: `SIDENAV_ITEMS` entry with a `needs` flag like Statistics; add the landing card the same way.
- Routing/render: follow the `statistics` view pattern in `boot()` / `render()`.
- Team toggles: `toggleSwitch`, `.switch`, the team card in `teamMemberCardHtml`.
- Audit: `server/auditWriter.js` (`recordEvents`) and `assignmentLogic.resolveActor`.
- Tests: scratch-style vm/stub tests exist for team routes and client rendering — extend them rather than adding a test framework.

---

## 10. Kickoff prompt for Cursor (paste as-is)

> Read `REPORTING_SPEC.md` fully. Inspect the codebase as described in §9 and reply with a short findings summary (how `requireAuth`/`resolveActor` work, how `statisticsAccess` is stored and enforced today, how `link-me` works, where the sidebar and routes are defined, which Jira configuration exists) **before changing anything**. Then implement **Phase 0 only** (§8): the Reporting nav item and page shell, the `reportingAccess` toggle on Know the Team via `PUT /api/team/:id/access/:page`, `requireReportingAccess` on every `/api/reporting/*` route (use a placeholder `GET /api/reporting/ping` for now), the no-self-grant rule, the `link-me` fix, and the audit events. Add tests for every check in §8.8 and run the existing tests. Do not add dependencies, do not start Phase 1, and tell me every file you changed and any security limitation you found.
