// RETIRED — this module is no longer used anywhere in the app and can be
// deleted (server/jiraConfig.js). It used to store a single shared/global
// Jira connection (base URL, email, API token) that every user's requests
// went through. That model has been replaced entirely: every signed-in
// user now authorizes their own Jira access via "Sign in with Atlassian"
// (OAuth 2.0 3LO), and their own tokens are stored per-user, keyed by their
// Atlassian accountId — see server/auth/atlassianTokens.js and
// server/jiraClient.js (jiraClient.forUser(req.authUser)).
//
// Nothing in the app requires or imports this file anymore. It is left
// here (emptied of its old credential-handling code) only so a leftover
// copy on disk can't be mistaken for something still in use. Safe to
// delete this file — and the retired data/jira-config.json next to
// data/store.json — whenever convenient.
module.exports = {};
