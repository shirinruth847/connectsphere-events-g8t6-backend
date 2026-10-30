const { validateVenueBookingRequest, BOOKING_MESSAGES } = require("../../validators/venueBookingValidator");

const NOW = new Date("2030-03-01T00:00:00Z");
const EVENT = { start_datetime: "2030-03-10T01:00:00+00:00", end_datetime: "2030-03-10T09:00:00+00:00" };
const item = (overrides = {}) => ({
  venueId: 7,
  label: "Main hall",
  start: "2030-03-10T10:00:00+08:00",
  end: "2030-03-10T12:00:00+08:00",
  expectedAttendance: 150,
  layout: "Theatre",
  ...overrides,
});
const validate = (bookings, now = NOW) => validateVenueBookingRequest({ bookings }, { event: EVENT, now });

describe("validateVenueBookingRequest (SPM-179 AC3-AC5)", () => {
  test("[SPM-179-TC-01] should_normalise_a_valid_request", () => {
    const { bookings, fields } = validate([item({ label: "  Main hall ", accessibilityNeeds: ["Ramp", "ramp ", "Lift"], specialRequirements: " Vegetarian catering " })]);
    expect(fields).toBeUndefined();
    expect(bookings).toEqual([expect.objectContaining({
      label: "Main hall",
      start: "2030-03-10T02:00:00.000Z",
      accessibilityNeeds: ["Ramp", "Lift"],
      specialRequirements: "Vegetarian catering",
      isPrimary: false,
    })]);
  });

  test("[SPM-179-AC3] should_tell_special_requirements_that_are_not_text_from_ones_too_long", async () => {
    expect(validate([item({ specialRequirements: 5 })]).fields)
      .toEqual({ "bookings.0.specialRequirements": BOOKING_MESSAGES.specialInvalid });
    expect(validate([item({ specialRequirements: "x".repeat(2001) })]).fields)
      .toEqual({ "bookings.0.specialRequirements": BOOKING_MESSAGES.specialTooLong });
  });

  test("[SPM-179-TC-05] should_refuse_an_end_before_the_start_and_a_start_in_the_past", () => {
    expect(validate([item({ start: "2030-03-10T10:00:00+08:00", end: "2030-03-10T10:00:00+08:00" })]).fields)
      .toEqual({ "bookings.0.end": BOOKING_MESSAGES.endBeforeStart });
    expect(validate([item()], new Date("2030-03-10T03:00:00Z")).fields)
      .toEqual({ "bookings.0.start": BOOKING_MESSAGES.startInPast });
  });

  test("[SPM-179-AC5] should_tell_a_missing_time_from_one_without_a_time_zone", () => {
    const { fields } = validate([item({ start: undefined, end: "2030-03-10T12:00" })]);
    expect(fields["bookings.0.start"]).toBe(BOOKING_MESSAGES.startRequired);
    expect(fields["bookings.0.end"]).toBe(BOOKING_MESSAGES.timeInvalid);
  });

  test("[SPM-179-TC-04] should_keep_each_booking_within_the_event", () => {
    expect(validate([item({ start: "2030-03-10T08:30:00+08:00" })]).fields)
      .toEqual({ "bookings.0.start": BOOKING_MESSAGES.outsideEvent });
    expect(validate([item({ start: "2030-03-10T09:00:00+08:00", end: "2030-03-10T17:00:00+08:00" })]).fields).toBeUndefined();
  });

  test("[SPM-179-TC-06] should_accept_only_whole_attendance_of_1_or_more", () => {
    for (const value of [0, -5, 1.5, "ten"]) {
      expect(validate([item({ expectedAttendance: value })]).fields)
        .toEqual({ "bookings.0.expectedAttendance": BOOKING_MESSAGES.attendanceInvalid });
    }
    expect(validate([item({ expectedAttendance: 1 })]).fields).toBeUndefined();
  });

  test("[SPM-179-TC-08] should_refuse_the_same_venue_twice_and_two_primaries", () => {
    expect(validate([item({ isPrimary: true }), item({ isPrimary: true })]).fields).toEqual({
      "bookings.1.venueId": BOOKING_MESSAGES.venueTwice,
      "bookings.primary": BOOKING_MESSAGES.onePrimary,
    });
  });

  test("[SPM-179-AC5] should_report_every_section's_errors_in_request_order", () => {
    const { fields } = validate([
      item({ venueId: 0, label: " ", end: "2030-03-10T09:00:00+08:00", expectedAttendance: "ten", isPrimary: "yes" }),
      "not an object",
      item({ venueId: 7, start: "2030-03-10T08:00:00+08:00", layout: "", accessibilityNeeds: "Ramp", specialRequirements: 5, isPrimary: true }),
      item({ venueId: 8, start: "2030-03-10T10:00", end: undefined, expectedAttendance: null, requiredFacilities: [" "], isPrimary: true, id: 3 }),
    ]);
    expect(Object.entries(fields)).toEqual([
      ["bookings.0.venueId", BOOKING_MESSAGES.venueRequired],
      ["bookings.0.label", BOOKING_MESSAGES.labelRequired],
      ["bookings.0.end", BOOKING_MESSAGES.endBeforeStart],
      ["bookings.0.expectedAttendance", BOOKING_MESSAGES.attendanceInvalid],
      ["bookings.0.isPrimary", BOOKING_MESSAGES.primaryInvalid],
      ["bookings.1", "Each venue must be an object."],
      ["bookings.2.start", BOOKING_MESSAGES.outsideEvent],
      ["bookings.2.layout", BOOKING_MESSAGES.layoutRequired],
      ["bookings.2.accessibilityNeeds", BOOKING_MESSAGES.listInvalid],
      ["bookings.2.specialRequirements", BOOKING_MESSAGES.specialInvalid],
      ["bookings.3.id", "This field cannot be set."],
      ["bookings.3.start", BOOKING_MESSAGES.timeInvalid],
      ["bookings.3.end", BOOKING_MESSAGES.endRequired],
      ["bookings.3.expectedAttendance", BOOKING_MESSAGES.attendanceRequired],
      ["bookings.3.requiredFacilities", BOOKING_MESSAGES.listInvalid],
      ["bookings.primary", BOOKING_MESSAGES.onePrimary],
    ]);
  });

  test("[SPM-179-AC3] should_refuse_server_controlled_fields_and_bound_every_list", () => {
    const { fields } = validate([item({ status: "APPROVED", requiredFacilities: Array(21).fill("x"), layout: "x".repeat(51) })]);
    expect(fields).toEqual({
      "bookings.0.status": "This field cannot be set.",
      "bookings.0.requiredFacilities": BOOKING_MESSAGES.listInvalid,
      "bookings.0.layout": BOOKING_MESSAGES.layoutTooLong,
    });
    expect(validateVenueBookingRequest({ bookings: [], eventId: 9 }, { event: EVENT, now: NOW }).fields).toEqual({
      eventId: "This field cannot be set.",
      bookings: "Add between 1 and 10 venues.",
    });
    expect(validateVenueBookingRequest([item()], { event: EVENT, now: NOW }).fields).toEqual({
      body: "Send a JSON object with a bookings list.",
    });
  });
});
