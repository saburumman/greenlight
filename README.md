# Greenlight

A lightweight QA release-readiness dashboard. It runs happily on your own machine with zero setup, or on a shared company server (bare Node, or [Docker](#running-with-docker)) for a whole team — no cloud database required for either. Your release data lives in a local JSON file. Jira access is per-user: everyone signs in with their own Atlassian account (no shared Jira credential exists anywhere in this app), and each person's own Jira OAuth tokens are kept server-side, never sent to any browser — see [Authentication (Sign in with Atlassian)](#authentication-sign-in-with-atlassian). For a shared deployment on a host with no persistent disk (like Render), it can instead persist to Postgres/Supabase — see [Deploying to Render + Supabase](#deploying-to-render--supabase).

## What it does

- A **landing page** (the home screen, at `/`) welcomes you into the workspace with quick-access cards to every section, an at-a-glance summary of real release data, and a short recent-activity feed — see [Home / Landing page](#home--landing-page) below.
- A persistent **left sidebar** (a collapsible drawer on small screens) is how you get around — Release Monitor, Test Data, Audit, and Know the Team — with the current section always highlighted.
- Tracks releases: tickets, regression (by module, against a reusable module list), known bugs, platform status (Web/Android/iOS), release blockers, and optional Performance/Security testing.
- Gives an AI-style **GO / CONDITIONAL GO / NO-GO** recommendation, built from simple rules over exactly what you've entered (it never invents data).
- Tickets can be added manually by pasting a Jira URL, or synced automatically from Jira by Fix Version.
- Generates editable release notes from your Jira tickets and QA data — see **Release notes** below.
- **Publish Release** records that a release shipped, with a timestamped snapshot of the recommendation at the time — shown as a badge on the release both on its own page and in the main list. Publishing never locks the release from further edits.
- Once a release is published, a **Download PDF** button appears — see [Download PDF](#download-pdf) below.
- An instant search bar on the main page finds a release, ticket, bug, blocker, or regression entity/service as you type, and jumps straight to it.
- The main list always shows newest-created releases first, and that order doesn't shuffle as you edit a release afterward.
- An **Audit Log** (sidebar → Audit) records who did what and when — releases created, tickets added/updated, Jira syncs, regression/bug/blocker/platform/performance/security updates, release notes generated or saved, and Test Data added/updated/copied/deleted. See [Identity & the Audit Log](#identity--the-audit-log) for how "who" is determined.
- **Test Data** (sidebar → Test Data) is a reusable QA data library, independent of any release — see [Test Data](#test-data) below.
- **Know the Team** (sidebar → Know the Team) is a purely informational page introducing the people behind the QA work — see [Know the Team](#know-the-team) below.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (check with `node -v`)

## Setup

```bash
cd greenlight-app
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

To use a different port: `PORT=4000 npm start`.

Your data is saved to `data/store.json` as you go — nothing to configure. Stopping and restarting the server keeps everything. (Setting `DATABASE_URL` switches this to Postgres instead — see [Database: local file vs. Postgres](#database-local-file-vs-postgres).)

## Connecting Jira

There is no separate "connect Jira" step, and no shared Jira credential anywhere in this app. Jira access comes from the same **Sign in with Atlassian** everyone already uses to get into Greenlight (see the next section) — the moment you sign in, Greenlight has your own Jira authorization and every ticket lookup or sync you do runs as you, under your own Jira permissions. If your Atlassian account can't see a ticket in Jira, Greenlight can't either.

If a ticket lookup fails for any reason (Jira unreachable, a mistyped URL, or your authorization needing a refresh — see below), **Add Ticket** falls back to letting you fill in the fields by hand rather than blocking you.

**Fix Version matching:** a release's **Version** field (set when you create it, or via "Edit info") is used as the Jira Fix Version to match on — so tickets need that exact text (e.g. `v2.8.0`) set in their **Fix Version/s** field in Jira, not a Label. Click **Re-sync Jira** any time to pull in tickets whose Fix Version matches exactly. Syncing adds new tickets and updates existing ones — and it also removes a ticket that Jira has previously confirmed for this release (synced in, or manually added and later matched by a sync) if this search no longer returns it, most commonly because its Fix Version/s was changed or cleared in Jira. A ticket that's only ever been added manually, and has never itself matched this release's Fix Version, is left alone — sync never touches it either way. You can always remove any ticket by hand regardless.

**Ticket → status bucket mapping:** Jira status names vary a lot between teams, so Greenlight maps them into 4 buckets (Open/To Do, In QA, Blocked, Completed) using Jira's own "done" classification plus simple keyword matching (anything with "block" in the name → Blocked, anything with "qa"/"test"/"review" → In QA). If your team's workflow uses different naming and the buckets look wrong, this is a one-function edit: `server/statusBucket.js`.

## Identity & the Audit Log

Nobody can use the app — view or edit anything — without signing in with an Atlassian account that has access to your configured Jira site (see the next section for setup; the server refuses to even start without it). The Audit Log records your real Atlassian name, and a signed-in session can't spoof another person's identity — the server stamps every audit record from the verified session, ignoring anything the browser sends.

The Audit Log itself (`data/store.json`, or the `audit_log` table on Postgres) is append-only — nobody edits or deletes existing entries from the UI, past entries keep whatever name was active when they were written, and switching identity (signing out and back in as someone else) only changes the name on *future* entries.

## Authentication (Sign in with Atlassian)

Signing in with Atlassian is **required** — Greenlight won't start at all until it's configured (see below). It's also the *only* path to Jira: there is no shared/global Jira connection anywhere in this app. Everyone who uses Greenlight signs in with their own Atlassian account, and from that point on every Jira API call they make — ticket lookups, Fix Version sync, Release Notes generation — goes out as that person, under their own Jira permissions. One person's session can never use another person's Jira access; each signed-in user's authorization is stored and looked up independently, keyed by their Atlassian account (never by email, since Atlassian's own account id is the stable identifier — an email address can change or be reused).

This only works with **Jira Cloud** (`yoursite.atlassian.net`) — Atlassian's "Login with Atlassian" OAuth 2.0 flow isn't available for self-hosted Jira Server/Data Center, so Server/Data Center is no longer supported at all (an earlier version of this app supported it via a shared Personal Access Token; that path is gone along with the shared-credential model it depended on).

### 1. Register an OAuth 2.0 app with Atlassian

1. Go to **[developer.atlassian.com/console/myapps](https://developer.atlassian.com/console/myapps/)** (sign in with an account that's an admin on your Atlassian org, or can create apps) and click **Create** → **OAuth 2.0 integration**.
2. Under **Permissions**, add the **Jira API** product with these two scopes — nothing else:
   - `read:jira-user` — lets Greenlight read the signed-in user's own Jira profile (accountId, name, email, avatar) via Jira's `GET /myself` endpoint. This is also what Greenlight uses for identity — there's no separate "User identity API"/`read:me` scope requested. `read:me` covers information Greenlight can already get from `read:jira-user`, so requesting it too would just be asking for access it doesn't use.
   - `read:jira-work` — lets Greenlight read issues/search on the signed-in user's behalf (ticket lookups, Fix Version sync, Release Notes generation). Greenlight never writes to Jira, so no write scope is ever requested.

   There's nothing to enable for `offline_access` (the scope that gets Greenlight a refresh token) — it isn't a Permissions checkbox, it's just included in the authorization request Greenlight already sends (see `server/auth/atlassianOAuth.js`'s `SCOPES`), and Atlassian issues a refresh token automatically whenever that scope is present. Nothing to configure here for it.

   (Confirming Jira site access and resolving the Jira Cloud id — see `accessible-resources` in `server/auth/atlassianOAuth.js` — needs no scope of its own; any valid 3LO token can call it.)
3. Under **Authorization**, add a callback URL: `https://<wherever-this-app-is-reachable>/auth/callback` — this has to match `APP_BASE_URL` below **exactly**, protocol included.
4. Under **Settings**, copy the **Client ID** and **Client secret**.

### 2. Configure the app

Copy `.env.example` to `.env` in the project root and fill in:

| Variable | Value |
|---|---|
| `ATLASSIAN_CLIENT_ID` | from step 1.4 |
| `ATLASSIAN_CLIENT_SECRET` | from step 1.4 |
| `APP_BASE_URL` | exactly where this app is reachable, e.g. `https://greenlight.yourcompany.com` — must match the callback URL in step 1.3 |
| `JIRA_SITE_URL` | your Jira Cloud site, e.g. `https://yourcompany.atlassian.net` — only Atlassian accounts with access to this site can sign in, and it's the one Jira site every user's Jira API calls are scoped to |
| `SESSION_SECRET` | a random string, e.g. `openssl rand -hex 32` — signs session cookies; changing it signs everyone out |

`.env` is read automatically whether you run this with Docker or with a bare `npm start`/`npm run dev` (those two are the same command — see `package.json`; it doesn't matter which you type). All five variables must be set — if even one is missing or misspelled, the app refuses to start and tells you exactly which ones are missing, rather than silently coming up unauthenticated. If it won't start: double-check all five keys are spelled exactly as above with no typos, that `.env` is in the project root (next to `package.json`, not inside `server/`), and restart the app after any change to it — it's only read once, at startup.

### How it works, and how tokens are handled

1. You click **Sign in with Atlassian**, which sends you to `/auth/login`. It generates a random `state` value, stores it in a short-lived cookie, and redirects you to Atlassian's own authorization page — carrying that `state` along.
2. You authenticate with your own Atlassian account (Greenlight never sees your Atlassian password) and approve access.
3. Atlassian redirects back to `/auth/callback` with an authorization code and the same `state` value. Greenlight rejects the callback outright if `state` is missing or doesn't match the cookie it set in step 1 — this is what stops a CSRF attack from forging a sign-in.
4. Greenlight exchanges the code for an access token and a refresh token (server-to-server, never visible to your browser), confirms your account actually has access to the configured `JIRA_SITE_URL` (and gets that site's Jira Cloud id from the same check), then asks Jira itself — as you — who you are (`accountId`, name, email, avatar) via `GET /myself`, using the `read:jira-user` scope it already has rather than a separate identity-API scope.
5. Your access and refresh tokens are saved **server-side only**, keyed by your Atlassian `accountId` (see `server/auth/atlassianTokens.js`) — never in a cookie, never in the page, never reachable from the browser's JavaScript. What your browser gets is an `HttpOnly` Greenlight session cookie (`Secure` whenever the app is served over HTTPS, and never readable by client-side JS) that only asserts who you are — it carries no Jira credential at all.
6. From then on, every Jira API call your session makes looks up your stored access token, using it directly if it's still valid. If it's expired, Greenlight transparently uses your refresh token to get a new one, saves it, and continues the request — you never see this happen. If the refresh itself fails (your authorization was revoked, or the refresh token itself expired), Greenlight ends your Greenlight session right there and sends you back to sign in again, rather than leaving you in a half-signed-in state where the app still shows you as logged in but Jira actions silently fail.

Sessions last 12 hours, after which you're asked to sign in again (independent of Jira token refresh, which can keep your Jira access alive for longer without a full re-login, as long as the session itself hasn't expired).

## Regression modules

Regression is module-based, not test-case-based, and organized as **Entity → Services** (e.g. "CSPD" containing "Passport services", "Digital Certificates"...) — matching how a real service catalog is usually grouped. You maintain one reusable Entity/Service list, and every release just needs its service statuses set — no re-adding entities or services release after release.

- Click **⚙ Manage Modules** in a release's Regression section to add, rename, reorder, or delete entities and their services in the shared master list. It ships with a starter catalog (CSPD, DVLD, MOE, MOJ, GAM, DLS, JAF, MODEE, PSD, SSC, MOLA, GID, CRIF, CCD, MOHE, Jordan Post, EMRC, each with its services) — edit it freely to match your organization.
- Every **new** release takes its own snapshot of the master list at creation time, with every service starting as **NOT TESTED**. Each service row shows its status as inline buttons — **PASS / WARNING / FAIL / NOT TESTED / SKIP** — clicking one saves that service's status immediately, no popup needed.
- **SKIP** is for a service that genuinely doesn't apply to this release. Skipped services are left out of the overall regression status and out of the AI assessment's regression risk checks entirely (if every tracked service on a release ends up skipped, the assessment notes that transparently rather than reading it as untested or as a pass).
- Click the note icon on a service row to add or edit that service's notes in a small popup — separate from status, so a click to change status never requires typing anything.
- Each **entity** can be assigned an **Owner** — click the "Assign owner" button next to its name and type in whoever's covering it. This is free text (not tied to Know the Team), and it's set per release, not on the shared master list — the same entity can have a different owner from one release to the next, and clearing it is just saving the field blank.
- Use the **Group by** control in the Regression section to switch the list between **Entity** (the default order) and **Owner** — grouping every entity under whoever it's assigned to, alphabetically, with any entities that don't have an owner yet collected under one **Unassigned** group at the end. Each entity still shows (and lets you edit) its own owner within either view; this only changes how they're arranged on the page.
- Editing the master list later — adding, renaming, or deleting an entity or a service — only affects releases created **after** that change. Releases that already exist keep exactly the entity/service list (and statuses) they had, so historical release reports never shift under you.
- Added or deleted an entity or service on the master list and want an **existing** release to catch up? Click **🔄 Sync Modules** in that release's Regression section. It adds what's missing (a new entity, or a new service under one you already track — never touching the status, notes, or owner you've already set on anything that stays) **and** removes any entity or service this release is still tracking that's since been deleted from the master list, taking its recorded status/notes/owner with it. The toast after syncing spells out exactly what was added and removed. A release's older, pre-Entities/Services flat regression rows (from before this feature existed) were never tied to the master list and are left alone either way.
- Some releases don't need regression at all. Flip **Skip regression** in the Regression section header to exclude the whole section from that release's AI assessment (a small "marked as not required" note still appears in the assessment for transparency) — this is different from marking individual services as SKIP, which excludes just those services while the rest of regression is still tracked. Leave it off and the assessment will call out regression explicitly if it hasn't been started yet, or if services are still NOT TESTED, FAIL, or WARNING — it never quietly assumes a release is ready just because tickets and everything else look fine.

## Release notes

Click **Generate Release Notes** in a release's Release Notes section and it drafts notes from what's already tracked on the release — the template and its sections are unchanged:

- **What's New** — your manually-typed highlights, plus any ticket Greenlight determined is a new feature.
- **Improvements & Changes** — tickets read as improvements or general changes.
- **Tickets in This Release** — every tracked ticket, grouped by status bucket.
- **Bug Fixes** — resolved entries from Known Bugs, plus tickets read as bug fixes.
- **Known Issues** — open/deferred entries from Known Bugs, plus any platform or regression result flagged FAIL/WARNING. This is never auto-populated from "any open Jira ticket" — only the app's own known-issue tracking (Known Bugs, platform status, regression results) ever lands here. If none of that applies, the section stays empty rather than guessing.
- **Regression** — the current pass/fail/warning/skip counts.
- **Platform Status** — Web/Android/iOS status and notes.
- **Performance / Security** — only included when you've enabled either for the release.
- **Release Blockers** — anything still open or in progress.
- **QA Status** — the current GO / CONDITIONAL GO / NO-GO recommendation and its summary.

### How each item is generated

**Generate Release Notes** re-fetches the latest Jira issues for the release's Fix Version (the same lookup as **🔄 Re-sync Jira** — it also adds/updates `Tickets in This Release` as a side effect), then for every issue:

1. Decides its section — New Feature, Improvement, Bug Fix, or Other — from the same rule-based logic this app has always used (issue type first, then the ticket's own wording as a fallback). **This step never involves AI**, so a ticket's section can't drift based on model output.
2. Writes the item's short title/description. With `GEMINI_API_KEY` set (see `.env.example`), Google Gemini writes this part — summarizing (never copying) the ticket's description/recent comments in plain business language, never inventing functionality or impact that isn't in the ticket data it was given. Without an API key, it falls back to the same local rule-based summarizer this app always used — extracting a sentence already in the ticket, or a short neutral line if there isn't enough to work with.

Every factual field on an item — issue key, type, status, priority, and the Jira link — always comes straight from Jira, never from AI, and every response Gemini returns is checked before use: any issue key it didn't actually send back gets dropped, and any ticket whose AI content is missing or malformed falls back to the rule-based summary for just that one ticket rather than failing the whole batch. If the AI call fails outright (bad key, network error, unparseable response), every item falls back to the rule-based summary and you'll see a toast saying so — it never shows made-up content silently.

A ticket that's on the release but genuinely isn't in Jira (added by hand, or a Jira lookup that failed) is never sent to or validated against AI — there'd be nothing real to check it against — and keeps the same rule-based summary it always got.

### Regenerating, and manual edits

Generating never overwrites notes you've already edited by hand without asking first ("Regenerate release notes? Your current edits will be replaced."), and a Jira re-sync never rewrites existing notes on its own — new tickets are only picked up the next time you explicitly click Generate/Regenerate. Once you're happy with a draft, edit it freely and click **Save Release Notes**; you can keep editing and re-saving after that.

Behind the editable notes, each generated item is tracked with where it came from — `AI_GENERATED` (from this generation step, whether Gemini or the rule-based fallback wrote it), `MANUALLY_ADDED` (a ticket that was never in the Jira data this ran against), or `MANUALLY_EDITED` (marked once you've hand-edited and saved the notes, so a later Regenerate's confirmation prompt is warning you about real edits, not a stale flag) — along with a reference back to its source Jira issue. This is bookkeeping behind the single notes editor, not a new UI — the editor itself is unchanged.

## Mobile Release Note

A separate section below Release Notes, for the short "What's New" text app store submissions require — one bullet per line, in English (**en-US**) and Arabic (**ar**). It's deliberately independent from the detailed Release Notes above: short, plain, customer-facing bullets rather than the categorized internal write-up.

- **Draft from tickets** pre-fills the English box from this release's tickets (reusing already-generated Release Notes items when there are any, otherwise the same rule-based summaries Release Notes falls back to). With `GEMINI_API_KEY` set, Gemini writes each bullet in short, plain, store-listing style; without it (or if the AI call fails), each bullet falls back to a simple `New: <title>.` / `Improved: <title>.` / `Fixed: <title>.` line built from the ticket's own title — never invented content either way.
- **Translate from English** sends whatever's currently in the English box (edited or not) for an Arabic translation. With `GEMINI_API_KEY` set, Gemini writes it (more natural phrasing — the same model used everywhere else in this app). Without a key, or if the Gemini call fails, it automatically falls back to [MyMemory](https://mymemory.translated.net), a free translation API that needs no account or key at all — so this button always produces a starting draft either way. A toast tells you which one actually wrote it; the free fallback is rougher and deserves a closer read before you save, more so than the AI path.
- Both boxes are always freely editable, whether they were drafted or typed from scratch — nothing here is ever auto-saved; click **Save** when you're happy with them.
- **Copy formatted block** copies both languages to your clipboard in the exact tagged format store submission tooling expects:

  ```
  <en-US>
  • Improved payment status guidance.
  • Vehicles sorted by license expiry.
  </en-US>
  <ar>
  • تحسين عرض حالة الدفع في الطلبات.
  • ترتيب المركبات حسب تاريخ انتهاء الرخصة.
  </ar>
  ```

  Each non-empty line is bullet-prefixed automatically if you haven't already typed one — you don't need to type `•` yourself.

## Download PDF

Once a release has been published, a **Download PDF** button appears next to Edit info / Duplicate on its detail page. It opens your browser's native print dialog — choose "Save as PDF" as the destination to get a file, or print it directly. There's no server-side PDF generation and no new dependency.

This isn't a screenshot of the release page — it's a separate, purpose-built report, generated fresh from the release's data right before the print dialog opens:

- **Summary** — the AI GO / CONDITIONAL GO / NO-GO recommendation and its risk factors, the same read you'd get from the top of the release page.
- **Statistics** — ticket counts (total, completed, in QA, blocked, open/to-do), regression counts (passed, warning, failed, not tested, skipped), and bug counts by severity.
- **Tickets** — every ticket in the release as a table: key, title, status, type, priority.
- **Release Notes** — whatever's currently saved in the release's Release Notes section.

The browser's Save-as-PDF dialog also suggests the file's name for you, from the release's own name and version (e.g. "Checkout Revamp v2.4.1"), so you don't have to rename it after saving.

## Test Data

**Test Data** is a reusable QA data library — click **🗂 Test Data** (top-right of every page). It is deliberately *not* a test-management system: no test cases, no executions, no relationship to releases. It's a flat, searchable list of records you build up once and reuse across any release, instead of re-typing the same National IDs every time you need "a divorced female head of family" or "an account with Electronic Payment enabled."

- Each record has a required **National ID** (stored as text, so leading zeros are kept), at least one required **Supported Scenario** (e.g. "Female Head of Family", "Divorced", "Electronic Payment" — type your own or pick from suggestions), and at least one required **Entity** (e.g. "Family Book", "Payments" — a record can belong to more than one entity; used to group and filter records). **Tags** and **Notes** are optional and freeform.
- **Search** matches across National ID, Supported Scenarios, Entities, Tags, and Notes as you type; the **Entities** and **Tags** filters narrow the list further (matching a record that has the typed text in *any* of its entities/tags), and search + filters combine.
- Each record's **⋮** menu has **View**, **Edit**, **Copy**, and **Delete**. **Copy** opens a pre-filled form for a new record (National ID left blank, since reusing the same one would immediately collide) — nothing is saved until you edit it and click Save. **Delete** always asks for confirmation first.
- Saving a National ID that's already in use doesn't silently create a duplicate — you're warned, with a link to open the existing record instead.
- Test Data is stored independently of releases (same `data/store.json`, its own top-level collection) and survives refreshes, browser restarts, and signing in as someone else. Create/update/copy/delete actions are recorded in the Audit Log the same way every other action in this app is.
- The list is paginated 25 records per page, with **Showing X–Y of Z** and **Prev/Next** controls below the table. Searching or changing the Entities/Tags filter always jumps back to page 1.

### Exporting to Excel

Click **⬇ Export** (next to Import) to download the list as an `.xlsx` file, generated server-side with `exceljs`. It exports whatever's currently on screen — if search or the Entities/Tags filters are active, only the matching records are included (across all pages, not just the one you're looking at); with no search or filters, it's the whole table. The file name reflects that: `test-data-<date>.xlsx` for the full list, `test-data-filtered-<date>.xlsx` when a search/filter was applied. Columns: National ID, Supported Scenarios, Entities, Tags, Notes, Created By, Created At.

### Importing from a spreadsheet

Click **⬆ Import** (next to Add Test Data) and pick a **CSV** file — export an Excel or Google Sheets file as CSV first if that's where your list lives (File → Download/Export → CSV). The app reads three columns positionally, header row optional: **A** = National ID, **B** = Feature (goes into Supported Scenarios), **C** = Notes; anything past column C is ignored.

- If the same National ID appears on more than one row, they're merged into a single record — their Feature values become that record's list of Supported Scenarios (deduplicated), and their Notes are combined.
- A National ID already in your Test Data table is left out of the import entirely — re-uploading the same sheet later only ever offers you what's still new.
- Every new record shows up in a review table, with **Scenario**, **Notes**, and **Entity** all editable right there before it's saved — fix up whatever the sheet got wrong, or add to it, without leaving the dialog. The sheet has no column for **Entity** at all, and it's required, so that one starts blank on every row: type one per row (comma-separate for more than one), or type an Entity once at the top and click **Apply to empty rows** to fill every row that doesn't have one yet. A row's status flips to **Ready** as soon as it has both a Scenario and an Entity.
- You don't have to finish the whole sheet in one sitting — **Import N ready rows** only commits the rows that are complete; whatever's left stays in the table so you can keep going, or close the dialog and pick it up later (re-uploading the same file will skip everything you've already imported).

Import support is CSV-only for now — not raw `.xlsx` — since parsing real Excel binaries needs a third-party library, and the option on npm currently carries an unpatched high-severity vulnerability. CSV covers the same data with no new dependency.

## Home / Landing page

The root URL (`/`) is now a landing page instead of the releases list (which moved to its own explicit `/#/releases` route — every existing "back to releases" link and the sidebar's **Release Monitor** item still take you there). It's intentionally lightweight — an orientation and jumping-off point, not another full dashboard:

- A short welcome section, four quick-access cards straight to Release Monitor, Test Data, Audit, and Know the Team.
- **At a Glance** — Active Releases, Open Blockers, Releases with GO, and Releases with NO-GO, computed live from your existing release data (the same `computeAssessment()` engine used everywhere else) — never invented or hardcoded numbers.
- **Recent Releases** — the 5 most recently updated releases with their current status, linking straight to each release's page, plus a "View all releases" link.
- **Recent Activity** — the 5 most recent Audit Log entries, shown only when the Audit Log already has data. Viewing the landing page itself never writes a new audit entry.

## Know the Team

**Know the Team** (sidebar) introduces the people behind the QA work — name, role, a short bio, QA specialties, tools, and an optional LinkedIn/GitHub link. It is purely informational: no login roles, no permissions, and no connection to guest sessions or accounts. Team members live in one small array at the top of the "KNOW THE TEAM" section in `public/app.js` (`TEAM_MEMBERS`) — edit that array to add, update, or remove a person; a `placeholder: true` entry is shown with a "Placeholder" badge until it's replaced with a real profile.

## Running with Docker

```bash
cd greenlight-app
cp .env.example .env
# edit .env — fill in the 5 Atlassian variables above (required — the
# container won't start without them) plus GEMINI_API_KEY if you want
# AI-assisted release notes
docker compose up -d --build
```

That's it — `docker compose up` builds the image, starts the container, and creates a named volume (`greenlight-data`) for the `data/` folder so releases, regression modules, the audit log, and the Jira connection all survive rebuilds and restarts.

Useful commands:

```bash
docker compose logs -f          # follow the app's logs
docker compose down             # stop and remove the container (data volume is kept)
docker compose down -v          # stop AND delete the data volume — this deletes your data
docker compose up -d --build    # rebuild after pulling code changes
```

The container serves plain HTTP on the port you set (`3000` by default) — put it behind your company's usual reverse proxy or load balancer (nginx, Traefik, an internal ALB, etc.) for HTTPS and a real domain name. That's also almost always what `APP_BASE_URL` above should point at — the public HTTPS URL, not the container's internal port.

Prefer to build/run without Compose? The `Dockerfile` alone works too:

```bash
docker build -t greenlight .
docker run -d -p 3000:3000 --env-file .env -v greenlight-data:/app/data greenlight
```

## Project layout

```
greenlight-app/
  server/
    index.js          — Express app entry point
    loadEnv.js          — reads .env into process.env for local `npm start` (Docker reads it directly)
    db.js              — persistence backend selector — see "Database: local file vs. Postgres" below
    db/
      jsonStore.js         — the original JSON-file backend (data/store.json) — used whenever DATABASE_URL isn't set
      pgStore.js            — the Postgres/Supabase backend — used whenever DATABASE_URL is set
      pgPool.js               — the shared `pg` connection pool pgStore.js uses
    asyncHandler.js       — wraps async route handlers so a rejected Promise (e.g. a DB error) reaches the error middleware instead of hanging
    jiraClient.js        — the 2 Jira REST calls this app makes (read-only), scoped per-user via jiraClient.forUser(req.authUser)
    statusBucket.js       — Jira status → bucket mapping (edit this to match your workflow)
    releaseNotesLogic.js   — Release Notes categorization + rule-based summarizer (server-side twin of the same logic in app.js)
    aiService.js             — thin Google Gemini API client used only for Release Notes item text (see "Release notes" above)
    auth/
      atlassianOAuth.js    — "Sign in with Atlassian" OAuth client — identity AND the only path to Jira access (token refresh, cloudId lookup)
      atlassianTokens.js     — per-user Jira OAuth token storage/refresh, keyed by Atlassian accountId (never email) — see db.atlassianTokens below
      session.js            — signed session-cookie tokens (no server-side session store)
      cookies.js              — small hand-rolled cookie helpers
      middleware.js            — gates /api/* on a valid session, only when configured
    routes/
      releases.js         — release CRUD + ticket endpoints
      jira.js               — per-user Jira status/lookup endpoints
      regressionModules.js  — the reusable Regression Module master list
      audit.js                — audit log read/append endpoints
      testData.js               — the reusable Test Data library CRUD endpoints
      auth.js                  — /auth/login, /auth/callback, /auth/logout, /auth/me
  public/
    index.html, styles.css, app.js  — the dashboard itself (no build step, no framework)
  data/                    — created automatically when running on the JSON-file backend; your releases, audit log, and every signed-in user's own Jira OAuth tokens live here
  supabase/
    schema.sql              — the Postgres table definitions (run once against a new database — see "Deploying to Render + Supabase" below)
  scripts/
    migrate-json-to-supabase.js  — one-time (safely re-runnable) import of an existing data/store.json into Postgres
    seed-defaults.js               — seeds the starter regression modules / starter team into Postgres, only if those tables are still empty
  render.yaml               — optional Render Blueprint (build/start commands + the env var list) — see "Deploying to Render + Supabase"
  Dockerfile, docker-compose.yml, .dockerignore, .env.example  — see "Running with Docker" above
```

No build step, no bundler. Editing any file under `public/` takes effect on the next page reload; editing anything under `server/` needs a restart (`Ctrl+C`, then `npm start` again).

## Database: local file vs. Postgres

Greenlight has two interchangeable persistence backends, selected by one environment variable — nothing else about the app changes, and every route works identically either way:

- **No `DATABASE_URL` set** (the default): data lives in `data/store.json`, exactly as it always has — zero setup, nothing to run first. This is what local development and any existing non-Supabase deployment keep using.
- **`DATABASE_URL` set**: data lives in Postgres (Supabase or any standard Postgres). This is what Render deployments should use — Render's filesystem doesn't survive a deploy or restart, so the JSON-file backend would silently lose everything on the next deploy.

See "Deploying to Render + Supabase" below for the one-time setup (schema + migrating any existing data).

## Backing up or moving your data

**JSON-file backend:** everything is in the `data/` folder. Running without Docker: copy it to move your releases to another machine (or back it up with your usual file backup). Running with Docker: that folder lives in the `greenlight-data` named volume — back it up with `docker run --rm -v greenlight-data:/data -v "$PWD":/backup alpine tar czf /backup/greenlight-backup.tar.gz -C /data .`, and restore it the same way in reverse.

**Postgres/Supabase backend:** your data is in Supabase, so it's covered by Supabase's own backups (Project Settings → Database → Backups on paid plans) — or take a manual one any time with `pg_dump "$DATABASE_URL" > backup.sql`, restorable with `psql "$DATABASE_URL" < backup.sql`.

## Deploying to Render + Supabase

This is the path to a real shared deployment on Render, backed by Supabase Postgres instead of a local file (Render's disk doesn't persist across deploys, so the JSON-file backend isn't an option there — see "Database: local file vs. Postgres" above).

### 1. Create the Supabase project and schema

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL Editor and run the contents of `supabase/schema.sql` (or `psql "$DATABASE_URL" -f supabase/schema.sql` from your machine) — this only creates tables/indexes, it never touches data, and it's safe to re-run.
3. Grab your connection string: Project Settings → Database → Connection string. Use the **Transaction pooler** connection (port 6543) — it's the one meant for a server like this that opens a normal connection pool, rather than the direct connection (port 5432), which Supabase reserves a limited number of.

### 2. Bring in any existing data

If you already have a `data/store.json` from running Greenlight locally or elsewhere, migrate it in **before** pointing production at this database:

```bash
DATABASE_URL="<your Supabase connection string>" npm run db:migrate
```

This reads your local `data/store.json` and upserts everything into Supabase — it's safe to run more than once (re-running never duplicates rows or overwrites audit log entries), and it never modifies or deletes your local `data/store.json`, so keep that around as a backup until you've verified the migrated data in the app. It does not (and doesn't need to) migrate any Jira token — there is no shared Jira credential to carry over, and every user's own Jira access is re-established automatically, with zero setup, the next time they sign in with Atlassian.

Starting fresh instead, with no existing data to bring in? Seed the same starter Regression Module list and starter team Greenlight would normally create automatically:

```bash
DATABASE_URL="<your Supabase connection string>" npm run db:seed-defaults
```

Both scripts only ever insert into empty tables/rows — neither one runs automatically when the server starts, specifically so a Render restart or redeploy can never reset or overwrite real production data.

### 3. Push to GitHub, then create the Render service

The project is already set up for this — `package.json`'s `start` script (`node server/index.js`) is the correct start command, and there's no build step beyond installing dependencies.

- **New +** → **Web Service**, connect this GitHub repo.
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- Render sets `PORT` itself — don't set it yourself, and don't hard-code a port anywhere (the app already reads `process.env.PORT` and listens on `0.0.0.0`, which is what Render's health checks need).

Or use the included `render.yaml` Blueprint (**New +** → **Blueprint**) to get the service, build/start commands, and the full env var list pre-filled from this repo.

### 4. Set environment variables on Render

In the service's **Environment** tab:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Your Supabase connection string from step 1. |
| `APP_BASE_URL` | Yes | Your Render service's URL, e.g. `https://greenlight.onrender.com` — must match **exactly**, since it's also used to build the OAuth callback URL. You'll only know this after the first deploy assigns it; set it once you do, and redeploy. |
| `JIRA_SITE_URL` | Yes | Your Jira Cloud site — see "Authentication" above. |
| `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET` | Yes | From your Atlassian OAuth app — and update its callback URL registration to match the `APP_BASE_URL` above. |
| `SESSION_SECRET` | Yes | Generate with `openssl rand -hex 32` (or let Render generate it — `render.yaml` does this for you). |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | No | Optional AI-assisted Release Notes — see "Release notes" above. |

`DATABASE_SSL` doesn't need to be set on Render — the app connects to Supabase over TLS by default.

### 5. Deploy, then verify

After the first successful deploy, check the Render logs for:

```
Persistence: Postgres (DATABASE_URL set)
Database connection: OK
```

Sign in with Atlassian and confirm your migrated releases/test data/team/regression modules are all there. Jira access itself needs no migration or reconnection step — it's tied to your Atlassian sign-in, so it's already working the moment you're signed in.
