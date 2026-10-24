const {
  overlaps,
  occupiedRange,
  isHoldActive,
  parseOperatingHours,
  operatingHoursWarning,
  buildVenueCalendar,
  AVAILABILITY,
} = require("../../model/venueConflictModel");

// Times are Singapore local (+08:00), matching the SPM-74 test cases.
const at = (time, day = "2026-11-04") => new Date(`${day}T${time}:00+08:00`);
const NOW = at("08:00", "2026-11-01");
const DAY = { from: at("00:00"), to: at("00:00", "2026-11-05") };

const venue = (extra = {}) => ({ operatingHours: "08:00-22:00", setupMinutes: 30, turnaroundMinutes: 45, ...extra });

const booking = (bookingId, start, end, status = "APPROVED") => ({
  bookingId,
  status,
  start: at(start),
  end: at(end),
  eventId: 442,
  requestId: "REQ-000442",
  eventTitle: null,
});

const hold = (id, start, end, holdExpiresAt, extra = {}) => ({
  id,
  type: "HOLD",
  status: "ACTIVE",
  start: at(start),
  end: at(end),
  occupiedStart: at(start),
  occupiedEnd: at(end),
  eventId: 500,
  requestId: "REQ-000500",
  holdExpiresAt,
  reason: null,
  note: null,
  ...extra,
});

const block = (id, start, end, extra = {}) => ({
  id,
  type: "BLOCK",
  status: "ACTIVE",
  start: at(start),
  end: at(end),
  occupiedStart: at(start),
  occupiedEnd: at(end),
  eventId: null,
  holdExpiresAt: null,
  reason: "MAINTENANCE",
  note: "Air-conditioning service",
  ...extra,
});

const calendar = ({ bookings = [], calendarEntries = [], requested = null, venueOverrides = {} } = {}) =>
  buildVenueCalendar({ venue: venue(venueOverrides), bookings, calendarEntries, ...DAY, now: NOW, requested });

describe("half-open ranges (Master 5.4)", () => {
  test("[SPM-74-TC5] adjacent ranges do not overlap", () => {
    expect(overlaps({ start: at("14:00"), end: at("16:00") }, { start: at("16:00"), end: at("17:00") })).toBe(false);
  });

  test("[SPM-74-AC] a one-second overlap is a conflict", () => {
    const end = new Date(at("16:00").getTime() + 1000);
    expect(overlaps({ start: at("14:00"), end }, { start: at("16:00"), end: at("17:00") })).toBe(true);
  });

  test("[SPM-74-TC3] occupied range adds setup before and turnaround after", () => {
    const range = occupiedRange(at("10:00"), at("12:00"), 30, 45);
    expect(range).toEqual({ start: at("09:30"), end: at("12:45") });
  });
});

