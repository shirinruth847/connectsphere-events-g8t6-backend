// Safety Officer review routes (SPM-243) and the safety outcome on the event page
// (SPM-251). Roles and request shapes are checked here; claimant, round state,
// arrangement version and every business rule are rechecked by the database.
const safetyModel = require("../model/safetyModel");
const { loadEventForViewer } = require("../middleware/authorize");
const { parseEventId } = require("../middleware/validate");
const { validateProgress, validateHandBack, validateDecision, MESSAGES } = require("../validators/safetyValidator");
const { EVENT_RELATIONSHIP } = require("../config/eventConstants");

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const IDEMPOTENCY_KEY_MESSAGE =
  "Send an Idempotency-Key header of 8-128 letters, digits, '.', '_', ':' or '-' (a UUID works).";

const SAFETY_ERRORS = Object.freeze({
  FORBIDDEN: [403, "You do not have permission to access this resource."],
  NOT_CLAIMANT: [403, "Only the Safety Officer who claimed this review can do this."],
  REVIEW_NOT_FOUND: [404, "Safety review not found."],
  EVENT_NOT_FOUND: [404, "Event request not found."],
  ROUND_NOT_CLAIMABLE: [409, "This review was already claimed or decided. Refresh the queue."],
  ROUND_NOT_OPEN: [409, "This review round is closed. It was decided or superseded."],
  ARRANGEMENTS_CHANGED: [409, "The event's arrangements changed after this review opened. Reload the review."],
  TRANSITION_NOT_ALLOWED: [409, "The event is no longer awaiting a safety decision."],
  SAFETY_FACTOR_NOT_SATISFACTORY: [409, MESSAGES.factorsNotSatisfactory],
  IDEMPOTENCY_KEY_REUSED: [409, "This Idempotency-Key was already used for a different request."],
  IDEMPOTENCY_IN_PROGRESS: [409, "This request is still being processed. Try again shortly."],
  VENUE_DETAILS_UNAVAILABLE: [503, "Venue safety details could not be loaded, so the review cannot be decided now. Try again shortly."],
});

const sendError = (res, code, extra = {}) => {
  const [status, error] = SAFETY_ERRORS[code];
  return res.status(status).json({ error, code, ...extra });
};

const validationFailed = (res, fields) =>
  res.status(400).json({ error: "Please correct the highlighted fields.", code: "VALIDATION_FAILED", fields });

const handleError = (error, res, next) => {
  if (error.name === "SafetyReviewError") {
    if (error.code === "VALIDATION_FAILED") return validationFailed(res, error.fields || {});
    if (SAFETY_ERRORS[error.code]) {
      const extra = {};
      if (error.factors) extra.factors = error.factors;
      if (error.currentStatus && error.code !== "ROUND_NOT_CLAIMABLE") extra.currentStatus = error.currentStatus;
      return sendError(res, error.code, extra);
    }
  }
  return next(error);
};

const readReviewId = (raw) => (/^[1-9]\d{0,15}$/.test(String(raw)) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null);

const hasErrors = (fields) => Object.keys(fields).length > 0;

