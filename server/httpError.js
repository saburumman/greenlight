// An error that carries the HTTP answer to give. Services throw it; the
// central error middleware in index.js (and the test harness) turns it into
// `{ error, code }` with that status instead of a generic 500.
class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.name = "HttpError";
    this.httpStatus = status;
    this.code = code || null;
    this.extra = extra || null;
  }
}

function sendHttpError(res, err) {
  return res.status(err.httpStatus).json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.extra || {}) });
}

// Express error-handling middleware for HttpError (mount before the generic 500).
function httpErrorMiddleware(err, req, res, next) {
  if (err && err.httpStatus) return sendHttpError(res, err);
  next(err);
}

module.exports = { HttpError, sendHttpError, httpErrorMiddleware };
