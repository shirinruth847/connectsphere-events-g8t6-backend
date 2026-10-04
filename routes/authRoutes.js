const express = require("express");
const router = express.Router();

const { login, getCurrentUser, logout } = require("../controller/authController");
const { requireAuth } = require("../middleware/auth");
const { validateLogin } = require("../middleware/validate");

router.post("/login", validateLogin, login);
router.get("/me", requireAuth, getCurrentUser);
router.post("/logout", logout);

module.exports = router;
