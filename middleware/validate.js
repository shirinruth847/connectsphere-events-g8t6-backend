// Allowlists and validates a JSON body against field rules, then replaces
// req.body with only the accepted, normalised fields.
const validateBody = (rules) => (req, res, next) => {
  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Request body must be a JSON object.", code: "VALIDATION_FAILED" });
  }

  const unknownFields = Object.keys(body).filter((name) => !Object.hasOwn(rules, name));
  if (unknownFields.length > 0) {
    return res.status(400).json({
      error: `Unknown fields: ${unknownFields.join(", ")}.`,
      code: "UNKNOWN_FIELDS",
    });
  }

  const fields = {};
  const accepted = {};

  for (const [name, rule] of Object.entries(rules)) {
    let value = body[name];
    if (typeof value === "string" && rule.trim) {
      value = value.trim();
    }

    if (value === undefined || value === null || value === "") {
      if (rule.required) {
        fields[name] = `${rule.label} is required.`;
      }
      continue;
    }
    if (typeof value !== "string") {
      fields[name] = `${rule.label} must be text.`;
      continue;
    }
    if (rule.maxLength && value.length > rule.maxLength) {
      fields[name] = `${rule.label} must be at most ${rule.maxLength} characters.`;
      continue;
    }

    accepted[name] = value;
  }

  if (Object.keys(fields).length > 0) {
    return res.status(400).json({ error: "Please correct the highlighted fields.", code: "VALIDATION_FAILED", fields });
  }

  req.body = accepted;
  return next();
};

// The password is not trimmed: surrounding spaces may be part of it.
const validateLogin = validateBody({
  email: { label: "Email", required: true, trim: true, maxLength: 254 },
  password: { label: "Password", required: true, maxLength: 128 },
});

module.exports = { validateBody, validateLogin };
