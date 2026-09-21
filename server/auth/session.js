// Stateless, signed session tokens — no server-side session store needed
// (important for Docker: the container can restart without a database to
// lose). The token is just a signed, base64url JSON payload; the cookie
// carrying it is httpOnly so client-side JS never touches it directly.

const crypto = require("crypto");

const SESSION_COOKIE = "rm_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours — re-login after that, deliberately short since this stands in for real auth

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not set. Generate one (e.g. `openssl rand -hex 32`) and set it in your environment before enabling Atlassian login."
    );
  }
  return secret;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadObj) {
  const secret = getSecret();
  const body = b64url(JSON.stringify(payloadObj));
  const mac = crypto.createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

function verify(token) {
  if (!token || typeof token !== "string" || token.indexOf(".") === -1) return null;
  let secret;
  try {
    secret = getSecret();
  } catch (e) {
    return null;
  }
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expectedMac = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  // Constant-time compare to avoid a timing side-channel on the signature.
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || Date.now() / 1000 > payload.exp) return null;
  return payload;
}

// user: { accountId, name, email, avatarUrl }
function createSessionToken(user) {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    accountId: user.accountId,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl || "",
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  });
}

module.exports = { SESSION_COOKIE, SESSION_TTL_SECONDS, sign, verify, createSessionToken };
