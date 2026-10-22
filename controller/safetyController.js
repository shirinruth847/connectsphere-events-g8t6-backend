// Safety Officer review routes (SPM-243) and the safety outcome on the event page
// (SPM-251). Roles and request shapes are checked here; claimant, round state,
// arrangement version and every business rule are rechecked by the database.
const safetyModel = require("../model/safetyModel");
const { loadEventForViewer } = require("../middleware/authorize");
const { parseEventId } = require("../middleware/validate");
const { validateProgress, validateHandBack, validateDecision, MESSAGES } = require("../validators/safetyValidator");
const { EVENT_RELATIONSHIP } = require("../config/eventConstants");
const { USER_ROLES } = require("../config/roles");

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

// The controller boundary for every handler here: refusals from the model become
// their SAFETY_ERRORS response; anything else goes to the error middleware.
const safetyHandler = (handle) => async (req, res, next) => {
  try {
    return await handle(req, res);
  } catch (error) {
    return handleError(error, res, next);
  }
};

// Handlers on /:reviewId. An ID that cannot exist is "not found", like a round
// outside the caller's scope.
const reviewHandler = (handle) =>
  safetyHandler(async (req, res) => {
    const reviewId = readReviewId(req.params.reviewId);
    if (!reviewId) return sendError(res, "REVIEW_NOT_FOUND");
    return handle(req, res, reviewId);
  });

// GET /api/safety-reviews/queue — AC3 "Awaiting review"
const listQueue = safetyHandler(async (req, res) => res.status(200).json({ reviews: await safetyModel.findQueue() }));

// GET /api/safety-reviews/mine — AC3 "My reviews"
const listMyReviews = safetyHandler(async (req, res) =>
  res.status(200).json({ reviews: await safetyModel.findOfficerReviews(req.user.user_id) })
);

// POST /api/safety-reviews/:reviewId/claim — AC4
const claimReview = reviewHandler(async (req, res, reviewId) => {
  const body = req.body ?? {};
  if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
    return validationFailed(res, { body: "This request takes no fields." });
  }
  const review = await safetyModel.claimReview({ reviewId, actorId: req.user.user_id });
  return res.status(200).json({ message: "Review claimed.", review });
});

// POST /api/safety-reviews/:reviewId/hand-back — AC5
const handBackReview = reviewHandler(async (req, res, reviewId) => {
  const errors = validateHandBack(req.body);
  if (hasErrors(errors)) return validationFailed(res, errors);
  const review = await safetyModel.handBackReview({ reviewId, actorId: req.user.user_id, note: req.body ? req.body.note : null });
  return res.status(200).json({ message: "Review handed back to the queue.", review });
});

// PUT /api/safety-reviews/:reviewId/progress — AC7
const saveReviewProgress = reviewHandler(async (req, res, reviewId) => {
  const errors = validateProgress(req.body);
  if (hasErrors(errors)) return validationFailed(res, errors);
  const review = await safetyModel.saveReviewProgress({ reviewId, actorId: req.user.user_id, progress: req.body });
  return res.status(200).json({ message: "Progress saved.", review });
});

// GET /api/safety-reviews/:reviewId/panel — AC6
const getReviewPanel = reviewHandler(async (req, res, reviewId) =>
  res.status(200).json(await safetyModel.findReviewPanel(reviewId, req.user.user_id))
);

// POST /api/safety-reviews/:reviewId/decision — AC8-AC11, AC13
const decideReview = reviewHandler(async (req, res, reviewId) => {
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
});

// GET /api/events/:id/safety-reviews — SPM-251 (AC15): every round, shaped for the
// viewer. Organiser, coordinator and Safety Officer reach it through the event
// view's scope; Leads, Venue Staff and Technical Support through their own.
const OUTCOME_SHAPE_BY_RELATIONSHIP = Object.freeze({
  [EVENT_RELATIONSHIP.OWNER]: "ORGANISER",
  [EVENT_RELATIONSHIP.ORGANISATION_MEMBER]: "ORGANISER",
  [EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR]: "FULL",
  [EVENT_RELATIONSHIP.SAFETY_OFFICER]: "FULL",
});

const EVENT_VIEW_ROLES = Object.freeze([USER_ROLES.ORGANISER, USER_ROLES.COORDINATOR, USER_ROLES.SAFETY_OFFICER]);

// The outcome shape for this viewer, or null when the event is outside their scope.
const findViewerOutcomeScope = async (eventId, user) => {
  if (!EVENT_VIEW_ROLES.includes(user.role)) return safetyModel.findOutcomeScope(eventId, user);
  const visible = await loadEventForViewer(eventId, user);
  return visible ? { shape: OUTCOME_SHAPE_BY_RELATIONSHIP[visible.access.relationship] } : null;
};

const getEventSafetyReviews = safetyHandler(async (req, res) => {
  const eventId = parseEventId(req.params.id);
  if (!eventId) return sendError(res, "EVENT_NOT_FOUND");
  const scope = await findViewerOutcomeScope(eventId, req.user);
  if (!scope || !scope.shape) return sendError(res, "EVENT_NOT_FOUND");
  return res.status(200).json({ reviews: await safetyModel.findEventOutcomes(eventId, scope) });
});

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
