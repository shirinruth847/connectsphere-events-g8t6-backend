jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));

const supabase = require("../../config/supabase");
const { validateRequirements, MESSAGES } = require("../../validators/eventValidator");
const eventModel = require("../../model/eventModel");

const START = "2026-12-01T09:00:00+08:00";
const END = "2026-12-01T18:00:00+08:00";
const choice = (venueId, requestedStart, requestedEnd) => ({ venueId, requestedStart, requestedEnd });

describe("venue choice times (SPM-76 AC4, AC5)", () => {
  test("[SPM-76-TC1] should_accept_whole_event_and_narrowed_choices_together", () => {
    const errors = validateRequirements({
      startDatetime: START,
      endDatetime: END,
      venuePreferences: [1, choice(2, "2026-12-01T13:00:00+08:00", "2026-12-01T15:00:00+08:00"), choice(3)],
    });
    expect(errors).toEqual({});
  });

  test("[SPM-76-TC2] should_refuse_a_time_outside_the_event_when_the_dates_are_sent", () => {
    const errors = validateRequirements({
      startDatetime: START,
      endDatetime: END,
      venuePreferences: [choice(1, "2026-12-01T09:00:00+08:00", "2026-12-01T19:00:00+08:00")],
    });
    expect(errors.venuePreferences).toBe(MESSAGES.venuePreferenceOutsideEvent);
  });

  test.each([
    ["only a start", choice(1, "2026-12-01T10:00:00+08:00")],
    ["an end before the start", choice(1, "2026-12-01T12:00:00+08:00", "2026-12-01T10:00:00+08:00")],
    ["seconds", choice(1, "2026-12-01T10:00:30+08:00", "2026-12-01T12:00:00+08:00")],
    ["no time zone", choice(1, "2026-12-01T10:00:00", "2026-12-01T12:00:00")],
  ])("should_refuse_a_time_with_%s", (_label, item) => {
    expect(validateRequirements({ venuePreferences: [item] }).venuePreferences).toBe(MESSAGES.venuePreferenceTimeInvalid);
  });

  test("should_refuse_unknown_keys_and_duplicate_venues", () => {
    expect(validateRequirements({ venuePreferences: [{ venueId: 1, bookingId: 4 }] }).venuePreferences).toBe(MESSAGES.venuePreferencesInvalid);
    expect(validateRequirements({ venuePreferences: [1, choice(1)] }).venuePreferences).toBe(MESSAGES.venuePreferencesInvalid);
  });

  test("should_send_narrowed_choices_as_objects_and_whole_event_choices_as_ids", () => {
    const payload = eventModel.toRequirementPayload({
      venuePreferences: ["4", choice(2, "2026-12-01T13:00:00+08:00", "2026-12-01T15:00:00+08:00"), choice("3")],
    });
    expect(payload.venuePreferences).toEqual([
      4,
      { venue_id: 2, requested_start: "2026-12-01T13:00:00+08:00", requested_end: "2026-12-01T15:00:00+08:00" },
      3,
    ]);
  });

  test("[SPM-76-AC7] should_return_each_choice_with_its_time_in_rank_order", () => {
    const api = eventModel.toApi({
      event_id: 9,
      status: "DRAFT",
      event_venue_preference: [
        { venue_id: 2, preference_order: 2, requested_start: "2026-12-01T05:00:00+00:00", requested_end: "2026-12-01T07:00:00+00:00" },
        { venue_id: 1, preference_order: 1, requested_start: null, requested_end: null },
      ],
    });
    expect(api.venuePreferences).toEqual([1, 2]);
    expect(api.venuePreferenceTimes).toEqual([
      { venueId: 1, requestedStart: null, requestedEnd: null },
      { venueId: 2, requestedStart: "2026-12-01T05:00:00.000Z", requestedEnd: "2026-12-01T07:00:00.000Z" },
    ]);
  });

  test("[SPM-76-AC8] should_report_a_time_outside_the_saved_event_against_the_choices", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "VENUE_PREFERENCE_OUTSIDE_EVENT" } });

    await expect(eventModel.saveDraft({ organiserId: 9, eventId: 7, input: { endDatetime: "2026-12-01T16:00:00+08:00" } }))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", fields: { venuePreferences: MESSAGES.venuePreferenceOutsideEvent } });
  });
});
