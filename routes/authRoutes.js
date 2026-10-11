const express = require("express");
const router = express.Router();

const { getCurrentUser, logout, signup } = require("../controller/authController");
const { requireAuth } = require("../middleware/auth");
const { signupRateLimit } = require("../middleware/rateLimit");

router.post("/signup", signupRateLimit, signup);
router.get("/me", requireAuth, getCurrentUser);
router.post("/logout", logout);

module.exports = router;
