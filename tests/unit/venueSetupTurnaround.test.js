jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));

const supabase = require("../../config/supabase");
const venueModel = require("../../model/venueModel");
const { buildVenueCalendar, AVAILABILITY } = require("../../model/venueConflictModel");

// SPM-185: setup and turnaround in conflict detection. Times are Singapore
// local (+08:00); Venue A has 30 minutes of setup and 45 of turnaround.
const at = (time, day = "2026-11-04") => new Date(`${day}T${time}:00+08:00`);
const NOW = at("08:00", "2026-11-01");
const WINDOW = { from: at("00:00"), to: at("00:00", "2026-11-07") };

const venueA = { operatingHours: "00:00-24:00", setupMinutes: 30, turnaroundMinutes: 45 };

const booking = (bookingId, start, end, { startDay, endDay } = {}) => ({
  bookingId,
  status: "APPROVED",
  start: at(start, startDay),
  end: at(end, endDay || startDay),
  eventId: 900 + bookingId,
  requestId: `REQ-000${900 + bookingId}`,
  eventTitle: null,
});

const check = (venue, bookings, start, end, { calendarEntries = [], startDay, endDay } = {}) =>
  buildVenueCalendar({
    venue,
    bookings,
    calendarEntries,
    ...WINDOW,
    now: NOW,
    requested: { start: at(start, startDay), end: at(end, endDay || startDay) },
  }).check;

const TURNAROUND_MESSAGE =
  "Venue's turnaround period (12:00pm–12:45pm) overlaps with your requested booking, including its 30-minute setup from 12:00pm.";

describe("occupied range (SPM-185 AC1, AC4)", () => {
  test("[SPM-185-TC1] should_show_a_10_to_12_booking_as_occupied_from_0930_to_1245", () => {
    const { entries } = buildVenueCalendar({ venue: venueA, bookings: [booking(1, "10:00", "12:00")], calendarEntries: [], ...WINDOW, now: NOW });

    expect(entries[0]).toMatchObject({
      start: at("10:00").toISOString(),
      end: at("12:00").toISOString(),
      occupiedStart: at("09:30").toISOString(),
      occupiedEnd: at("12:45").toISOString(),
    });
  });

  test("[SPM-185-TC4] should_reserve_0900_to_1215_and_refuse_a_request_whose_setup_starts_at_1130", () => {
    const result = check(venueA, [booking(1, "09:30", "11:30")], "12:00", "13:00");

    expect(result.canRequest).toBe(false);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        occupiedStart: at("09:00").toISOString(),
        occupiedEnd: at("12:15").toISOString(),
        message: "Venue's turnaround period (11:30am–12:15pm) overlaps with your requested booking, including its 30-minute setup from 11:30am.",
      }),
    ]);
  });
});

