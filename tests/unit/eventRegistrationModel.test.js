// SPM-134 registerForEvent: maps register_for_event's result and refusals.
// Only the Supabase client is mocked.
jest.mock("../../config/supabase", () => ({ rpc: jest.fn(), from: jest.fn() }));

const supabase = require("../../config/supabase");
const { registerForEvent, toConfirmationNumber } = require("../../model/registrationModel");

const ROW = {
  registration: {
    registration_id: 42,
    registration_status: "REGISTERED",
    registration_datetime: "2026-10-29T01:00:00+00:00",
    dietary_restrictions: "Vegetarian, no peanuts",
    accessibility_requirements: null,
  },
  event: {
    event_id: 7,
    title: "Synthetic Forum",
    start_datetime: "2026-11-05T01:00:00+00:00",
    end_datetime: "2026-11-05T03:00:00+00:00",
    organisation_name: "Synthetic Organisation",
  },
  replayed: false,
};
const ANSWERS = { dietaryRestrictions: "Vegetarian, no peanuts", accessibilityRequirements: null };

beforeEach(() => jest.clearAllMocks());

describe("registerForEvent (SPM-134)", () => {
  test("[SPM-134] should_return_the_confirmation_from_the_committed_registration_when_it_succeeds", async () => {
    supabase.rpc.mockResolvedValue({ data: ROW, error: null });
    await expect(registerForEvent(21, 7, ANSWERS)).resolves.toEqual({
      replayed: false,
      registration: {
        registrationId: 42,
        confirmationNumber: "REG-000042",
        status: "REGISTERED",
        registeredAt: "2026-10-29T01:00:00+00:00",
        dietaryRestrictions: "Vegetarian, no peanuts",
        accessibilityRequirements: null,
        event: {
          eventId: 7,
          title: "Synthetic Forum",
          startDatetime: "2026-11-05T01:00:00+00:00",
          endDatetime: "2026-11-05T03:00:00+00:00",
          organisationName: "Synthetic Organisation",
        },
      },
    });
  });

  test("[SPM-134] should_send_only_the_trusted_attendee_event_and_answers_when_there_is_no_key", async () => {
    supabase.rpc.mockResolvedValue({ data: ROW, error: null });
    await registerForEvent(21, 7, ANSWERS);
    expect(supabase.rpc).toHaveBeenCalledWith("register_for_event", {
      p_attendee_id: 21,
      p_event_id: 7,
      p_dietary_restrictions: "Vegetarian, no peanuts",
      p_accessibility_requirements: null,
      p_idempotency_key: null,
      p_request_hash: null,
    });
  });

  test("[SPM-134] should_hash_the_answers_and_event_when_an_idempotency_key_is_sent", async () => {
    supabase.rpc.mockResolvedValue({ data: { ...ROW, replayed: true }, error: null });
    const first = await registerForEvent(21, 7, ANSWERS, "spm134-key-0001");
    const firstHash = supabase.rpc.mock.calls[0][1].p_request_hash;
    await registerForEvent(21, 8, ANSWERS, "spm134-key-0001");
    expect(first.replayed).toBe(true);
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
    expect(supabase.rpc.mock.calls[1][1].p_request_hash).not.toBe(firstHash);
  });

  test.each([
    "EVENT_NOT_FOUND", "NOT_ATTENDEE", "ALREADY_REGISTERED", "ALREADY_WAITLISTED", "REGISTRATION_NOT_ENABLED",
    "REGISTRATION_CLOSED", "REGISTRATION_FULL", "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS",
  ])("[SPM-134] should_map_the_database_refusal_%s_to_a_registration_error", async (code) => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: code } });
    await expect(registerForEvent(21, 7, ANSWERS)).rejects.toMatchObject({ name: "RegistrationError", code });
  });

  test("[SPM-134] should_throw_an_unexpected_error_when_the_database_fails_or_returns_nothing", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "violates check constraint" } });
    await expect(registerForEvent(21, 7, ANSWERS)).rejects.toThrow("[Supabase Error] violates check constraint");
    supabase.rpc.mockResolvedValue({ data: { registration: ROW.registration }, error: null });
    await expect(registerForEvent(21, 7, ANSWERS)).rejects.toThrow("returned no registration");
  });

  test("[SPM-134] should_pad_the_confirmation_number_from_the_registration_id", () => {
    expect([toConfirmationNumber(5), toConfirmationNumber(1234567)]).toEqual(["REG-000005", "REG-1234567"]);
  });
});
