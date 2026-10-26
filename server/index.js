require("./loadEnv").loadEnv(); // must run before anything below reads process.env (e.g. PORT)

const express = require("express");
const path = require("path");

const releasesRouter = require("./routes/releases");
const jiraRouter = require("./routes/jira");
const regressionModulesRouter = require("./routes/regressionModules");
const auditRouter = require("./routes/audit");
const testDataRouter = require("./routes/testData");
const teamRouter = require("./routes/team");
const statisticsRouter = require("./routes/statistics");
const reportingRouter = require("./routes/reporting");
const dailyReportsRouter = require("./routes/dailyReports");
const authRouter = require("./routes/auth");
const oauth = require("./auth/atlassianOAuth");
const { requireAuth } = require("./auth/middleware");
const pgPool = require("./db/pgPool");
const db = require("./db");
const { migrateAllReleases } = require("./migrateAssignments");
const reportingService = require("./reportingService");
const { recordEvents } = require("./auditWriter");
const dailyReportReminder = require("./dailyReportReminder");
const slack = require("./slack");

// Authentication is mandatory — there is no guest fallback. Refuse to start
// at all unless every Atlassian login variable is set, rather than silently
// coming up in an open/unauthenticated state.
if (!oauth.isConfigured()) {
  console.error(
    "\n  Greenlight requires Atlassian login to be configured — it will not start without it.\n" +
      "  Missing or incomplete .env. All of these must be set:\n" +
      "    APP_BASE_URL, JIRA_SITE_URL, ATLASSIAN_CLIENT_ID, ATLASSIAN_CLIENT_SECRET, SESSION_SECRET\n" +
      "  See README.md → \"Authentication (Sign in with Atlassian)\" for how to get each value.\n"
  );
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
// Render (and most PaaS hosts) health-check the container from outside
// localhost, so the server must listen on every interface, not just
// 127.0.0.1 — binding to "localhost" alone is a common reason a Render
// deploy passes the build but the service never comes up healthy.
const HOST = "0.0.0.0";

app.use(express.json({ limit: "2mb" }));

// Unauthenticated by nature — this is how sign-in itself happens (login,
// callback, logout, and the frontend's own-session check).
app.use("/auth", authRouter);

// Everything else under /api requires a signed-in session.
app.use("/api", requireAuth);
app.use("/api/releases", releasesRouter);
app.use("/api/jira", jiraRouter);
app.use("/api/regression-modules", regressionModulesRouter);
app.use("/api/audit", auditRouter);
app.use("/api/test-data", testDataRouter);
app.use("/api/team", teamRouter);
// Daily QA Report: guarded by pageAccess.requireDailyReportAccess (regression flag).
app.use("/api/daily-reports", dailyReportsRouter);
// Restricted areas: every route inside is guarded by pageAccess.requirePageAccess.
app.use("/api/statistics", statisticsRouter);
app.use("/api/reporting", reportingRouter);

app.use(express.static(path.join(__dirname, "..", "public")));

// Single-page app: any other GET request gets index.html, the client-side
// router (location.hash) takes it from there.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

app.listen(PORT, HOST, () => {
  console.log(`\n  Greenlight is running: http://localhost:${PORT}\n`);
  if (pgPool.isConfigured()) {
    console.log(`  Persistence: Postgres (DATABASE_URL set)`);
    // Non-fatal — a slow-to-wake Supabase instance or a transient network
    // blip shouldn't prevent the process from starting (Render would just
    // restart-loop it); every route already surfaces a real error if the
    // database genuinely can't be reached when a request comes in. This is
    // just an early, visible signal in the logs.
    pgPool
      .query("select 1")
      .then(() => console.log("  Database connection: OK\n"))
      .catch((e) => console.error(`  Database connection check failed (will keep retrying per-request): ${e.message}\n`));
  } else {
    console.log(`  Persistence: local JSON file (data/store.json) — set DATABASE_URL to use Postgres/Supabase instead\n`);
  }
  // Reporting cache (Postgres only): create its tables if missing and start
  // the optional scheduled sync. Non-fatal for the same reason as above.
  if (pgPool.isConfigured()) {
    reportingService.ready().catch((e) => console.error(`  Reporting tables could not be prepared (Reporting will retry on use): ${e.message}\n`));
    reportingService.startScheduler((actor, mode) =>
      recordEvents(db, actor, [{
        action: "REPORT_SYNC_RUN", entityType: "reporting", entityId: "sync",
        details: "Scheduled Reporting sync (" + mode + ") started.", meta: { page: "reporting" },
      }])
    );
  }
  // Daily QA Update reminder (3:45 PM Asia/Amman) — only when Slack is set up.
  if (slack.isConfigured("reminder")) {
    dailyReportReminder.start();
    console.log("  Daily QA reminder: scheduled for 3:45 PM Asia/Amman\n");
  } else {
    console.log("  Daily QA reminder: off (set SLACK_WEBHOOK_URL to post the daily reports and the reminder to Slack)\n");
  }
  // Moves any name-based QA assignments (older releases) onto Know the Team
  // member ids. Idempotent; a no-op once everything is converted.
  migrateAllReleases(db).then((n) => {
    if (n) console.log(`  Assignments: migrated ${n} release${n === 1 ? "" : "s"} to Know the Team member ids\n`);
  });
});
