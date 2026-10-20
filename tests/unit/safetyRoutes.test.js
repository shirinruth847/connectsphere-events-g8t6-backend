// SPM-243 route-level unit tests: real Express app, routes, middleware,
// controller and validator. The model functions that reach Supabase or MongoDB
// are mocked; the database rules are covered by tests/database and the
// safety integration suites.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/safetyModel", () => {
  const actual = jest.requireActual("../../model/safetyModel");
  return {
    ...actual,
    findQueue: jest.fn(),
    findOfficerReviews: jest.fn(),
    findReviewPanel: jest.fn(),
    findRoundEventId: jest.fn(),
    assertVenueDetailsReadable: jest.fn(),
    claimReview: jest.fn(),
    handBackReview: jest.fn(),
    saveReviewProgress: jest.fn(),
    decideReview: jest.fn(),
    findOutcomeScope: jest.fn(),
    findEventOutcomes: jest.fn(),
  };
});
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return { ...actual, findVisibleEvent: jest.fn() };
});

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");
const safetyModel = require("../../model/safetyModel");

const OFFICER_ID = 31;
const KEY = "5f0f2a7c-1d7e-4c8e-9a51-6b2f1c3d4e5f";
const FACTORS = ["attendanceCapacity", "layout", "emergencyAccess", "accessibility", "equipmentPlacement", "venueRestrictions"];
const checklist = (overrides = {}) => ({
  ...Object.fromEntries(FACTORS.map((factor) => [factor, { result: "SATISFACTORY", comment: "" }])),
  ...overrides,
});

const safetyError = (code, extra = {}) => Object.assign(new Error(code), { name: "SafetyReviewError", code, ...extra });

const signedInAs = (role, userId = OFFICER_ID) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
};

const send = (method, path, body, headers = {}) => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};

const decision = (overrides = {}) => ({ outcome: "APPROVED", checklist: checklist(), arrangementVersion: 3, ...overrides });

beforeEach(() => {
  jest.clearAllMocks();
  signedInAs("SAFETY_OFFICER");
});

