const session = require("./session");
const { parseCookies } = require("./cookies");

// Gates every /api/* route. There is no guest fallback: index.js refuses to
// even start the server unless Atlassian login is fully configured (see
// atlassianOAuth.js#isConfigured), so by the time this middleware ever runs,
// a valid session is the only way through.
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const payload = session.verify(cookies[session.SESSION_COOKIE]);
  if (!payload) {
    return res.status(401).json({ error: "Sign in with Atlassian to use Greenlight.", loginUrl: "/auth/login" });
  }
  req.authUser = payload; // { accountId, name, email, avatarUrl }
  next();
}

module.exports = { requireAuth };
