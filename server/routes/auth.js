// "Sign in with Atlassian" — login, callback and logout. Login is mandatory:
// index.js refuses to start the server at all unless Atlassian OAuth is
// fully configured (see auth/atlassianOAuth.js#isConfigured), so by the time
// these routes ever run, isConfigured() is always true.

const express = require("express");
const crypto = require("crypto");
const oauth = require("../auth/atlassianOAuth");
const session = require("../auth/session");
const { parseCookies, serializeCookie, appendSetCookie, clearCookie } = require("../auth/cookies");

const router = express.Router();
const STATE_COOKIE = "rm_oauth_state";

function isSecure(req) {
  const cfg = oauth.getConfig();
  if (cfg && cfg.appBaseUrl.startsWith("https://")) return true;
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

// GET /auth/me — tells the frontend whether OAuth login is enabled on this
// deployment at all, and if so, whether the current visitor is signed in.
router.get("/me", (req, res) => {
  const enabled = oauth.isConfigured();
  if (!enabled) return res.json({ oauthEnabled: false, authenticated: false, user: null });
  const cookies = parseCookies(req);
  const payload = session.verify(cookies[session.SESSION_COOKIE]);
  if (!payload) return res.json({ oauthEnabled: true, authenticated: false, user: null });
  res.json({
    oauthEnabled: true,
    authenticated: true,
    user: { accountId: payload.accountId, name: payload.name, email: payload.email, avatarUrl: payload.avatarUrl },
  });
});

router.get("/login", (req, res) => {
  if (!oauth.isConfigured()) {
    return res.status(500).send("Atlassian login isn't configured on this server. Ask your admin to set it up (see README).");
  }
  const state = crypto.randomBytes(16).toString("hex");
  appendSetCookie(
    res,
    serializeCookie(STATE_COOKIE, state, { maxAgeSeconds: 600, secure: isSecure(req) })
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
    const [identity, hasAccess] = await Promise.all([
      oauth.fetchIdentity(accessToken),
      oauth.hasAccessToConfiguredJiraSite(accessToken),
    ]);
    if (!hasAccess) {
      return res.redirect(
        "/?authError=" + encodeURIComponent("Your Atlassian account doesn't have access to this company's Jira — contact your admin.")
      );
    }
    const sessionToken = session.createSessionToken(identity);
    appendSetCookie(
      res,
      serializeCookie(session.SESSION_COOKIE, sessionToken, {
        maxAgeSeconds: session.SESSION_TTL_SECONDS,
        secure: isSecure(req),
      })
    );
    res.redirect("/");
  } catch (e) {
    const msg = e && e.message ? e.message : "Sign-in failed.";
    res.redirect("/?authError=" + encodeURIComponent(msg));
  }
});

router.post("/logout", (req, res) => {
  clearCookie(res, session.SESSION_COOKIE, { secure: isSecure(req) });
  res.json({ ok: true });
});

module.exports = router;