describe("Safety Officer routes: role gate", () => {
  test.each(["ORGANISER", "COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "TECH_SUPPORT", "ATTENDEE"])(
    "[SPM-243-AC2] should_refuse_%s_on_every_review_route",
    async (role) => {
      signedInAs(role, 5);
      const responses = await Promise.all([
        send("get", "/api/safety-reviews/queue"),
        send("post", "/api/safety-reviews/7/claim", {}),
        send("post", "/api/safety-reviews/7/decision", decision(), { "Idempotency-Key": KEY }),
      ]);
      expect(responses.map((res) => res.status)).toEqual([403, 403, 403]);
      expect(safetyModel.findQueue).not.toHaveBeenCalled();
      expect(safetyModel.decideReview).not.toHaveBeenCalled();
    }
  );
});

describe("GET /api/safety-reviews/queue and /mine (AC3)", () => {
  test("[SPM-243-TC-05] should_list_the_queue_and_the_officer's_own_reviews", async () => {
    safetyModel.findQueue.mockResolvedValue([{ reviewId: 7 }]);
    safetyModel.findOfficerReviews.mockResolvedValue([{ reviewId: 8 }]);
    expect((await send("get", "/api/safety-reviews/queue")).body).toEqual({ reviews: [{ reviewId: 7 }] });
    expect((await send("get", "/api/safety-reviews/mine")).body).toEqual({ reviews: [{ reviewId: 8 }] });
    expect(safetyModel.findOfficerReviews).toHaveBeenCalledWith(OFFICER_ID);
  });
});

describe("POST /api/safety-reviews/:reviewId/claim (AC4)", () => {
  test("[SPM-243-TC-05] should_claim_with_the_trusted_user_id", async () => {
    safetyModel.claimReview.mockResolvedValue({ reviewId: 7, claimedBy: OFFICER_ID });
    const res = await send("post", "/api/safety-reviews/7/claim", {});
    expect(res.status).toBe(200);
    expect(safetyModel.claimReview).toHaveBeenCalledWith({ reviewId: 7, actorId: OFFICER_ID });
  });

  test.each([
    ["ROUND_NOT_CLAIMABLE", 409],
    ["REVIEW_NOT_FOUND", 404],
    ["FORBIDDEN", 403],
  ])("[SPM-243-TC-06] should_answer_%s_with_%s", async (code, status) => {
    safetyModel.claimReview.mockRejectedValue(safetyError(code));
    const res = await send("post", "/api/safety-reviews/7/claim", {});
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  test("should_refuse_fields_and_malformed_ids_without_calling_the_model", async () => {
    expect((await send("post", "/api/safety-reviews/7/claim", { claimedBy: 99 })).status).toBe(400);
    expect((await send("post", "/api/safety-reviews/abc/claim", {})).status).toBe(404);
    expect(safetyModel.claimReview).not.toHaveBeenCalled();
  });
});

describe("POST /api/safety-reviews/:reviewId/hand-back (AC5)", () => {
  test("[SPM-243-TC-07] should_hand_back_with_an_optional_note", async () => {
    safetyModel.handBackReview.mockResolvedValue({ reviewId: 7, claimedBy: null });
    const res = await send("post", "/api/safety-reviews/7/hand-back", { note: "Away tomorrow" });
    expect(res.status).toBe(200);
    expect(safetyModel.handBackReview).toHaveBeenCalledWith({ reviewId: 7, actorId: OFFICER_ID, note: "Away tomorrow" });
  });

  test("[SPM-243-TC-08] should_refuse_a_non_claimant_and_a_decided_round", async () => {
    safetyModel.handBackReview.mockRejectedValueOnce(safetyError("NOT_CLAIMANT"));
    expect((await send("post", "/api/safety-reviews/7/hand-back", {})).status).toBe(403);
    safetyModel.handBackReview.mockRejectedValueOnce(safetyError("ROUND_NOT_OPEN", { currentStatus: "APPROVED" }));
    const decided = await send("post", "/api/safety-reviews/7/hand-back", {});
    expect(decided.status).toBe(409);
    expect(decided.body).toMatchObject({ code: "ROUND_NOT_OPEN", currentStatus: "APPROVED" });
  });

  test("should_refuse_a_long_note_and_unknown_fields", async () => {
    const res = await send("post", "/api/safety-reviews/7/hand-back", { note: "x".repeat(501), status: "OPEN" });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(["note", "status"]);
  });
});

describe("PUT /api/safety-reviews/:reviewId/progress (AC7)", () => {
  test("[SPM-243-TC-11] should_save_a_partial_checklist", async () => {
    safetyModel.saveReviewProgress.mockResolvedValue({ reviewId: 7 });
    const body = { checklist: { layout: { result: "NOT_SATISFACTORY" } }, internalNotes: "Draft" };
    expect((await send("put", "/api/safety-reviews/7/progress", body)).status).toBe(200);
    expect(safetyModel.saveReviewProgress).toHaveBeenCalledWith({ reviewId: 7, actorId: OFFICER_ID, progress: body });
  });

  test("should_name_the_factor_or_field_that_is_wrong", async () => {
    const res = await send("put", "/api/safety-reviews/7/progress", {
      checklist: { layout: { result: "MAYBE" }, parking: { result: "SATISFACTORY" } },
      decidedBy: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(expect.objectContaining({
      "checklist.layout": expect.any(String),
      "checklist.parking": expect.any(String),
      decidedBy: "This field cannot be set.",
    }));
  });
});

describe("POST /api/safety-reviews/:reviewId/decision (AC7-AC11, AC13)", () => {
  beforeEach(() => {
    safetyModel.findRoundEventId.mockResolvedValue(42);
    safetyModel.assertVenueDetailsReadable.mockResolvedValue();
  });

  test("[SPM-243-TC-12] should_record_an_approval_after_checking_venue_details", async () => {
    safetyModel.decideReview.mockResolvedValue({ superseded: false, replayed: false, review: { reviewId: 7, status: "APPROVED" }, event: { status: "SAFETY_REVIEW" } });
    const res = await send("post", "/api/safety-reviews/7/decision", decision({ organiserComment: "All clear" }), { "Idempotency-Key": KEY });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ review: { status: "APPROVED" }, event: { eventId: 42, status: "SAFETY_REVIEW" } });
    expect(safetyModel.assertVenueDetailsReadable).toHaveBeenCalledWith(42);
    expect(safetyModel.decideReview).toHaveBeenCalledWith({
      reviewId: 7,
      actorId: OFFICER_ID,
      decision: { outcome: "APPROVED", checklist: checklist(), organiserComment: "All clear" },
      arrangementVersion: 3,
      idempotencyKey: KEY,
    });
  });

  test("[SPM-243-TC-10] should_refuse_a_missing_factor_and_a_missing_comment_naming_the_factor", async () => {
    const incomplete = checklist({ layout: { result: "NOT_SATISFACTORY", comment: "" } });
    delete incomplete.emergencyAccess;
    const res = await send("post", "/api/safety-reviews/7/decision", decision({ outcome: "CHANGES_REQUESTED", checklist: incomplete, requestedChanges: ["Wider aisles"] }), { "Idempotency-Key": KEY });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({
      "checklist.emergencyAccess": "Record a result for this factor.",
      "checklist.layout": "Explain the result in a comment.",
    });
    expect(safetyModel.decideReview).not.toHaveBeenCalled();
  });

  test.each([
    ["CHANGES_REQUESTED without changes", { outcome: "CHANGES_REQUESTED" }, "requestedChanges"],
    ["REJECTED without bookings", { outcome: "REJECTED" }, "rejectedBookings"],
    ["REJECTED with a duplicate booking", { outcome: "REJECTED", rejectedBookings: [{ bookingId: 5, reason: "a" }, { bookingId: 5, reason: "b" }] }, "rejectedBookings"],
    ["no arrangement version", { arrangementVersion: undefined }, "arrangementVersion"],
  ])("[SPM-243-TC-16] should_refuse_%s", async (_label, overrides, field) => {
    const res = await send("post", "/api/safety-reviews/7/decision", decision(overrides), { "Idempotency-Key": KEY });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty(field);
  });

  test("[SPM-243-AC13] should_require_an_idempotency_key", async () => {
    const res = await send("post", "/api/safety-reviews/7/decision", decision());
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("idempotencyKey");
  });

  test("[SPM-243-TC-20] should_refuse_with_a_retry_message_when_venue_details_cannot_be_read", async () => {
    safetyModel.assertVenueDetailsReadable.mockRejectedValue(safetyError("VENUE_DETAILS_UNAVAILABLE"));
    const res = await send("post", "/api/safety-reviews/7/decision", decision(), { "Idempotency-Key": KEY });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Try again/);
    expect(safetyModel.decideReview).not.toHaveBeenCalled();
  });

  test("[SPM-243-TC-18] should_answer_409_with_the_superseded_round_when_the_arrangements_changed", async () => {
    safetyModel.decideReview.mockResolvedValue({ superseded: true, replayed: false, review: { reviewId: 7, status: "SUPERSEDED" }, event: { status: "PLANNING" } });
    const res = await send("post", "/api/safety-reviews/7/decision", decision(), { "Idempotency-Key": KEY });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ARRANGEMENTS_CHANGED", currentStatus: "PLANNING", review: { status: "SUPERSEDED" } });
  });

  test.each([
    ["NOT_CLAIMANT", 403, {}],
    ["SAFETY_FACTOR_NOT_SATISFACTORY", 409, { factors: ["layout"] }],
    ["ROUND_NOT_OPEN", 409, {}],
    ["IDEMPOTENCY_KEY_REUSED", 409, {}],
  ])("[SPM-243-TC-13][TC-17] should_answer_%s_with_%s", async (code, status, extra) => {
    safetyModel.decideReview.mockRejectedValue(safetyError(code, extra));
    const res = await send("post", "/api/safety-reviews/7/decision", decision(), { "Idempotency-Key": KEY });
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ code, ...extra });
  });

  test("[SPM-243-TC-22] should_mark_a_replay", async () => {
    safetyModel.decideReview.mockResolvedValue({ superseded: false, replayed: true, review: { reviewId: 7, status: "APPROVED" }, event: { status: "SAFETY_REVIEW" } });
    const res = await send("post", "/api/safety-reviews/7/decision", decision(), { "Idempotency-Key": KEY });
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replay"]).toBe("true");
  });
});

