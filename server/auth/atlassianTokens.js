// Per-user Atlassian OAuth token storage — this is the whole point of the
// "no shared Jira credential" architecture: each signed-in Greenlight
// user's own access/refresh token is kept here, server-side (see
// server/db/jsonStore.js / pgStore.js's atlassianTokens collection), keyed
// by their Atlassian accountId. Nothing here is ever sent to the browser —
// server/jiraClient.js is the only other module that reads from this file,
// and it only ever asks for "a valid access token for this accountId",
// never the accountId's raw stored record.
//
// Isolation: a Greenlight session cookie only ever asserts the accountId it
// was signed for (server/auth/session.js — HMAC-signed, unforgeable), and
// every route that touches Jira looks up a token by req.authUser.accountId
// from that verified cookie. There is no code path where one user's
// request can read or use another user's stored token.

const db = require("../db");
const oauth = require("./atlassianOAuth");
const session = require("./session");
const { clearCookie } = require("./cookies");

// Thrown whenever this deployment can't get a usable Jira access token for
// a user — no token on file, or the refresh attempt itself failed (refresh
// token expired, revoked at Atlassian's end, etc.). Per the "if refresh
// fails, invalidate the Greenlight session and require sign-in again"
// requirement, every Jira-touching route treats this specially — see
// respondReauthRequired() below — rather than showing it as a generic Jira
// error.
class ReauthRequiredError extends Error {
  constructor(message) {
    super(message || "Your Jira authorization has expired — sign in with Atlassian again.");
    this.name = "ReauthRequiredError";
    this.status = 401;
  }
}

// A 60-second safety buffer — treat a token as "expired" a little before
// Atlassian actually cuts it off, so a request in flight doesn't lose a
// race with the real expiry.
const EXPIRY_SAFETY_BUFFER_MS = 60 * 1000;

// tokenResponse: whatever Atlassian's token endpoint returned — either the
// initial { access_token, refresh_token, expires_in, scope } from
// exchangeCodeForToken(), or the same shape from refreshAccessToken().
async function saveTokens(accountId, tokenResponse) {
  const now = Date.now();
  const expiresInMs = (Number(tokenResponse.expires_in) || 3600) * 1000;
  const record = {
    accountId,
    accessToken: tokenResponse.access_token,
    // Atlassian always issues a new refresh_token alongside a refreshed
    // access_token (rotation) — but keep the previous one if a response
    // somehow omits it, rather than silently dropping refresh capability.
    refreshToken: tokenResponse.refresh_token || (await getStoredRefreshToken(accountId)),
    expiresAt: new Date(now + expiresInMs - EXPIRY_SAFETY_BUFFER_MS).toISOString(),
    scope: tokenResponse.scope || "",
    updatedAt: new Date(now).toISOString(),
  };
  await db.atlassianTokens.set(accountId, record);
  return record;
}

async function getStoredRefreshToken(accountId) {
  const existing = await db.atlassianTokens.get(accountId);
  return existing ? existing.refreshToken : null;
}

// Returns a usable access token for this accountId, transparently
// refreshing it first if it's expired (or close to it). Throws
// ReauthRequiredError if there's no token on file, or refreshing it fails —
// callers (jiraClient.js) let that propagate to the route, which is
// expected to catch it via respondReauthRequired() below.
async function getAccessToken(accountId) {
  const record = await db.atlassianTokens.get(accountId);
  if (!record || !record.accessToken) {
    throw new ReauthRequiredError("No Jira authorization on file for this account — sign in with Atlassian again.");
  }
  const stillValid = record.expiresAt && new Date(record.expiresAt).getTime() > Date.now();
  if (stillValid) return record.accessToken;

  if (!record.refreshToken) {
    await db.atlassianTokens.delete(accountId);
    throw new ReauthRequiredError("Your Jira authorization expired and can't be refreshed automatically — sign in again.");
  }

  let refreshed;
  try {
    refreshed = await oauth.refreshAccessToken(record.refreshToken);
  } catch (e) {
    // The refresh token itself is no longer good (expired, revoked by the
    // user or an admin at Atlassian, etc.) — there is nothing left to do
    // but ask the user to sign in again, so drop the dead record.
    await db.atlassianTokens.delete(accountId);
    throw new ReauthRequiredError("Your Jira authorization could not be refreshed — sign in again.");
  }
  const saved = await saveTokens(accountId, refreshed);
  return saved.accessToken;
}

async function clearTokens(accountId) {
  await db.atlassianTokens.delete(accountId);
}

// Shared handling for a route that caught a ReauthRequiredError: per spec,
// a failed refresh doesn't just fail that one Jira call — it invalidates
// the whole Greenlight session, so the next thing the user does is sign in
// again (rather than being left in a half-signed-in state where the app
// still shows them as logged in but every Jira action silently 401s).
// Clearing the session cookie here + responding with the same
// {error, loginUrl} shape requireAuth already uses on a bad/missing
// session means the frontend's existing apiCall() 401 handling (see
// app.js) redirects to /auth/login with no extra frontend code needed.
function respondReauthRequired(req, res, err) {
  clearCookie(res, session.SESSION_COOKIE, { secure: oauth.isSecure(req) });
  res.status(401).json({
    error: (err && err.message) || "Your Jira authorization expired — sign in again.",
    loginUrl: "/auth/login",
  });
}

module.exports = { ReauthRequiredError, saveTokens, getAccessToken, clearTokens, respondReauthRequired };
