require("./loadEnv").loadEnv(); // must run before anything below reads process.env (e.g. PORT)

const express = require("express");
const path = require("path");

const releasesRouter = require("./routes/releases");
const jiraRouter = require("./routes/jira");
const regressionModulesRouter = require("./routes/regressionModules");
const auditRouter = require("./routes/audit");
const testDataRouter = require("./routes/testData");
const teamRouter = require("./routes/team");
const authRouter = require("./routes/auth");
const oauth = require("./auth/atlassianOAuth");
const { requireAuth } = require("./auth/middleware");

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

app.listen(PORT, () => {
  console.log(`\n  Greenlight is running: http://localhost:${PORT}\n`);
});
