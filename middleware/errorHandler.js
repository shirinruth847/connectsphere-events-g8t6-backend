// Last middleware in server.js: turns unhandled failures into safe responses
// and keeps diagnostic detail in the server log only.
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

  console.error("Error:", error);
  return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
};

module.exports = errorHandler;
