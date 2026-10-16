const { rateLimit } = require("express-rate-limit");

const SIGNUP_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_LIMIT_DEFAULT = 5;

// Sign-up creates accounts with the admin key, which Supabase's per-IP sign-up
// limit does not cover, so the backend limits attempts per client IP itself.
// Every attempt counts, including rejected ones, to slow email probing.
// SIGNUP_RATE_LIMIT_MAX overrides the limit (integration tests raise it).
const createSignupRateLimit = ({ limit } = {}) => {
  const configured = Number.parseInt(process.env.SIGNUP_RATE_LIMIT_MAX, 10);

  return rateLimit({
    windowMs: SIGNUP_WINDOW_MS,
    limit: limit || (configured > 0 ? configured : SIGNUP_LIMIT_DEFAULT),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({ error: "Too many sign-up attempts. Please wait and try again.", code: "RATE_LIMITED" }),
  });
};

const signupRateLimit = createSignupRateLimit();

module.exports = { signupRateLimit, createSignupRateLimit, SIGNUP_WINDOW_MS, SIGNUP_LIMIT_DEFAULT };
