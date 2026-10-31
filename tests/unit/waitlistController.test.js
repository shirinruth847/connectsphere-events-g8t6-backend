// SPM-163 controllers, called directly; waitlistRoutes.test.js covers the
// routes. Only the model is mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/waitlistModel", () => {
  const actual = jest.requireActual("../../model/waitlistModel");
  return { ...actual, joinWaitlist: jest.fn(), leaveWaitlist: jest.fn(), acceptOffer: jest.fn(), declineOffer: jest.fn() };
});

const waitlistModel = require("../../model/waitlistModel");
const { joinMyWaitlist, leaveMyWaitlist, acceptMyOffer, declineMyOffer, REGISTRATION_ACTION_CONFLICTS } = require("../../controller/waitlistController");

const ATTENDEE_ID = 21;
const EVENT_NOT_FOUND = { error: "Event request not found.", code: "EVENT_NOT_FOUND" };
const registration = { registrationId: 7, status: "WAITLISTED", outcome: "JOINED", waitlistPosition: 1 };

const actionError = (code) => Object.assign(new Error(code), { name: "RegistrationActionError", code });

const call = async (handler, { eventId = "42", body, headers = {} } = {}) => {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = jest.fn((code) => Object.assign(res, { statusCode: code }));
  res.json = jest.fn((payload) => Object.assign(res, { body: payload }));
  res.set = jest.fn((name, value) => Object.assign(res.headers, { [name]: value }));
  const req = {
    params: { eventId },
    body,
    user: { user_id: ATTENDEE_ID, role: "ATTENDEE" },
    get: (name) => headers[name],
  };
  await handler(req, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

test("[SPM-163 AC1/AC2] joining answers 201 with the waitlist place, using the session attendee", async () => {
  waitlistModel.joinWaitlist.mockResolvedValue({ registration, replayed: false });
  const res = await call(joinMyWaitlist, {
    body: { dietaryRestrictions: "Vegan", accessibilityRequirements: null },
    headers: { "Idempotency-Key": "join-key-0001" },
  });
  expect(res.statusCode).toBe(201);
  expect(res.body).toEqual({ registration });
  expect(waitlistModel.joinWaitlist).toHaveBeenCalledWith(
    ATTENDEE_ID,
    42,
    { dietaryRestrictions: "Vegan", accessibilityRequirements: null },
    "join-key-0001"
  );
});

test("[SPM-163] a replay is marked with Idempotent-Replayed", async () => {
  waitlistModel.leaveWaitlist.mockResolvedValue({ registration, replayed: true });
  const res = await call(leaveMyWaitlist, { headers: { "Idempotency-Key": "leave-key-0001" } });
  expect(res.statusCode).toBe(200);
  expect(res.headers["Idempotent-Replayed"]).toBe("true");
  expect(waitlistModel.leaveWaitlist).toHaveBeenCalledWith(ATTENDEE_ID, 42, "leave-key-0001");
});

test("[SPM-163 AC6/AC7] accept and decline pass the offer ID", async () => {
  waitlistModel.acceptOffer.mockResolvedValue({ registration: { ...registration, status: "REGISTERED" }, replayed: false });
  waitlistModel.declineOffer.mockResolvedValue({ registration: { ...registration, status: "WITHDRAWN" }, replayed: false });
  expect((await call(acceptMyOffer, { body: { offerId: 5 } })).statusCode).toBe(200);
  expect((await call(declineMyOffer, { body: { offerId: 5 } })).statusCode).toBe(200);
  expect(waitlistModel.acceptOffer).toHaveBeenCalledWith(ATTENDEE_ID, 42, 5, null);
  expect(waitlistModel.declineOffer).toHaveBeenCalledWith(ATTENDEE_ID, 42, 5, null);
});

test("[SPM-163] bad event IDs are not found and never reach the model", async () => {
  for (const eventId of ["0", "abc", "99999999999"]) {
    const res = await call(leaveMyWaitlist, { eventId });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual(EVENT_NOT_FOUND);
  }
  expect(waitlistModel.leaveWaitlist).not.toHaveBeenCalled();
});

test("[SPM-163] invalid bodies and malformed Idempotency-Keys answer 400", async () => {
  const badBody = await call(acceptMyOffer, { body: { offerId: "5", attendeeId: 1 } });
  expect(badBody.statusCode).toBe(400);
  expect(badBody.body.code).toBe("VALIDATION_FAILED");
  expect(Object.keys(badBody.body.fields).sort()).toEqual(["attendeeId", "offerId"]);

  const badKey = await call(leaveMyWaitlist, { headers: { "Idempotency-Key": "short" } });
  expect(badKey.statusCode).toBe(400);
  expect(Object.keys(badKey.body.fields)).toEqual(["idempotencyKey"]);
  expect(waitlistModel.acceptOffer).not.toHaveBeenCalled();
  expect(waitlistModel.leaveWaitlist).not.toHaveBeenCalled();
});

test("[SPM-163] not-found, forbidden and offer-not-found refusals", async () => {
  waitlistModel.leaveWaitlist.mockRejectedValueOnce(actionError("EVENT_NOT_FOUND"));
  expect((await call(leaveMyWaitlist)).body).toEqual(EVENT_NOT_FOUND);
  waitlistModel.joinWaitlist.mockRejectedValueOnce(actionError("NOT_ATTENDEE"));
  const forbidden = await call(joinMyWaitlist, { body: { dietaryRestrictions: null, accessibilityRequirements: null } });
  expect(forbidden.statusCode).toBe(403);
  waitlistModel.acceptOffer.mockRejectedValueOnce(actionError("OFFER_NOT_FOUND"));
  const noOffer = await call(acceptMyOffer, { body: { offerId: 9 } });
  expect(noOffer.statusCode).toBe(404);
  expect(noOffer.body.code).toBe("OFFER_NOT_FOUND");
});

test.each(Object.keys(REGISTRATION_ACTION_CONFLICTS))("[SPM-163] %s answers 409 with its code", async (code) => {
  waitlistModel.leaveWaitlist.mockRejectedValue(actionError(code));
  const res = await call(leaveMyWaitlist);
  expect(res.statusCode).toBe(409);
  expect(res.body).toEqual({ error: REGISTRATION_ACTION_CONFLICTS[code], code });
});

test("[SPM-163] unexpected failures answer 500 without detail", async () => {
  waitlistModel.leaveWaitlist.mockRejectedValue(new Error("[Supabase Error] connection reset"));
  const failed = await call(leaveMyWaitlist);
  expect(failed.statusCode).toBe(500);
  expect(failed.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
});
