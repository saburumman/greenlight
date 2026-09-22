// A client for Atlassian's OAuth 2.0 (3LO) "Login with Atlassian" flow.
// This is now BOTH identity (who's signed in) AND the app's only path to
// Jira: each user's own access/refresh token (kept server-side — see
// auth/atlassianTokens.js) is what every Jira API call is made with, so
// every request to Jira happens as that user, under their own Jira
// permissions. There is no shared/global Jira credential anywhere in this
// app anymore.
//
// One Atlassian Developer Console app-registration requirement this code
// can't do for you: the OAuth app behind ATLASSIAN_CLIENT_ID must have the
// "Jira API" product added with at least the scopes below — see README
// "Authentication" for the exact steps. Without that, Atlassian will reject
// the scopes below at the authorize step or the token exchange will come
// back without real Jira access.
//
// Scopes requested are kept to the minimum this app actually calls (see the
// SCOPES comment below) — there's deliberately no separate "identity API"
// scope (`read:me`) here: this app gets a signed-in user's identity
// (accountId, name, email, avatar) from Jira's own /myself endpoint
// instead, using the same read:jira-user scope it already needs for that,
// rather than requesting an extra scope just to hit a different endpoint
// that returns overlapping information.

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

// - read:jira-user  — Jira user info: this app uses it for GET
//                      /rest/api/3/myself (see fetchJiraIdentity below),
//                      which is how it learns the signed-in user's
//                      accountId/name/email/avatar. (accessible-resources,
//                      used to confirm Jira site access and resolve the
//                      cloudId, needs no scope of its own — any valid 3LO
//                      token can call it.)
// - read:jira-work  — read issues/search/comments on the user's behalf
//                      (this app never writes to Jira, so no write scope is
//                      ever requested).
// - offline_access  — required to get a refresh_token back at all; without
//                      it the access token silently stops working after
//                      ~1 hour with no way to renew it short of a full
//                      re-login.
const SCOPES = "read:jira-user read:jira-work offline_access";

class OAuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OAuthError";
    this.status = status || 502;
  }
}

function normalizeSiteUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "").toLowerCase();
}

function getConfig() {
  const clientId = process.env.ATLASSIAN_CLIENT_ID;
  const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET;
  const appBaseUrl = process.env.APP_BASE_URL;
  const jiraSiteUrl = process.env.JIRA_SITE_URL;
  if (!clientId || !clientSecret || !appBaseUrl || !jiraSiteUrl || !process.env.SESSION_SECRET) {
    return null;
  }
  return {
    clientId,
    clientSecret,
    appBaseUrl: appBaseUrl.replace(/\/+$/, ""),
    jiraSiteUrl: normalizeSiteUrl(jiraSiteUrl),
    redirectUri: `${appBaseUrl.replace(/\/+$/, "")}/auth/callback`,
  };
}

function isConfigured() {
  return !!getConfig();
}

function buildAuthorizeUrl(state) {
  const cfg = getConfig();
  if (!cfg) throw new OAuthError("Atlassian login isn't configured on this server.", 500);
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: cfg.clientId,
    scope: SCOPES,
    redirect_uri: cfg.redirectUri,
    state,
    response_type: "code",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const cfg = getConfig();
  if (!cfg) throw new OAuthError("Atlassian login isn't configured on this server.", 500);
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: cfg.redirectUri,
      }),
    });
  } catch (e) {
    throw new OAuthError(`Couldn't reach Atlassian to complete sign-in (${e.message}).`, 502);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch (e) {}
    throw new OAuthError(`Atlassian rejected the sign-in request (${res.status})${detail ? ": " + detail : "."}`, 502);
  }
  return res.json(); // { access_token, refresh_token, expires_in, token_type, scope }
}

// Exchanges a stored refresh_token for a new access_token — used by
// auth/atlassianTokens.js whenever a user's access token has expired.
// Atlassian rotates refresh tokens on every use: the response's
// refresh_token is a NEW one, and the old one stops working, so the caller
// must persist the returned refresh_token, not just the access_token.
async function refreshAccessToken(refreshToken) {
  const cfg = getConfig();
  if (!cfg) throw new OAuthError("Atlassian login isn't configured on this server.", 500);
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: refreshToken,
      }),
    });
  } catch (e) {
    throw new OAuthError(`Couldn't reach Atlassian to refresh the Jira session (${e.message}).`, 502);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json());
    } catch (e) {}
    throw new OAuthError(`Atlassian rejected the token refresh (${res.status})${detail ? ": " + detail : "."}`, res.status === 400 || res.status === 401 ? 401 : 502);
  }
  return res.json(); // { access_token, refresh_token, expires_in, token_type, scope }
}