describe("GET /api/events/:id/safety-reviews (SPM-251, AC15)", () => {
  const ROUND = {
    review_id: 7, event_id: 42, round_number: 1, arrangement_version: 3, status: "REJECTED",
    submitted_at: "2026-10-20T01:00:00Z", claimed_by: OFFICER_ID, claimed_at: "2026-10-20T02:00:00Z",
    checklist: { layout: { result: "NOT_SATISFACTORY", comment: "Narrow" } }, organiser_comment: "Please change the hall.",
    internal_notes: "Fire officer concerned.", requested_changes: null, decided_by: OFFICER_ID, decided_at: "2026-10-20T03:00:00Z",
    superseded_at: null, safety_review_rejected_bookings: [{ booking_id: 5, reason: "No exit" }, { booking_id: 6, reason: "Too small" }],
  };
  const eventRow = { event_id: 42, organiser_id: 11, coordinator_id: 21, organisation_id: null, status: "PLANNING" };

  beforeEach(() => {
    const actual = jest.requireActual("../../model/safetyModel");
    safetyModel.findEventOutcomes.mockImplementation(async (_eventId, { shape, ownBookingIds = [] }) =>
      [ROUND].map((row) => actual.OUTCOME_SHAPES[shape](row, ownBookingIds)));
  });

  test("[SPM-243-TC-23] should_show_the_organiser_the_outcome_and_comment_only", async () => {
    signedInAs("ORGANISER", 11);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow);
    const res = await send("get", "/api/events/42/safety-reviews");
    expect(res.status).toBe(200);
    expect(res.body.reviews).toEqual([{ roundNumber: 1, status: "REJECTED", decidedAt: ROUND.decided_at, organiserComment: "Please change the hall." }]);
    expect(JSON.stringify(res.body)).not.toMatch(/Fire officer|Narrow|No exit/);
  });

  test("[SPM-243-TC-23] should_show_the_coordinator_everything", async () => {
    signedInAs("COORDINATOR", 21);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow);
    const res = await send("get", "/api/events/42/safety-reviews");
    expect(res.body.reviews[0]).toMatchObject({ internalNotes: "Fire officer concerned.", checklist: ROUND.checklist, rejectedBookings: [{ bookingId: 5, reason: "No exit" }, { bookingId: 6, reason: "Too small" }] });
  });

  test.each([
    ["COORDINATOR_LEAD", { shape: "OUTCOME" }, { roundNumber: 1, status: "REJECTED", decidedAt: ROUND.decided_at }],
    ["TECH_SUPPORT", { shape: "OUTCOME" }, { roundNumber: 1, status: "REJECTED", decidedAt: ROUND.decided_at }],
    ["VENUE_STAFF", { shape: "VENUE_STAFF", ownBookingIds: [6] }, { roundNumber: 1, status: "REJECTED", decidedAt: ROUND.decided_at, rejectedBookings: [{ bookingId: 6, reason: "Too small" }] }],
  ])("[SPM-243-TC-23] should_show_%s_its_portion_only", async (role, scope, expected) => {
    signedInAs(role, 50);
    safetyModel.findOutcomeScope.mockResolvedValue(scope);
    const res = await send("get", "/api/events/42/safety-reviews");
    expect(res.status).toBe(200);
    expect(res.body.reviews).toEqual([expected]);
  });

  test("should_answer_not_found_outside_every_scope", async () => {
    signedInAs("VENUE_STAFF", 50);
    safetyModel.findOutcomeScope.mockResolvedValue(null);
    expect((await send("get", "/api/events/42/safety-reviews")).status).toBe(404);
    signedInAs("ATTENDEE", 60);
    expect((await send("get", "/api/events/42/safety-reviews")).status).toBe(404);
    signedInAs("ORGANISER", 12);
    eventModel.findVisibleEvent.mockResolvedValue(null);
    expect((await send("get", "/api/events/42/safety-reviews")).status).toBe(404);
  });
});
