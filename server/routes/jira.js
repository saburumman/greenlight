const express = require("express");
const jiraConfig = require("../jiraConfig");
const jiraClient = require("../jiraClient");
const { extractIssueKey } = require("../extractKey");

const router = express.Router();

// GET /api/jira/status — never returns the token.
router.get("/status", async (req, res) => {
  res.json(jiraConfig.publicView());
});

// POST /api/jira/connect — save connection details and verify them live.
// Body: { baseUrl, authType: "cloud"|"token", email, apiToken, apiVersion }
router.post("/connect", async (req, res) => {
  const { baseUrl, authType, email, apiToken, apiVersion } = req.body || {};

  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    return res.status(400).json({ error: "Enter a valid Jira base URL, e.g. https://yourcompany.atlassian.net" });
  }
  if (!apiToken) {
    return res.status(400).json({ error: "An API token (or personal access token) is required." });
  }
  if (authType === "cloud" && !email) {
    return res.status(400).json({ error: "Email is required for Jira Cloud API token auth." });
  }

  const candidate = {
    baseUrl: baseUrl.trim(),
    authType: authType === "token" ? "token" : "cloud",
    email: email ? email.trim() : undefined,
    apiToken: apiToken.trim(),
    apiVersion: apiVersion === "2" ? "2" : "3",
  };

  // Save first so testConnection (which reads the saved config) can use it,
  // but roll back if the test fails so we don't keep bad credentials.
  const previous = jiraConfig.load();
  jiraConfig.save(candidate);
  try {
    const result = await jiraClient.testConnection(candidate);
    res.json({ ok: true, displayName: result.displayName, baseUrl: candidate.baseUrl });
  } catch (e) {
    if (previous) jiraConfig.save(previous);
    else jiraConfig.clear();
    res.status(e.status || 502).json({ error: e.message });
  }
});

router.post("/disconnect", (req, res) => {
  jiraConfig.clear();
  res.json({ ok: true });
});

// POST /api/jira/lookup — { url } or { key }. Used by "Add Ticket" to
// auto-fill fields from a pasted Jira URL when Jira is connected.
router.post("/lookup", async (req, res) => {
  const { url, key: rawKey } = req.body || {};
  const key = extractIssueKey(rawKey || url);
  if (!key) {
    return res.status(400).json({ error: "Couldn't find a Jira ticket key in that URL (expected something like MOJ-1234)." });
  }
  try {
    const ticket = await jiraClient.getIssue(key);
    res.json({ ticket });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, key });
  }
});

module.exports = router;