// GET /api/safety-reviews/queue — AC3 "Awaiting review"
const listQueue = async (req, res, next) => {
  try {
    return res.status(200).json({ reviews: await safetyModel.findQueue() });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// GET /api/safety-reviews/mine — AC3 "My reviews"
const listMyReviews = async (req, res, next) => {
  try {
    return res.status(200).json({ reviews: await safetyModel.findOfficerReviews(req.user.user_id) });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// POST /api/safety-reviews/:reviewId/claim — AC4
const claimReview = async (req, res, next) => {
  try {
    const reviewId = readReviewId(req.params.reviewId);
    if (!reviewId) return sendError(res, "REVIEW_NOT_FOUND");
    const body = req.body ?? {};
    if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
      return validationFailed(res, { body: "This request takes no fields." });
    }
    const review = await safetyModel.claimReview({ reviewId, actorId: req.user.user_id });
    return res.status(200).json({ message: "Review claimed.", review });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// POST /api/safety-reviews/:reviewId/hand-back — AC5
const handBackReview = async (req, res, next) => {
  try {
    const reviewId = readReviewId(req.params.reviewId);
    if (!reviewId) return sendError(res, "REVIEW_NOT_FOUND");
    const errors = validateHandBack(req.body);
    if (hasErrors(errors)) return validationFailed(res, errors);
    const review = await safetyModel.handBackReview({ reviewId, actorId: req.user.user_id, note: req.body ? req.body.note : null });
    return res.status(200).json({ message: "Review handed back to the queue.", review });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// PUT /api/safety-reviews/:reviewId/progress — AC7
const saveReviewProgress = async (req, res, next) => {
  try {
    const reviewId = readReviewId(req.params.reviewId);
    if (!reviewId) return sendError(res, "REVIEW_NOT_FOUND");
    const errors = validateProgress(req.body);
    if (hasErrors(errors)) return validationFailed(res, errors);
    const review = await safetyModel.saveReviewProgress({ reviewId, actorId: req.user.user_id, progress: req.body });
    return res.status(200).json({ message: "Progress saved.", review });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// GET /api/safety-reviews/:reviewId/panel — AC6
const getReviewPanel = async (req, res, next) => {
  try {
    const reviewId = readReviewId(req.params.reviewId);
    if (!reviewId) return sendError(res, "REVIEW_NOT_FOUND");
    return res.status(200).json(await safetyModel.findReviewPanel(reviewId, req.user.user_id));
  } catch (error) {
    return handleError(error, res, next);
  }
};

// POST /api/safety-reviews/:reviewId/decision — AC8-AC11, AC13
const decideReview = async (req, res, next) => {
  try {
    const reviewId = readReviewId(req.params.reviewId);
    if (!reviewId) return sendError(res, "REVIEW_NOT_FOUND");
    const errors = validateDecision(req.body);
    const idempotencyKey = req.get("Idempotency-Key");
    if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) errors.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
    if (hasErrors(errors)) return validationFailed(res, errors);

    const eventId = await safetyModel.findRoundEventId(reviewId);
    await safetyModel.assertVenueDetailsReadable(eventId);

    const { arrangementVersion, ...decision } = req.body;
    const result = await safetyModel.decideReview({ reviewId, actorId: req.user.user_id, decision, arrangementVersion, idempotencyKey });
    if (result.replayed) res.set("Idempotent-Replay", "true");
    if (result.superseded) {
      return sendError(res, "ARRANGEMENTS_CHANGED", { review: result.review, currentStatus: result.event ? result.event.status : null });
    }
    return res.status(200).json({ message: "Safety decision recorded.", review: result.review, event: { eventId, status: result.event.status } });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// GET /api/events/:id/safety-reviews — SPM-251 (AC15): every round, shaped for the
// viewer. Organiser, coordinator and Safety Officer reach it through the event
// view's scope; Leads, Venue Staff and Technical Support through their own.
const OUTCOME_SHAPE_BY_RELATIONSHIP = Object.freeze({
  [EVENT_RELATIONSHIP.OWNER]: "ORGANISER",
  [EVENT_RELATIONSHIP.ORGANISATION_MEMBER]: "ORGANISER",
  [EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR]: "FULL",
  [EVENT_RELATIONSHIP.SAFETY_OFFICER]: "FULL",
});

const getEventSafetyReviews = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return sendError(res, "EVENT_NOT_FOUND");
    let scope = null;
    if (["ORGANISER", "COORDINATOR", "SAFETY_OFFICER"].includes(req.user.role)) {
      const visible = await loadEventForViewer(eventId, req.user);
      if (visible) scope = { shape: OUTCOME_SHAPE_BY_RELATIONSHIP[visible.access.relationship] };
    } else {
      scope = await safetyModel.findOutcomeScope(eventId, req.user);
    }
    if (!scope || !scope.shape) return sendError(res, "EVENT_NOT_FOUND");
    return res.status(200).json({ reviews: await safetyModel.findEventOutcomes(eventId, scope) });
  } catch (error) {
    return handleError(error, res, next);
  }
};

module.exports = {
  listQueue,
  listMyReviews,
  claimReview,
  handBackReview,
  saveReviewProgress,
  getReviewPanel,
  decideReview,
  getEventSafetyReviews,
};
