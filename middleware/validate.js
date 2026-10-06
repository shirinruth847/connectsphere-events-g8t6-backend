const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 100;
const PAGE_OFFSET_MAX = 10000;

const parseWholeNumber = (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN);

// Bounds list queries. The parsed values go on req.pagination because
// req.query is read-only in Express 5.
const validatePagination = (req, res, next) => {
  const { limit, offset } = req.query;
  const pagination = { limit: PAGE_LIMIT_DEFAULT, offset: 0 };
  const fields = {};

  if (limit !== undefined) {
    const value = parseWholeNumber(limit);
    if (value >= 1 && value <= PAGE_LIMIT_MAX) {
      pagination.limit = value;
    } else {
      fields.limit = `Limit must be a whole number from 1 to ${PAGE_LIMIT_MAX}.`;
    }
  }

  if (offset !== undefined) {
    const value = parseWholeNumber(offset);
    if (value >= 0 && value <= PAGE_OFFSET_MAX) {
      pagination.offset = value;
    } else {
      fields.offset = `Offset must be a whole number from 0 to ${PAGE_OFFSET_MAX}.`;
    }
  }

  if (Object.keys(fields).length > 0) {
    return res.status(400).json({ error: "Please correct the highlighted fields.", code: "VALIDATION_FAILED", fields });
  }

  req.pagination = pagination;
  return next();
};

module.exports = { validatePagination, PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, PAGE_OFFSET_MAX };
