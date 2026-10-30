// SPM-163 model: each action is one database function call with the attendee
// from the session, and database refusals become stable codes.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));

const supabase = require("../../config/supabase");
const waitlistModel = require("../../model/waitlistModel");

const result = (registration = {}) => ({
  registration: {
    registration_id: 7,
    registration_status: "WAITLISTED",
    registration_datetime: "2026-10-30T01:00:00+00:00",
    withdrawal_date: null,
    waitlist_position: 2,
    outcome: "JOINED",
    ...registration,
  },
  event: { event_id: 42, title: "Gala", start_datetime: "2026-11-02T01:00:00+00:00", end_datetime: "2026-11-02T03:00:00+00:00" },
  replayed: false,
});

beforeEach(() => jest.clearAllMocks());

test("[SPM-163 AC1/AC2] joinWaitlist calls join_event_waitlist and maps the place", async () => {
  supabase.rpc.mockResolvedValue({ data: result(), error: null });
  const answers = { dietaryRestrictions: "Vegan", accessibilityRequirements: null };
  const { registration, replayed } = await waitlistModel.joinWaitlist(21, 42, answers, "join-key-0001");

  const [name, params] = supabase.rpc.mock.calls[0];
  expect(name).toBe("join_event_waitlist");
  expect(params).toEqual({
    p_attendee_id: 21,
    p_event_id: 42,
    p_dietary_restrictions: "Vegan",
    p_accessibility_requirements: null,
    p_idempotency_key: "join-key-0001",
    p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(replayed).toBe(false);
  expect(registration).toEqual({
    registrationId: 7,
    status: "WAITLISTED",
    outcome: "JOINED",
    waitlistPosition: 2,
    registeredAt: "2026-10-30T01:00:00+00:00",
    withdrawnAt: null,
    event: { eventId: 42, title: "Gala", startDatetime: "2026-11-02T01:00:00+00:00", endDatetime: "2026-11-02T03:00:00+00:00" },
  });
});

test("[SPM-163] without an Idempotency-Key no key or hash is sent; the hash follows the request", async () => {
  supabase.rpc.mockResolvedValue({ data: result(), error: null });
  await waitlistModel.leaveWaitlist(21, 42);
  expect(supabase.rpc).toHaveBeenCalledWith("leave_event_waitlist", {
    p_attendee_id: 21,
    p_event_id: 42,
    p_idempotency_key: null,
    p_request_hash: null,
  });

  await waitlistModel.acceptOffer(21, 42, 5, "offer-key-001");
  await waitlistModel.acceptOffer(21, 42, 6, "offer-key-001");
  const [, first] = supabase.rpc.mock.calls[1];
  const [, second] = supabase.rpc.mock.calls[2];
  expect(first.p_offer_id).toBe(5);
  expect(first.p_request_hash).not.toBe(second.p_request_hash);
});

test("[SPM-163 AC6/AC7] accept and decline call their own functions", async () => {
  supabase.rpc.mockResolvedValue({ data: result({ registration_status: "REGISTERED", outcome: "ACCEPTED" }), error: null });
  await waitlistModel.acceptOffer(21, 42, 5);
  await waitlistModel.declineOffer(21, 42, 5);
  expect(supabase.rpc.mock.calls.map(([name]) => name)).toEqual(["accept_waitlist_offer", "decline_waitlist_offer"]);
});

test.each([...waitlistModel.REGISTRATION_ACTION_ERRORS])("[SPM-163] refusal %s becomes a RegistrationActionError", async (code) => {
  supabase.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: code } });
  await expect(waitlistModel.leaveWaitlist(21, 42)).rejects.toMatchObject({ name: "RegistrationActionError", code });
});

test("[SPM-163] other database failures stay internal errors", async () => {
  supabase.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });
  await expect(waitlistModel.leaveWaitlist(21, 42)).rejects.toThrow("[Supabase Error] permission denied");
  supabase.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "SOMETHING_ELSE" } });
  await expect(waitlistModel.leaveWaitlist(21, 42)).rejects.not.toMatchObject({ name: "RegistrationActionError" });
  supabase.rpc.mockResolvedValue({ data: {}, error: null });
  await expect(waitlistModel.leaveWaitlist(21, 42)).rejects.toThrow("leave_event_waitlist returned no registration.");
});

test("[SPM-163 AC3] findWaitlistPositions returns the attendee's own positions and open offers", async () => {
  supabase.rpc.mockResolvedValue({
    data: [
      { registration_id: 7, event_id: 42, waitlist_position: 1, offer_id: 3, offer_expires_at: "2026-10-31T01:00:00+00:00" },
      { registration_id: 8, event_id: 43, waitlist_position: 4, offer_id: null, offer_expires_at: null },
    ],
    error: null,
  });
  expect(await waitlistModel.findWaitlistPositions(21)).toEqual([
    { registrationId: 7, eventId: 42, waitlistPosition: 1, offer: { offerId: 3, expiresAt: "2026-10-31T01:00:00+00:00" } },
    { registrationId: 8, eventId: 43, waitlistPosition: 4, offer: null },
  ]);
  expect(supabase.rpc).toHaveBeenCalledWith("list_waitlist_positions", { p_attendee_id: 21 });
});

test("[SPM-163 AC7] expireDueWaitlistOffers passes the batch size and surfaces failures", async () => {
  supabase.rpc.mockResolvedValue({ data: 3, error: null });
  expect(await waitlistModel.expireDueWaitlistOffers(50)).toBe(3);
  expect(supabase.rpc).toHaveBeenCalledWith("expire_due_waitlist_offers", { p_limit: 50 });
  supabase.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
  await expect(waitlistModel.expireDueWaitlistOffers(50)).rejects.toThrow("[Supabase Error] down");
});