describe("buildVenueCalendar (SPM-74)", () => {
  test("[SPM-74-TC1][TC14] a venue with no entries is available for the whole range", () => {
    const result = calendar();

    expect(result.entries).toEqual([]);
    expect(result.summary).toBe(AVAILABILITY.AVAILABLE);
    expect(result.summaryLabel).toBe("Available");
    expect(result.freePeriods).toEqual([{ start: DAY.from.toISOString(), end: DAY.to.toISOString() }]);
  });

  test("[SPM-74-TC2] a confirmed booking is shown as unavailable with its references", () => {
    const result = calendar({ bookings: [booking(110, "10:00", "12:00")] });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      type: "BOOKING",
      label: "Confirmed booking",
      blocking: true,
      bookingId: 110,
      requestId: "REQ-000442",
    });
    expect(result.summary).toBe(AVAILABILITY.UNAVAILABLE_BOOKING);
  });

  test("[SPM-74-TC3] the occupied period includes setup and turnaround; 12:45 is allowed and 12:44 is not", () => {
    const existing = [booking(110, "10:00", "12:00")];

    const entry = calendar({ bookings: existing }).entries[0];
    expect(entry.occupiedStart).toBe(at("09:30").toISOString());
    expect(entry.occupiedEnd).toBe(at("12:45").toISOString());

    // The requested period's own setup (30 min) is added too, so it is asked
    // with the setup already accounted for: occupied range starts at 12:45 / 12:44.
    const adjacent = calendar({ bookings: existing, requested: { start: at("13:15"), end: at("14:00") } }).check;
    expect(adjacent.occupiedStart).toBe(at("12:45").toISOString());
    expect(adjacent.canRequest).toBe(true);
    expect(adjacent.availability).toBe(AVAILABILITY.AVAILABLE);

    const overlapping = calendar({ bookings: existing, requested: { start: at("13:14"), end: at("14:00") } }).check;
    expect(overlapping.occupiedStart).toBe(at("12:44").toISOString());
    expect(overlapping.canRequest).toBe(false);
    expect(overlapping.availability).toBe(AVAILABILITY.UNAVAILABLE_BOOKING);
    expect(overlapping.conflicts).toEqual([expect.objectContaining({ entryId: "booking-110", type: "BOOKING" })]);
  });

  test("[SPM-74-TC3] a request whose occupied period starts at 12:45 is adjacent; 12:44 overlaps", () => {
    // Venue without buffers, holding a booking already occupying 09:30–12:45.
    const noBuffers = { setupMinutes: 0, turnaroundMinutes: 0 };
    const existing = [booking(110, "09:30", "12:45")];

    expect(calendar({ bookings: existing, requested: { start: at("12:45"), end: at("14:00") }, venueOverrides: noBuffers }).check.canRequest).toBe(true);
    expect(calendar({ bookings: existing, requested: { start: at("12:44"), end: at("14:00") }, venueOverrides: noBuffers }).check.canRequest).toBe(false);
  });

  test("[SPM-74-TC4] a request from 15:59 overlaps a 14:00–16:00 booking", () => {
    const result = calendar({
      bookings: [booking(120, "14:00", "16:00")],
      requested: { start: at("15:59"), end: at("17:00") },
      venueOverrides: { setupMinutes: 0, turnaroundMinutes: 0 },
    });

    expect(result.check.canRequest).toBe(false);
    expect(result.check.conflicts[0]).toMatchObject({
      occupiedStart: at("14:00").toISOString(),
      occupiedEnd: at("16:00").toISOString(),
    });
  });

  test("[SPM-74-TC5] a request starting exactly when the occupied period ends is allowed", () => {
    const result = calendar({
      bookings: [booking(120, "14:00", "16:00")],
      requested: { start: at("16:00"), end: at("17:00") },
      venueOverrides: { setupMinutes: 0, turnaroundMinutes: 0 },
    });

    expect(result.check.canRequest).toBe(true);
    expect(result.check.conflicts).toEqual([]);
  });

  test("[SPM-74-TC6] an active hold is distinct, unavailable and shows its expiry", () => {
    const expires = at("09:00", "2026-11-02");
    const result = calendar({ calendarEntries: [hold("h1", "10:00", "12:00", expires)] });

    expect(result.entries[0]).toMatchObject({ type: "HOLD", label: "Active hold", blocking: true, holdExpiresAt: expires.toISOString() });
    expect(result.summary).toBe(AVAILABILITY.UNAVAILABLE_HOLD);
  });

  test("[SPM-74-TC7] an expired hold is shown as expired and never blocks, even if not yet marked", () => {
    const expired = hold("h2", "10:00", "12:00", at("07:00", "2026-11-01"));
    expect(isHoldActive(expired, NOW)).toBe(false);

    const result = calendar({ calendarEntries: [expired], requested: { start: at("10:00"), end: at("11:00") } });

    expect(result.entries[0]).toMatchObject({ type: "HOLD", status: "EXPIRED", label: "Expired hold", blocking: false });
    expect(result.summary).toBe(AVAILABILITY.AVAILABLE);
    expect(result.check.canRequest).toBe(true);
  });

  test("[SPM-74-TC8] a block shows its reason and note", () => {
    const result = calendar({ calendarEntries: [block("b1", "08:00", "18:00")] });

    expect(result.entries[0]).toMatchObject({
      type: "BLOCK",
      label: "Operational block",
      reasonLabel: "Maintenance",
      note: "Air-conditioning service",
      blocking: true,
    });
    expect(result.summary).toBe(AVAILABILITY.UNAVAILABLE_BLOCK);
  });

  test("[SPM-74-TC9] a request overlapping a 09:00–13:00 block cannot proceed", () => {
    const result = calendar({
      calendarEntries: [block("b1", "09:00", "13:00")],
      requested: { start: at("12:00"), end: at("14:00") },
      venueOverrides: { setupMinutes: 0, turnaroundMinutes: 0 },
    });

    expect(result.check.availability).toBe(AVAILABILITY.UNAVAILABLE_BLOCK);
    expect(result.check.canRequest).toBe(false);
  });

  test("[SPM-74-TC10] an occupied period before opening is a warning, not a block", () => {
    const result = calendar({
      bookings: [booking(130, "08:30", "10:00")],
      requested: { start: at("08:30"), end: at("09:30", "2026-11-05") },
      venueOverrides: { operatingHours: "09:00-18:00", setupMinutes: 0, turnaroundMinutes: 0 },
    });

    expect(result.entries[0].operatingHoursWarning.message).toContain("08:30–09:00");
    const quiet = calendar({
      requested: { start: at("08:30"), end: at("10:00") },
      venueOverrides: { operatingHours: "09:00-18:00", setupMinutes: 0, turnaroundMinutes: 0 },
    }).check;
    expect(quiet.availability).toBe(AVAILABILITY.AVAILABLE_WITH_WARNING);
    expect(quiet.canRequest).toBe(true);
    expect(quiet.operatingHoursWarning.outside).toEqual([{ start: at("08:30").toISOString(), end: at("09:00").toISOString() }]);
  });

  test("[SPM-74-AC] overlapping bookings, holds and blocks are identified", () => {
    const result = calendar({
      bookings: [booking(110, "10:00", "12:00")],
      calendarEntries: [block("b1", "11:00", "13:00"), hold("h1", "16:00", "17:00", at("09:00", "2026-11-02"))],
      venueOverrides: { setupMinutes: 0, turnaroundMinutes: 0 },
    });

    expect(result.overlaps).toEqual([{ entryIds: ["booking-110", "block-b1"] }]);
    expect(result.freePeriods.map((period) => [period.start, period.end])).toEqual([
      [DAY.from.toISOString(), at("10:00").toISOString()],
      [at("13:00").toISOString(), at("16:00").toISOString()],
      [at("17:00").toISOString(), DAY.to.toISOString()],
    ]);
  });

  test("[SPM-74-TC15] each venue is evaluated with its own buffers and entries", () => {
    const busy = calendar({ bookings: [booking(110, "10:00", "12:00")], venueOverrides: { setupMinutes: 30, turnaroundMinutes: 45 } });
    const free = calendar({ venueOverrides: { setupMinutes: 0, turnaroundMinutes: 0 } });

    expect(busy.summary).toBe(AVAILABILITY.UNAVAILABLE_BOOKING);
    expect(free.summary).toBe(AVAILABILITY.AVAILABLE);
  });

  test("entries outside the requested range are left out", () => {
    const result = calendar({ bookings: [booking(140, "10:00", "12:00")].map((item) => ({ ...item, start: at("10:00", "2026-11-07"), end: at("12:00", "2026-11-07") })) });
    expect(result.entries).toEqual([]);
  });
});

describe("operating hours", () => {
  test.each([
    ["08:00-22:00", { open: 480, close: 1320 }],
    ["09:00 - 21:00", { open: 540, close: 1260 }],
    [null, null],
    ["24 hours", null],
    ["18:00-09:00", null],
  ])("parses %p", (text, expected) => {
    expect(parseOperatingHours(text)).toEqual(expected);
  });

  test("a range inside opening hours has no warning", () => {
    expect(operatingHoursWarning({ start: at("09:00"), end: at("18:00") }, "08:00-22:00")).toBeNull();
  });

  test("a range across midnight warns for both sides", () => {
    const warning = operatingHoursWarning({ start: at("21:00"), end: at("09:00", "2026-11-05") }, "08:00-22:00");
    expect(warning.outside).toEqual([{ start: at("22:00").toISOString(), end: at("08:00", "2026-11-05").toISOString() }]);
  });
});
