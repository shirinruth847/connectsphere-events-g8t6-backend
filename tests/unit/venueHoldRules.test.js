// SPM-190 pure rules: the hold request validator and the expiry maths
// (Master 5.4.3). No database or MongoDB.
const {
  validateHoldRequest,
  validateHoldDecline,
  validateHoldExtension,
  validateEmptyBody,
  parseHoldId,
  HOLD_MESSAGES,
} = require("../../validators/venueHoldValidator");
const { holdExpiryFor, extendedHoldExpiry, holdCutoff } = require("../../model/venueConflictModel");

const NOW = new Date("2030-03-01T00:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const event = { start_datetime: "2030-03-10T01:00:00+00:00", end_datetime: "2030-03-12T09:00:00+00:00" };
const body = (overrides = {}) => ({
  venueId: 7,
  label: "Main hall",
  start: "2030-03-10T10:00:00+08:00",
  end: "2030-03-10T12:00:00+08:00",
  expectedAttendance: 120,
  note: "Keynote rehearsal",
  ...overrides,
});

describe("validateHoldRequest (SPM-190 AC1)", () => {
  test("[SPM-190-AC1] should_accept_a_window_inside_the_event", () => {
    const { values, fields } = validateHoldRequest(body(), { event, now: NOW });

    expect(fields).toBeUndefined();
    expect(values).toEqual({
      venueId: 7,
      label: "Main hall",
      start: "2030-03-10T02:00:00.000Z",
      end: "2030-03-10T04:00:00.000Z",
      expectedAttendance: 120,
      note: "Keynote rehearsal",
    });
  });

  test("should_treat_attendance_and_note_as_optional", () => {
    const { values } = validateHoldRequest(body({ expectedAttendance: null, note: "   " }), { event, now: NOW });

    expect(values).toMatchObject({ expectedAttendance: null, note: null });
  });

  test.each([
    ["before the event", { start: "2030-03-10T00:00:00+00:00" }, "start", HOLD_MESSAGES.outsideEvent],
    ["after the event", { end: "2030-03-12T10:00:00+00:00" }, "start", HOLD_MESSAGES.outsideEvent],
    ["ending before it starts", { end: "2030-03-10T09:00:00+08:00" }, "end", HOLD_MESSAGES.endBeforeStart],
    ["without a zone", { start: "2030-03-10T10:00:00" }, "start", HOLD_MESSAGES.start],
    ["with no venue", { venueId: "7" }, "venueId", HOLD_MESSAGES.venueId],
    ["with an empty label", { label: "  " }, "label", HOLD_MESSAGES.label],
    ["with a label that is too long", { label: "x".repeat(101) }, "label", HOLD_MESSAGES.label],
    ["with zero attendance", { expectedAttendance: 0 }, "expectedAttendance", HOLD_MESSAGES.attendance],
    ["with a note that is too long", { note: "x".repeat(501) }, "note", HOLD_MESSAGES.note],
  ])("[SPM-190-TC] should_refuse_a_window_%s", (_name, overrides, field, message) => {
    const { values, fields } = validateHoldRequest(body(overrides), { event, now: NOW });

    expect(values).toBeUndefined();
    expect(fields[field]).toBe(message);
  });

  test("should_refuse_a_start_in_the_past", () => {
    const { fields } = validateHoldRequest(body(), { event, now: new Date("2030-03-11T00:00:00Z") });

    expect(fields.start).toBe(HOLD_MESSAGES.startInPast);
  });

  test("should_refuse_server_controlled_fields", () => {
    const { fields } = validateHoldRequest(body({ expiresAt: "2030-03-09T00:00:00Z", status: "PLACED" }), { event, now: NOW });

    expect(fields).toEqual({ expiresAt: HOLD_MESSAGES.unknown, status: HOLD_MESSAGES.unknown });
  });

  test("should_refuse_a_body_that_is_not_an_object", () => {
    expect(validateHoldRequest([], { event, now: NOW }).fields).toHaveProperty("body");
  });
});

describe("decline, extend and bodiless actions", () => {
  test("should_require_a_decline_reason_of_1_to_1000_characters", () => {
    expect(validateHoldDecline({ reason: "  Room is reserved for exams " }).values).toEqual({ reason: "Room is reserved for exams" });
    expect(validateHoldDecline({ reason: "" }).fields.reason).toBe(HOLD_MESSAGES.reason);
    expect(validateHoldDecline({ reason: "x".repeat(1001) }).fields.reason).toBe(HOLD_MESSAGES.reason);
    expect(validateHoldDecline({}).fields.reason).toBe(HOLD_MESSAGES.reason);
  });

  test.each([1, 7])("[SPM-190-AC6] should_accept_an_extension_of_%i_days", (days) => {
    expect(validateHoldExtension({ days }).values).toEqual({ days });
  });

  test.each([0, 8, 2.5, "3", null])("[SPM-190-AC6] should_refuse_an_extension_of_%p_days", (days) => {
    expect(validateHoldExtension({ days }).fields.days).toBe(HOLD_MESSAGES.days);
  });

  test("should_accept_no_body_or_an_empty_object_only", () => {
    expect(validateEmptyBody(undefined)).toEqual({});
    expect(validateEmptyBody({})).toEqual({});
    expect(validateEmptyBody({ force: true }).fields).toEqual({ force: HOLD_MESSAGES.unknown });
    expect(validateEmptyBody("yes").fields).toHaveProperty("body");
  });

  test("should_accept_only_24_hex_hold_ids", () => {
    expect(parseHoldId("a".repeat(24))).toBe("a".repeat(24));
    expect(parseHoldId("A".repeat(24))).toBeNull();
    expect(parseHoldId("a".repeat(23))).toBeNull();
  });
});

describe("hold expiry (Master 5.4.3)", () => {
  test("[SPM-190-AC2] should_last_7_days_when_setup_is_far_off", () => {
    const occupiedStart = new Date(NOW.getTime() + 30 * DAY);

    expect(holdExpiryFor(occupiedStart, NOW).toISOString()).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
  });

  test("[SPM-190-AC2] should_end_24_hours_before_setup_when_that_is_sooner", () => {
    const occupiedStart = new Date(NOW.getTime() + 3 * DAY);

    expect(holdExpiryFor(occupiedStart, NOW).toISOString()).toBe(new Date(NOW.getTime() + 2 * DAY).toISOString());
  });

  test.each([
    ["exactly 24 hours away", 24 * HOUR],
    ["12 hours away", 12 * HOUR],
  ])("[SPM-190-AC3] should_allow_no_hold_when_setup_is_%s", (_name, offset) => {
    expect(holdExpiryFor(new Date(NOW.getTime() + offset), NOW)).toBeNull();
  });

  test("should_allow_a_hold_just_over_24_hours_before_setup", () => {
    const occupiedStart = new Date(NOW.getTime() + 24 * HOUR + 60 * 1000);

    expect(holdExpiryFor(occupiedStart, NOW).toISOString()).toBe(new Date(NOW.getTime() + 60 * 1000).toISOString());
  });

  test("[SPM-190-AC6] should_extend_within_the_cutoff_and_refuse_past_it", () => {
    const hold = { holdExpiresAt: new Date(NOW.getTime() + 7 * DAY), occupiedStart: new Date(NOW.getTime() + 12 * DAY) };

    expect(extendedHoldExpiry(hold, 4).toISOString()).toBe(new Date(NOW.getTime() + 11 * DAY).toISOString());
    expect(extendedHoldExpiry(hold, 5)).toBeNull();
    expect(holdCutoff(hold.occupiedStart).toISOString()).toBe(new Date(NOW.getTime() + 11 * DAY).toISOString());
  });
});
