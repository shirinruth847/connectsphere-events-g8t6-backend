// Route-level unit tests for SPM-163 and SPM-147: real Express app, routes,
// middleware and controllers. Only the model calls that reach Supabase and the
// Supabase-backed user lookup are mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/waitlistModel", () => ({
  ...jest.requireActual("../../model/waitlistModel"),
  joinWaitlist: jest.fn(),
  leaveWaitlist: jest.fn(),
  acceptOffer: jest.fn(),
  declineOffer: jest.fn(),
  findWaitlistPositions: jest.fn(),
}));
jest.mock("../../model/withdrawalModel", () => ({ withdrawRegistration: jest.fn() }));
jest.mock("../../model/registrationModel", () => ({
  ...jest.requireActual("../../model/registrationModel"),
  findAttendeeRegistrations: jest.fn(),
}));
jest.mock("../../model/eventModel", () => ({
  ...jest.requireActual("../../model/eventModel"),
  findRegisteredAttendeeEvent: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const waitlistModel = require("../../model/waitlistModel");
const withdrawalModel = require("../../model/withdrawalModel");
const registrationModel = require("../../model/registrationModel");
const eventModel = require("../../model/eventModel");

const ATTENDEE_ID = 21;
const NON_ATTENDEE_ROLES = ["ORGANISER", "COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "TECH_SUPPORT", "SAFETY_OFFICER"];
const ANSWERS = { dietaryRestrictions: "Vegan", accessibilityRequirements: null };
const PLACE = {
  registrationId: 7,
  status: "WAITLISTED",
  outcome: "JOINED",
  waitlistPosition: 2,
  registeredAt: "2026-10-31T01:00:00+00:00",
  withdrawnAt: null,
  event: { eventId: 42, title: "Gala", startDatetime: "2026-11-07T01:00:00+00:00", endDatetime: "2026-11-07T03:00:00+00:00" },
};

// [path, model function, body] for each attendee action.
const ACTIONS = [
  ["/api/registrations/mine/42/waitlist", "joinWaitlist", ANSWERS],
  ["/api/registrations/mine/42/waitlist/leave", "leaveWaitlist", undefined],
  ["/api/registrations/mine/42/offer/accept", "acceptOffer", { offerId: 5 }],
  ["/api/registrations/mine/42/offer/decline", "declineOffer", { offerId: 5 }],
  ["/api/registrations/mine/42/withdraw", "withdrawRegistration", undefined],
];
const modelFor = (name) => (name === "withdrawRegistration" ? withdrawalModel : waitlistModel)[name];

const signedInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: ATTENDEE_ID, role, organisation_ids: [] });
};
const post = (path, body, headers = {}) => {
  const req = request(app).post(path).set("Authorization", "Bearer token").set(headers);
  return body === undefined ? req : req.send(body);
};
const get = (path) => request(app).get(path).set("Authorization", "Bearer token");
const actionError = (code) => Object.assign(new Error(code), { name: "RegistrationActionError", code });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs("ATTENDEE");
  for (const [, name] of ACTIONS) modelFor(name).mockResolvedValue({ registration: PLACE, replayed: false });
});

