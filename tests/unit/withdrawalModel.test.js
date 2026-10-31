// SPM-147 model: one database function call with the attendee from the
// session; refusals use the shared registration action codes.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));

const supabase = require("../../config/supabase");
const { withdrawRegistration } = require("../../model/withdrawalModel");

const withdrawn = {
  registration: {
    registration_id: 7,
    registration_status: "WITHDRAWN",
    registration_datetime: "2026-10-28T01:00:00+00:00",
    withdrawal_date: "2026-10-30T01:00:00+00:00",
    waitlist_position: null,
    outcome: "WITHDRAWN",
    late_withdrawal: true,
  },
  event: { event_id: 42, title: "Gala", start_datetime: "2026-10-30T10:00:00+00:00", end_datetime: "2026-10-30T12:00:00+00:00" },
  replayed: true,
};

beforeEach(() => jest.clearAllMocks());

test("[SPM-147 AC3/AC6] calls withdraw_event_registration and keeps the late flag", async () => {
  supabase.rpc.mockResolvedValue({ data: withdrawn, error: null });
  const { registration, replayed } = await withdrawRegistration(21, 42, "withdraw-key-1");
  expect(supabase.rpc).toHaveBeenCalledWith("withdraw_event_registration", {
    p_attendee_id: 21,
    p_event_id: 42,
    p_idempotency_key: "withdraw-key-1",
    p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(registration).toMatchObject({ registrationId: 7, status: "WITHDRAWN", withdrawnAt: "2026-10-30T01:00:00+00:00", lateWithdrawal: true });
  expect(replayed).toBe(true);
});

test.each(["EVENT_STARTED", "NOT_REGISTERED", "EVENT_NOT_ACTIVE", "EVENT_NOT_FOUND"])("[SPM-147] refusal %s keeps its code", async (code) => {
  supabase.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: code } });
  await expect(withdrawRegistration(21, 42)).rejects.toMatchObject({ name: "RegistrationActionError", code });
});