describe("conflict messages and boundaries (SPM-185 AC2, AC3)", () => {
  test("[SPM-185-TC2] should_refuse_1230_with_the_turnaround_message", () => {
    const result = check(venueA, [booking(1, "10:00", "12:00")], "12:30", "14:00");

    expect(result.canRequest).toBe(false);
    expect(result.availability).toBe(AVAILABILITY.UNAVAILABLE_BOOKING);
    expect(result.conflicts[0].message).toBe(TURNAROUND_MESSAGE);
  });

  test("[SPM-185-TC3] should_allow_a_request_starting_1315", () => {
    const result = check(venueA, [booking(1, "10:00", "12:00")], "13:15", "14:00");

    expect(result.occupiedStart).toBe(at("12:45").toISOString());
    expect(result.canRequest).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  test("[SPM-185-TC3] should_refuse_a_request_starting_1314", () => {
    const result = check(venueA, [booking(1, "10:00", "12:00")], "13:14", "14:00");

    expect(result.canRequest).toBe(false);
    expect(result.conflicts[0].message).toBe(
      "Venue's turnaround period (12:00pm–12:45pm) overlaps with your requested booking, including its 30-minute setup from 12:44pm."
    );
  });

  test("[SPM-185-AC2] should_name_the_next_bookings_setup_when_the_request_turnaround_reaches_it", () => {
    const result = check(venueA, [booking(1, "14:00", "15:00")], "11:00", "12:50");

    expect(result.conflicts[0].message).toBe(
      "Venue's setup period (1:30pm–2:00pm) overlaps with your requested booking, including its 45-minute turnaround until 1:35pm."
    );
  });

  test("[SPM-185-AC2] should_name_the_booking_itself_when_the_windows_overlap", () => {
    const result = check(venueA, [booking(1, "10:00", "12:00")], "11:00", "11:30");

    expect(result.conflicts[0].message).toBe(
      "Venue's booking (10:00am–12:00pm) overlaps with your requested booking, including its 30-minute setup from 10:30am and its 45-minute turnaround until 12:15pm."
    );
  });

  test("[SPM-185-TC9] should_block_a_request_with_an_active_holds_turnaround", () => {
    const heldUntil = { start: at("10:00"), end: at("12:00"), occupiedStart: at("09:30"), occupiedEnd: at("12:45") };
    const hold = { id: "h1", type: "HOLD", status: "ACTIVE", eventId: 77, holdExpiresAt: at("08:00", "2026-11-03"), ...heldUntil };

    const result = check(venueA, [], "12:30", "14:00", { calendarEntries: [hold] });

    expect(result.availability).toBe(AVAILABILITY.UNAVAILABLE_HOLD);
    expect(result.conflicts[0].message).toBe(TURNAROUND_MESSAGE);
  });
});

describe("zero buffers (SPM-185 AC5, TC6)", () => {
  const venueZero = { ...venueA, setupMinutes: 0, turnaroundMinutes: 0 };

  test("[SPM-185-TC6] should_allow_back_to_back_bookings_at_a_0_0_venue", () => {
    const result = check(venueZero, [booking(1, "10:00", "12:00")], "12:00", "14:00");

    expect(result.canRequest).toBe(true);
    expect(result.occupiedStart).toBe(at("12:00").toISOString());
  });

  test("[SPM-185-TC6] should_still_refuse_one_minute_of_overlap_at_a_0_0_venue", () => {
    const result = check(venueZero, [booking(1, "10:00", "12:00")], "11:59", "14:00");

    expect(result.conflicts[0].message).toBe("Venue's booking (10:00am–12:00pm) overlaps with your requested booking.");
  });
});

describe("multi-day events (SPM-185 AC6, TC7)", () => {
  const twoDays = booking(1, "09:00", "18:00", { startDay: "2026-11-04", endDay: "2026-11-05" });

  test("[SPM-185-TC7] should_block_from_day_one_start_less_setup_to_day_two_end_plus_turnaround", () => {
    const { entries } = buildVenueCalendar({ venue: venueA, bookings: [twoDays], calendarEntries: [], ...WINDOW, now: NOW });

    expect(entries[0]).toMatchObject({
      occupiedStart: at("08:30", "2026-11-04").toISOString(),
      occupiedEnd: at("18:45", "2026-11-05").toISOString(),
    });
  });

  test("[SPM-185-TC7] should_refuse_a_request_on_the_night_between_and_date_the_message", () => {
    const result = check(venueA, [twoDays], "23:00", "23:30", { startDay: "2026-11-04" });

    expect(result.conflicts[0].message).toBe(
      "Venue's booking (9:00am–5 Nov 2026, 6:00pm) overlaps with your requested booking, "
      + "including its 30-minute setup from 10:30pm and its 45-minute turnaround until 5 Nov 2026, 12:15am."
    );
  });

  test.each([
    ["19:14", false],
    ["19:15", true],
  ])("[SPM-185-TC7] should_treat_a_day_two_request_starting_%s_as_allowed_%s", (start, allowed) => {
    expect(check(venueA, [twoDays], start, "20:00", { startDay: "2026-11-05" }).canRequest).toBe(allowed);
  });
});

describe("multi-venue events (SPM-185 AC8, TC10)", () => {
  // Hall A (30/45) is booked 10:00-12:00 and Room B (15/15) 13:00-15:00.
  const hallA = venueA;
  const roomB = { ...venueA, setupMinutes: 15, turnaroundMinutes: 15 };

  test("[SPM-185-TC10] should_check_each_venue_with_its_own_booking_and_minutes", () => {
    expect(check(hallA, [booking(1, "10:00", "12:00")], "13:00", "14:00").canRequest).toBe(false);
    expect(check(hallA, [booking(1, "10:00", "12:00")], "13:15", "14:00").canRequest).toBe(true);

    const roomResult = check(roomB, [booking(2, "13:00", "15:00")], "15:20", "16:00");
    expect(roomResult.canRequest).toBe(false);
    expect(roomResult.conflicts[0].message).toBe(
      "Venue's turnaround period (3:00pm–3:15pm) overlaps with your requested booking, including its 15-minute setup from 3:05pm."
    );
    expect(check(roomB, [booking(2, "13:00", "15:00")], "15:30", "16:00").canRequest).toBe(true);
  });
});

describe("database conflicts (SPM-185 AC7)", () => {
  test("[SPM-185-TC8] should_turn_an_exclusion_violation_into_VENUE_BOOKING_CONFLICT", async () => {
    supabase.rpc.mockResolvedValue({
      data: null,
      error: { code: "23P01", message: 'conflicting key value violates exclusion constraint "venue_booking_no_overlap"' },
    });

    await expect(venueModel.createVenue(1, {})).rejects.toMatchObject({ name: "VenueError", code: "VENUE_BOOKING_CONFLICT" });
  });
});
