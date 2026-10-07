const express = require("express");
const router = express.Router();

const { getCurrentUser, logout } = require("../controller/authController");
const { requireAuth } = require("../middleware/auth");

router.get("/me", requireAuth, getCurrentUser);
router.post("/logout", logout);

module.exports = router;
