// SPM-147 controller, called directly until the route is wired into
// registrationRoutes.js after SPM-134 merges. Only the model is mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/withdrawalModel", () => ({ withdrawRegistration: jest.fn() }));

const withdrawalModel = require("../../model/withdrawalModel");
const { withdrawMyRegistration } = require("../../controller/withdrawalController");

const ATTENDEE_ID = 21;

const actionError = (code) => Object.assign(new Error(code), { name: "RegistrationActionError", code });

const call = async ({ eventId = "42", body, headers = {} } = {}) => {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = jest.fn((code) => Object.assign(res, { statusCode: code }));
  res.json = jest.fn((payload) => Object.assign(res, { body: payload }));
  res.set = jest.fn((name, value) => Object.assign(res.headers, { [name]: value }));
  const req = { params: { eventId }, body, user: { user_id: ATTENDEE_ID, role: "ATTENDEE" }, get: (name) => headers[name] };
  await withdrawMyRegistration(req, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

test("[SPM-147 AC3] withdrawal answers 200 with the withdrawn place, using the session attendee", async () => {
  withdrawalModel.withdrawRegistration.mockResolvedValue({
    registration: { registrationId: 7, status: "WITHDRAWN", lateWithdrawal: false },
    replayed: false,
  });
  const res = await call({ headers: { "Idempotency-Key": "withdraw-key-1" } });
  expect(res.statusCode).toBe(200);
  expect(res.body.registration.status).toBe("WITHDRAWN");
  expect(withdrawalModel.withdrawRegistration).toHaveBeenCalledWith(ATTENDEE_ID, 42, "withdraw-key-1");
});

test("[SPM-147 AC5] withdrawing after the start shows the past-event message", async () => {
  withdrawalModel.withdrawRegistration.mockRejectedValue(actionError("EVENT_STARTED"));
  const res = await call();
  expect(res.statusCode).toBe(409);
  expect(res.body).toEqual({ error: "Cannot withdraw registration for past events", code: "EVENT_STARTED" });
});

test("[SPM-147] waitlisted, unseen and cancelled places are refused with their codes", async () => {
  withdrawalModel.withdrawRegistration.mockRejectedValueOnce(actionError("NOT_REGISTERED"));
  expect((await call()).body.code).toBe("NOT_REGISTERED");
  withdrawalModel.withdrawRegistration.mockRejectedValueOnce(actionError("EVENT_NOT_FOUND"));
  expect((await call()).statusCode).toBe(404);
  withdrawalModel.withdrawRegistration.mockRejectedValueOnce(actionError("EVENT_NOT_ACTIVE"));
  expect((await call()).body.code).toBe("EVENT_NOT_ACTIVE");
});

test("[SPM-147] withdrawal refuses body fields and bad event IDs, and failures answer 500 without detail", async () => {
  expect((await call({ body: { status: "WITHDRAWN" } })).statusCode).toBe(400);
  expect((await call({ eventId: "x" })).statusCode).toBe(404);
  expect(withdrawalModel.withdrawRegistration).not.toHaveBeenCalled();
  withdrawalModel.withdrawRegistration.mockRejectedValue(new Error("[Supabase Error] connection reset"));
  const failed = await call();
  expect(failed.statusCode).toBe(500);
  expect(failed.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
});
