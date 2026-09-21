// A thin client for Atlassian's OAuth 2.0 (3LO) "Login with Atlassian" flow —
// used only to establish who's using the app and to confirm they actually
// have access to your company's Jira site. It's deliberately narrow: we
// never keep or reuse the user's Jira access token afterward (ticket sync
// still uses its own separately-configured connection in jiraConfig.js) —
// this is identity only, not a general Jira API client for the user.

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ME_URL = "https://api.atlassian.com/me";
const ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

// Minimal scopes: identity (read:me) plus one Jira-scoped permission
// (read:jira-user) so accessible-resources actually lists Jira sites.
const SCOPES = "read:me read:jira-user";

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
  return res.json(); // { access_token, expires_in, token_type, scope }
}

async function fetchIdentity(accessToken) {
  const res = await fetch(ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new OAuthError(`Couldn't fetch your Atlassian profile (${res.status}).`, 502);
  const data = await res.json();
  return {
    accountId: data.account_id,
    name: data.name || data.nickname || data.email || "Unknown",
    email: data.email || "",
    avatarUrl: data.picture || "",
  };
}

async function fetchAccessibleResources(accessToken) {
  const res = await fetch(ACCESSIBLE_RESOURCES_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new OAuthError(`Couldn't verify Jira access (${res.status}).`, 502);
  return res.json(); // [{ id, url, name, scopes, avatarUrl }, ...]
}

// Confirms the signed-in Atlassian account actually has access to this
// deployment's configured Jira site — this is the "using Jira access" gate,
// not just "has any Atlassian account".
async function hasAccessToConfiguredJiraSite(accessToken) {
  const cfg = getConfig();
  if (!cfg) return false;
  const resources = await fetchAccessibleResources(accessToken);
  return (resources || []).some((r) => normalizeSiteUrl(r.url) === cfg.jiraSiteUrl);
}

module.exports = {
  OAuthError,
  isConfigured,
  getConfig,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchIdentity,
  fetchAccessibleResources,
  hasAccessToConfiguredJiraSite,
};
