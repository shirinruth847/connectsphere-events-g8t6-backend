// Last middleware in app.js: turns unhandled failures into safe responses
// and keeps diagnostic detail in the server log only.
const LOGGED_MESSAGE_LENGTH = 200;

const errorHandler = (error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body must be valid JSON.", code: "INVALID_JSON" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large.", code: "PAYLOAD_TOO_LARGE" });
  }

  const candidateStatus = error.statusCode || error.status;
  const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500
    ? candidateStatus
    : 500;

  // Supabase returns database failures as plain objects, so name alone is often
  // undefined; the SQLSTATE code and a bounded message identify the failure.
  console.error("[http] request failed", {
    method: req.method,
    path: req.path,
    status,
    name: error.name,
    code: error.code,
    message: String(error.message || "").slice(0, LOGGED_MESSAGE_LENGTH),
  });

  if (status >= 500) {
    return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
  return res.status(status).json({ error: error.publicMessage || "Request could not be completed.", code: "REQUEST_FAILED" });
};

module.exports = errorHandler;
