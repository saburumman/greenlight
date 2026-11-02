// "Sign in with Atlassian" — login, callback and logout. Login is mandatory:
// index.js refuses to start the server at all unless Atlassian OAuth is
// fully configured (see auth/atlassianOAuth.js#isConfigured), so by the time
// these routes ever run, isConfigured() is always true.

const express = require("express");
const crypto = require("crypto");
const oauth = require("../auth/atlassianOAuth");
const session = require("../auth/session");
const atlassianTokens = require("../auth/atlassianTokens");
const { parseCookies, serializeCookie, appendSetCookie, clearCookie } = require("../auth/cookies");
const { asyncHandler } = require("../asyncHandler");
const rbac = require("../rbacService");

const router = express.Router();
const STATE_COOKIE = "rm_oauth_state";

// GET /auth/me — tells the frontend whether OAuth login is enabled on this
// deployment at all, and if so, whether the current visitor is signed in and
// what they're allowed to do. `access` is resolved on the server from the
// person's Jira accountId (status, role, effective permissions, linked Team
// Member id) — the browser only ever uses it to decide what to DRAW; every
// API route re-checks permissions itself.
router.get("/me", asyncHandler(async (req, res) => {
  const enabled = oauth.isConfigured();
  if (!enabled) return res.json({ oauthEnabled: false, authenticated: false, user: null });
  const cookies = parseCookies(req);
  const payload = session.verify(cookies[session.SESSION_COOKIE]);
  if (!payload) return res.json({ oauthEnabled: true, authenticated: false, user: null });
  const a = await rbac.loadAccess(payload, { login: false });
  res.json({
    oauthEnabled: true,
    authenticated: true,
    user: { accountId: payload.accountId, name: payload.name, email: payload.email, avatarUrl: payload.avatarUrl },
    access: {
      status: a.status,
      userId: a.user.id,
      role: a.role ? { id: a.role.id, name: a.role.name, systemKey: a.role.systemKey || null } : null,
      isSuperAdmin: a.isSuperAdmin,
      permissions: Array.from(a.permissions).sort(),
      teamMemberId: a.user.teamMemberId || null,
    },
  });
}));

router.get("/login", (req, res) => {
  if (!oauth.isConfigured()) {
    return res.status(500).send("Atlassian login isn't configured on this server. Ask your admin to set it up (see README).");
  }
  const state = crypto.randomBytes(16).toString("hex");
  appendSetCookie(
    res,
    serializeCookie(STATE_COOKIE, state, { maxAgeSeconds: 600, secure: oauth.isSecure(req) })
  );
  res.redirect(oauth.buildAuthorizeUrl(state));
});

router.get("/callback", async (req, res) => {
  if (!oauth.isConfigured()) {
    return res.status(500).send("Atlassian login isn't configured on this server.");
  }
  const cookies = parseCookies(req);
  const expectedState = cookies[STATE_COOKIE];
  clearCookie(res, STATE_COOKIE);

  const { code, state, error } = req.query || {};
  if (error) {
    return res.redirect("/?authError=" + encodeURIComponent("Sign-in was cancelled or denied."));
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return res.redirect("/?authError=" + encodeURIComponent("Sign-in couldn't be verified — please try again."));
  }

  try {
    const tokenResult = await oauth.exchangeCodeForToken(code);
    const accessToken = tokenResult.access_token;
    // Confirms this Atlassian account can see the configured Jira site AND
    // gives us its cloudId, before we ask Jira for the account's identity
    // fields (name/email/avatar) — see fetchJiraIdentity's comment for why
    // identity comes from Jira's own /myself endpoint (read:jira-user)
    // rather than a separate identity-API scope.
    const resource = await oauth.findConfiguredJiraResource(accessToken);
    if (!resource) {
      return res.redirect(
        "/?authError=" + encodeURIComponent("Your Atlassian account doesn't have access to this company's Jira — contact your admin.")
      );
    }
    const identity = await oauth.fetchJiraIdentity(accessToken, resource.id);
    // Who is this, in Release Monitor? One user record per Jira accountId:
    // the first sign-in registers them as PENDING (no permissions) and every
    // later one just refreshes their profile and "last login". A deactivated
    // account is turned away here — no session, and no Jira tokens stored.
    const appUser = await rbac.registerOrUpdateOnLogin(identity, { login: true });
    if (appUser.status === "INACTIVE") {
      return res.redirect("/?authError=" + encodeURIComponent("Your account has been deactivated. Contact an administrator."));
    }
    // Persist THIS user's own Jira OAuth tokens, server-side, keyed by their
    // stable Atlassian accountId — this is the only place Greenlight ever
    // gets Jira access, and every Jira API call this user's session makes
    // from here on uses exactly this record (see auth/atlassianTokens.js).
    // The access token itself is never put in the session cookie or sent to
    // the browser.
    await atlassianTokens.saveTokens(identity.accountId, tokenResult);
    const sessionToken = session.createSessionToken(identity);
    appendSetCookie(
      res,
      serializeCookie(session.SESSION_COOKIE, sessionToken, {
        maxAgeSeconds: session.SESSION_TTL_SECONDS,
        secure: oauth.isSecure(req),
      })
    );
    res.redirect("/");
  } catch (e) {
    const msg = e && e.message ? e.message : "Sign-in failed.";
    res.redirect("/?authError=" + encodeURIComponent(msg));
  }
});

router.post("/logout", asyncHandler(async (req, res) => {
  // Clear this user's stored Jira tokens too, not just their Greenlight
  // session — signing out should fully end their Jira access, not just log
  // them out of the app while leaving a usable token on file.
  const cookies = parseCookies(req);
  const payload = session.verify(cookies[session.SESSION_COOKIE]);
  if (payload && payload.accountId) {
    await atlassianTokens.clearTokens(payload.accountId);
  }
  clearCookie(res, session.SESSION_COOKIE, { secure: oauth.isSecure(req) });
  res.json({ ok: true });
}));

module.exports = router;
