// Per-user Jira access status + ticket lookup. There is no shared/global
// Jira connection to configure anymore — every signed-in user authorized
// Jira access themselves via "Sign in with Atlassian" (server/routes/auth.js
// + server/auth/atlassianTokens.js), so these routes only ever act as that
// request's own req.authUser.

const express = require("express");
const jiraClient = require("../jiraClient");
const atlassianTokens = require("../auth/atlassianTokens");
const { extractIssueKey } = require("../extractKey");
const { asyncHandler } = require("../asyncHandler");

const router = express.Router();

// GET /api/jira/status — whether THIS signed-in user currently has a
// working Jira authorization (never returns any token).
router.get("/status", asyncHandler(async (req, res) => {
  try {
    // A cheap way to confirm the stored token is present and (if expired)
    // still refreshable, without making an actual Jira API call.
    await atlassianTokens.getAccessToken(req.authUser.accountId);
    res.json({ connected: true });
  } catch (e) {
    if (e instanceof atlassianTokens.ReauthRequiredError) {
      return atlassianTokens.respondReauthRequired(req, res, e);
    }
    res.status(e.status || 502).json({ error: e.message, connected: false });
  }
}));

// POST /api/jira/lookup — { url } or { key }. Used by "Add Ticket" to
// auto-fill fields from a pasted Jira URL, using this user's own Jira
// authorization.
router.post("/lookup", asyncHandler(async (req, res) => {
  const { url, key: rawKey } = req.body || {};
  const key = extractIssueKey(rawKey || url);
  if (!key) {
    return res.status(400).json({ error: "Couldn't find a Jira ticket key in that URL (expected something like MOJ-1234)." });
  }
  try {
    const ticket = await jiraClient.forUser(req.authUser).getIssue(key);
    res.json({ ticket });
  } catch (e) {
    if (e instanceof atlassianTokens.ReauthRequiredError) {
      return atlassianTokens.respondReauthRequired(req, res, e);
    }
    res.status(e.status || 502).json({ error: e.message, key });
  }
}));

module.exports = router;