describe("authentication and role (SPM-163, SPM-147)", () => {
  test.each(ACTIONS)("[SPM-163][SPM-147] %s answers 401 without a token and changes nothing", async (path, name, body) => {
    const res = await request(app).post(path).send(body);
    expect(res.status).toBe(401);
    expect(modelFor(name)).not.toHaveBeenCalled();
  });

  test.each(NON_ATTENDEE_ROLES)("[SPM-163][SPM-147] %s cannot use any attendee action", async (role) => {
    signedInAs(role);
    for (const [path, name, body] of ACTIONS) {
      const res = await post(path, body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(modelFor(name)).not.toHaveBeenCalled();
    }
  });
});

describe("POST /api/registrations/mine/:eventId/... (SPM-163, SPM-147)", () => {
  test("[SPM-163 AC1/AC2] joining answers 201 with the queue position, for the session attendee", async () => {
    const res = await post("/api/registrations/mine/42/waitlist", { ...ANSWERS }, { "Idempotency-Key": "join-key-0001" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ registration: PLACE });
    expect(waitlistModel.joinWaitlist).toHaveBeenCalledWith(ATTENDEE_ID, 42, ANSWERS, "join-key-0001");
  });

  test("[SPM-163 AC1] a join naming another attendee or missing an answer is refused before the model", async () => {
    const res = await post("/api/registrations/mine/42/waitlist", { dietaryRestrictions: null, attendeeId: 99 });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(["accessibilityRequirements", "attendeeId"]);
    expect(waitlistModel.joinWaitlist).not.toHaveBeenCalled();
  });

  test("[SPM-163 AC4/AC6/AC7][SPM-147 AC3] leave, accept, decline and withdraw answer 200 for the session attendee", async () => {
    for (const [path, , body] of ACTIONS.slice(1)) expect((await post(path, body)).status).toBe(200);
    expect(waitlistModel.leaveWaitlist).toHaveBeenCalledWith(ATTENDEE_ID, 42, null);
    expect(waitlistModel.acceptOffer).toHaveBeenCalledWith(ATTENDEE_ID, 42, 5, null);
    expect(waitlistModel.declineOffer).toHaveBeenCalledWith(ATTENDEE_ID, 42, 5, null);
    expect(withdrawalModel.withdrawRegistration).toHaveBeenCalledWith(ATTENDEE_ID, 42, null);
  });

  test("[SPM-163] a replay is marked with Idempotent-Replayed", async () => {
    waitlistModel.acceptOffer.mockResolvedValue({ registration: { ...PLACE, status: "REGISTERED" }, replayed: true });
    const res = await post("/api/registrations/mine/42/offer/accept", { offerId: 5 }, { "Idempotency-Key": "accept-key-001" });
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });

  test("[SPM-147 AC5] withdrawing after the start answers 409 with the past-event message", async () => {
    withdrawalModel.withdrawRegistration.mockRejectedValue(actionError("EVENT_STARTED"));
    const res = await post("/api/registrations/mine/42/withdraw");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Cannot withdraw registration for past events", code: "EVENT_STARTED" });
  });

  test("[SPM-163 AC6] an expired offer and an unknown event answer with their codes", async () => {
    waitlistModel.acceptOffer.mockRejectedValue(actionError("OFFER_EXPIRED"));
    expect((await post("/api/registrations/mine/42/offer/accept", { offerId: 5 })).body.code).toBe("OFFER_EXPIRED");
    expect((await post("/api/registrations/mine/abc/withdraw")).status).toBe(404);
    expect(withdrawalModel.withdrawRegistration).not.toHaveBeenCalled();
  });
});

describe("GET /api/registrations/mine waitlist fields (SPM-163 AC3)", () => {
  const listed = (eventId, status) => ({
    registration_id: eventId + 100,
    registration_status: status,
    registered_at: "2026-10-30T01:00:00+00:00",
    event: { event_id: eventId, title: "Gala" },
  });

  test("[SPM-163 AC3] waitlisted places show the position and open offer; others show nulls", async () => {
    registrationModel.findAttendeeRegistrations.mockResolvedValue({
      registrations: [listed(42, "WAITLISTED"), listed(43, "REGISTERED")],
      nextOffset: null,
    });
    waitlistModel.findWaitlistPositions.mockResolvedValue([
      { registrationId: 142, eventId: 42, waitlistPosition: 1, offer: { offerId: 5, expiresAt: "2026-11-01T01:00:00+00:00" } },
    ]);
    const res = await get("/api/registrations/mine");
    expect(res.status).toBe(200);
    expect(res.body.registrations).toEqual([
      { ...listed(42, "WAITLISTED"), waitlistPosition: 1, offer: { offerId: 5, expiresAt: "2026-11-01T01:00:00+00:00" } },
      { ...listed(43, "REGISTERED"), waitlistPosition: null, offer: null },
    ]);
    expect(waitlistModel.findWaitlistPositions).toHaveBeenCalledWith(ATTENDEE_ID);
  });

  test("[SPM-163 AC3] no position lookup when nothing is waitlisted, on the list or one event", async () => {
    registrationModel.findAttendeeRegistrations.mockResolvedValue({ registrations: [listed(43, "REGISTERED")], nextOffset: null });
    expect((await get("/api/registrations/mine")).body.registrations[0]).toMatchObject({ waitlistPosition: null, offer: null });

    eventModel.findRegisteredAttendeeEvent.mockResolvedValue({ event: { eventId: 43 }, myRegistration: { status: "REGISTERED", registeredAt: null } });
    const one = await get("/api/registrations/mine/43");
    expect(one.status).toBe(200);
    expect(one.body.myRegistration).toEqual({ status: "REGISTERED", registeredAt: null, waitlistPosition: null, offer: null });
    expect(waitlistModel.findWaitlistPositions).not.toHaveBeenCalled();
  });

  test("[SPM-163] a failed position lookup answers 500 without detail", async () => {
    registrationModel.findAttendeeRegistrations.mockResolvedValue({ registrations: [listed(42, "WAITLISTED")], nextOffset: null });
    waitlistModel.findWaitlistPositions.mockRejectedValue(new Error("[Supabase Error] down"));
    const res = await get("/api/registrations/mine");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});
