const express = require("express");
const router = express.Router();

const {
  listQueue,
  listMyReviews,
  claimReview,
  handBackReview,
  saveReviewProgress,
  getReviewPanel,
  decideReview,
} = require("../controller/safetyController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { USER_ROLES } = require("../config/roles");

// SPM-243: Safety Officers only; the claimant and round state are checked in the database.
const safetyOfficerOnly = [requireAuth, requireRole(USER_ROLES.SAFETY_OFFICER)];

router.get("/queue", safetyOfficerOnly, listQueue);
router.get("/mine", safetyOfficerOnly, listMyReviews);
router.get("/:reviewId/panel", safetyOfficerOnly, getReviewPanel);
router.post("/:reviewId/claim", safetyOfficerOnly, claimReview);
router.post("/:reviewId/hand-back", safetyOfficerOnly, handBackReview);
router.put("/:reviewId/progress", safetyOfficerOnly, saveReviewProgress);
router.post("/:reviewId/decision", safetyOfficerOnly, decideReview);

module.exports = router;
