// Minimal cookie parsing/serialization — deliberately hand-rolled instead of
// pulling in a dependency (cookie-parser, etc.), matching this project's
// near-zero-dependency style. Just enough for our two cookies (session +
// a short-lived OAuth state token).

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(val);
    } catch (e) {
      out[key] = val;
    }
  });
  return out;
}

// opts: { maxAgeSeconds, secure, httpOnly (default true), sameSite (default "Lax"), path (default "/") }
function serializeCookie(name, value, opts) {
  opts = opts || {};
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || "/"}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite || "Lax"}`);
  if (opts.secure) parts.push("Secure");
  if (typeof opts.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`);
  }
  return parts.join("; ");
}

// Appends a Set-Cookie header without clobbering any already set on this response.
function appendSetCookie(res, cookieString) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", [cookieString]);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", existing.concat(cookieString));
  } else {
    res.setHeader("Set-Cookie", [existing, cookieString]);
  }
}

function clearCookie(res, name, opts) {
  appendSetCookie(res, serializeCookie(name, "", Object.assign({}, opts, { maxAgeSeconds: 0 })));
}

module.exports = { parseCookies, serializeCookie, appendSetCookie, clearCookie };
