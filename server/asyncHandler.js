// Express 4 doesn't catch a rejected Promise thrown from an async route
// handler — it just becomes an unhandled rejection. Every route in this app
// now awaits db.js (which may hit Postgres and genuinely reject on a
// connection error), so each async handler is wrapped with this before
// being registered, forwarding any rejection to the centralized error
// middleware in server/index.js exactly the way a synchronous throw always
// has.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