// Identity (accountId, name, email, avatar) comes from Jira's own "Get
// current user" endpoint rather than Atlassian's separate identity API
// (api.atlassian.com/me) — the latter needs its own `read:me` scope for
// information this app can already get from the read:jira-user scope it
// needs anyway (see the SCOPES comment above). Requires cloudId, since
// every Jira Cloud REST call from a 3LO token goes through
// api.atlassian.com/ex/jira/{cloudId}/... — see getCloudId() below.
async function fetchJiraIdentity(accessToken, cloudId) {
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  } catch (e) {
    throw new OAuthError(`Couldn't fetch your Jira profile (${e.message}).`, 502);
  }
  if (!res.ok) throw new OAuthError(`Couldn't fetch your Jira profile (${res.status}).`, 502);
  const data = await res.json();
  const avatarUrls = data.avatarUrls || {};
  return {
    accountId: data.accountId,
    name: data.displayName || data.emailAddress || "Unknown",
    email: data.emailAddress || "",
    avatarUrl: avatarUrls["48x48"] || avatarUrls["32x32"] || avatarUrls["24x24"] || "",
  };
}

async function fetchAccessibleResources(accessToken) {
  const res = await fetch(ACCESSIBLE_RESOURCES_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new OAuthError(`Couldn't verify Jira access (${res.status}).`, 502);
  return res.json(); // [{ id, url, name, scopes, avatarUrl }, ...]
}

// The accessible-resources entry for this deployment's configured Jira
// site, or null if the token's account doesn't have access to it. `id` on
// that entry is the Jira Cloud "cloudId" — see getCloudId() below for why
// that matters.
async function findConfiguredJiraResource(accessToken) {
  const cfg = getConfig();
  if (!cfg) return null;
  const resources = await fetchAccessibleResources(accessToken);
  const resource = (resources || []).find((r) => normalizeSiteUrl(r.url) === cfg.jiraSiteUrl) || null;
  // The cloudId is the same for every user's token (one fixed JIRA_SITE_URL
  // per deployment) — prime getCloudId()'s cache here too, so a call to it
  // right after login (e.g. this callback fetching Jira identity) doesn't
  // pay for a second, redundant accessible-resources round trip.
  if (resource) cachedCloudId = resource.id;
  return resource;
}

// Confirms the signed-in Atlassian account actually has access to this
// deployment's configured Jira site — this is the "using Jira access" gate,
// not just "has any Atlassian account".
async function hasAccessToConfiguredJiraSite(accessToken) {
  return !!(await findConfiguredJiraResource(accessToken));
}

// Every Jira Cloud REST call made with an OAuth 2.0 (3LO) token has to go
// through https://api.atlassian.com/ex/jira/{cloudId}/... rather than the
// site's own URL directly (that direct form only works for Basic-auth/PAT
// requests, which this app no longer makes) — see jiraClient.js. The
// cloudId for a given site never changes, and every signed-in user's token
// resolves to the exact same one (JIRA_SITE_URL is one fixed site for the
// whole deployment), so this is cached in memory for the life of the
// process rather than re-fetched on every Jira request.
let cachedCloudId = null;
async function getCloudId(accessToken) {
  if (cachedCloudId) return cachedCloudId;
  const resource = await findConfiguredJiraResource(accessToken);
  if (!resource) {
    throw new OAuthError("This Atlassian account doesn't have access to the configured Jira site.", 403);
  }
  cachedCloudId = resource.id;
  return cachedCloudId;
}

// Shared by routes/auth.js (session/state cookies) and
// auth/atlassianTokens.js (clearing the session cookie when a Jira token
// can't be refreshed) — whether cookies on this response should carry the
// `Secure` attribute. True in an actual https:// deployment (APP_BASE_URL
// says so, or the request itself arrived over TLS/behind a TLS-terminating
// proxy); false for plain-http local development, where a `Secure` cookie
// would simply never be sent back by the browser at all.
function isSecure(req) {
  const cfg = getConfig();
  if (cfg && cfg.appBaseUrl.startsWith("https://")) return true;
  return !!(req && (req.secure || req.headers["x-forwarded-proto"] === "https"));
}

module.exports = {
  OAuthError,
  isConfigured,
  getConfig,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  fetchJiraIdentity,
  fetchAccessibleResources,
  findConfiguredJiraResource,
  hasAccessToConfiguredJiraSite,
  getCloudId,
  isSecure,
};
