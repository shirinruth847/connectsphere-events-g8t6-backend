// SPM-186 AC7–AC11, AC17–AC18: each venue booking is checked against its own
// venue and its own window (Master 5.4, 5.4.2). Pure rules first, then the
// coordinator's advisory check route.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => ({
  ...jest.requireActual("../../model/eventModel"),
  findVisibleEvent: jest.fn(),
}));

const request = require("supertest");
const venueModel = require("../../model/venueModel");
const { validateVenueBookingCheck } = require("../../validators/venueBookingValidator");

const NOW = new Date("2027-10-01T00:00:00Z");
// 4 Nov 2027, 10:00–12:00 SGT; the Hall's 30/45 minutes make it occupy 09:30–12:45.
const at = (time) => `2027-11-04T${time}:00+08:00`;
const hall = { venueId: 45, name: "Synthetic Hall", maxCapacity: 200, operatingHours: "08:00-22:00", status: "ACTIVE", statusReason: null, isActive: true };
const room = { venueId: 46, name: "Synthetic Room B", maxCapacity: 40, operatingHours: "09:00-18:00", status: "ACTIVE", statusReason: null, isActive: true };
const hallDetail = { setupMinutes: 30, turnaroundMinutes: 45, supportedLayouts: ["Theatre"], facilities: ["Projector", "PA system"], accessibilityFeatures: ["Step-free access"] };
const roomDetail = { setupMinutes: 0, turnaroundMinutes: 0, supportedLayouts: ["Classroom"], facilities: [], accessibilityFeatures: [] };

const booking = (overrides = {}) => ({
  venueId: 45, start: at("10:00"), end: at("12:00"), expectedAttendance: 120,
  layout: "Theatre", requiredFacilities: ["Projector"], accessibilityNeeds: ["Step-free access"], ...overrides,
});
const context = (overrides = {}) => ({
  venues: new Map([[45, hall], [46, room]]),
  details: new Map([["45", hallDetail], ["46", roomDetail]]),
  bookings: [],
  entries: [],
  detailsRead: true,
  ...overrides,
});
const otherBooking = (start, end, overrides = {}) => ({
  bookingId: 900, eventId: 77, venueId: 45, status: "APPROVED", range: { start: new Date(start), end: new Date(end) }, ...overrides,
});
const codes = (result) => result.blocking.map((check) => check.code);

describe("assessBookingFit (SPM-186 AC7)", () => {
  test("[SPM-186-AC7] should_pass_a_booking_that_fits_its_venue_and_window", () => {
    const result = venueModel.assessBookingFit(booking(), context(), { now: NOW });

    expect(result).toMatchObject({ venueId: 45, availability: "AVAILABLE", blocking: [], warnings: [] });
    expect(result.occupiedStart).toBe(new Date(at("09:30")).toISOString());
    expect(result.occupiedEnd).toBe(new Date(at("12:45")).toISOString());
  });

  test.each([
    ["ends at 09:30", at("08:30"), at("09:30"), false],
    ["starts at 12:45", at("12:45"), at("14:00"), false],
    ["starts at 12:44", at("12:44"), at("14:00"), true],
    ["covers 11:00", at("11:00"), at("11:15"), true],
  ])("[SPM-186-TC7] another booking that %s conflicts: %s", (_name, start, end, conflicts) => {
    const result = venueModel.assessBookingFit(booking(), context({ bookings: [otherBooking(start, end)] }), { now: NOW });

    expect(codes(result).includes("VENUE_BOOKING_CONFLICT")).toBe(conflicts);
    expect(result.availability).toBe(conflicts ? "UNAVAILABLE" : "AVAILABLE");
  });

  test("should_name_the_conflicting_booking's_request", () => {
    const result = venueModel.assessBookingFit(booking(), context({ bookings: [otherBooking(at("11:00"), at("13:00"))] }), { now: NOW });

    expect(result.blocking[0].message).toBe("Overlaps an approved booking for REQ-000077 (4 Nov, 11:00–13:00).");
  });

  test("should_never_conflict_with_itself", () => {
    const self = otherBooking(at("09:30"), at("12:45"), { bookingId: 110 });

    const result = venueModel.assessBookingFit(booking(), context({ bookings: [self] }), { excludeBookingId: 110, now: NOW });

    expect(result.availability).toBe("AVAILABLE");
  });

  test("[SPM-186-AC10] should_check_each_venue_on_its_own_window_only", () => {
    const blockedHall = context({
      entries: [{ venueId: 45, type: "BLOCK", status: "ACTIVE", reason: "MAINTENANCE", occupiedStart: at("11:00"), occupiedEnd: at("11:30") }],
      bookings: [otherBooking(at("13:00"), at("17:00"), { venueId: 45 })],
    });

    const hallResult = venueModel.assessBookingFit(booking(), blockedHall, { now: NOW });
    const roomResult = venueModel.assessBookingFit(
      booking({ venueId: 46, start: at("13:00"), end: at("17:00"), expectedAttendance: 30, layout: "Classroom", requiredFacilities: [], accessibilityNeeds: [] }),
      blockedHall,
      { now: NOW },
    );

    expect(hallResult.availability).toBe("UNAVAILABLE");
    expect(roomResult).toMatchObject({ availability: "AVAILABLE", blocking: [], warnings: [] });
  });

  test("[SPM-186-TC8] should_refuse_blocks_and_unexpired_holds_and_ignore_an_overdue_hold", () => {
    const entries = [
      { venueId: 45, type: "HOLD", status: "ACTIVE", occupiedStart: at("12:00"), occupiedEnd: at("13:00"), holdExpiresAt: "2027-10-20T00:00:00Z" },
      { venueId: 45, type: "BLOCK", status: "ACTIVE", reason: "MAINTENANCE", occupiedStart: at("11:00"), occupiedEnd: at("11:30") },
      { venueId: 45, type: "HOLD", status: "ACTIVE", occupiedStart: at("10:00"), occupiedEnd: at("10:30"), holdExpiresAt: "2027-09-01T00:00:00Z" },
      { venueId: 45, type: "BLOCK", status: "LIFTED", occupiedStart: at("10:00"), occupiedEnd: at("11:00") },
    ];

    const result = venueModel.assessBookingFit(booking(), context({ entries }), { now: NOW });

    expect(codes(result).sort()).toEqual(["VENUE_BLOCKED", "VENUE_HELD"]);
    expect(result.blocking.find((check) => check.code === "VENUE_BLOCKED").message).toBe("Blocked (Maintenance) 4 Nov, 11:00–11:30.");
    expect(result.blocking.find((check) => check.code === "VENUE_HELD").message).toMatch(/^Held for another event 4 Nov, 12:00–13:00, until 20 Oct 08:00\.$/);
  });

  test("[SPM-186-TC9] should_refuse_attendance_above_capacity", () => {
    const result = venueModel.assessBookingFit(booking({ venueId: 46, expectedAttendance: 41, layout: "Classroom", requiredFacilities: [], accessibilityNeeds: [] }), context(), { now: NOW });

    expect(result.blocking).toEqual([{ code: "VENUE_CAPACITY_EXCEEDED", message: "41 people is more than Synthetic Room B's capacity of 40." }]);
    // Availability is still worked out: the time is free.
    expect(result.availability).toBe("AVAILABLE");
  });

  test("[SPM-186-TC10] should_refuse_a_venue_out_of_service_or_without_setup_and_turnaround", () => {
    const annex = { ...hall, venueId: 47, name: "Synthetic Annex", status: "UNDER_MAINTENANCE", statusReason: "Roof repairs" };
    const lab = { ...hall, venueId: 48, name: "Synthetic Lab" };
    const ctx = context({
      venues: new Map([[47, annex], [48, lab]]),
      details: new Map([["47", hallDetail], ["48", { setupMinutes: null }]]),
    });

    const annexResult = venueModel.assessBookingFit(booking({ venueId: 47 }), ctx, { now: NOW });
    const labResult = venueModel.assessBookingFit(booking({ venueId: 48 }), ctx, { now: NOW });

    expect(annexResult.blocking).toEqual([{ code: "VENUE_NOT_BOOKABLE", message: "Synthetic Annex is under maintenance (Roof repairs) and takes no new bookings." }]);
    expect(labResult).toMatchObject({ availability: "NOT_CHECKED", blocking: [{ code: "VENUE_BUFFERS_NOT_SET", message: "Setup and turnaround times are not recorded for Synthetic Lab." }] });
  });

  test("[SPM-186-TC11] should_warn_about_layout_facilities_access_and_hours_without_blocking", () => {
    const result = venueModel.assessBookingFit(
      booking({ start: at("20:30"), end: at("22:00"), layout: "Banquet", requiredFacilities: ["Stage"], accessibilityNeeds: ["Hearing loop"] }),
      context(),
      { now: NOW },
    );

    expect(result.blocking).toEqual([]);
    expect(result.availability).toBe("AVAILABLE");
    expect(result.warnings).toEqual([
      "Occupied time 22:00–22:45 is outside operating hours (08:00-22:00).",
      "Synthetic Hall does not list the Banquet layout.",
      "Synthetic Hall does not list the facility \"Stage\".",
      "Synthetic Hall does not list the accessibility feature \"Hearing loop\".",
    ]);
  });

  test("[SPM-186-AC11] should_never_report_available_when_mongodb_cannot_be_read", () => {
    const result = venueModel.assessBookingFit(booking(), context({ detailsRead: false }), { now: NOW });

    expect(result.availability).toBe("NOT_CHECKED");
    expect(codes(result)).toEqual(["AVAILABILITY_NOT_CHECKED"]);
  });

  test("should_report_a_deleted_venue", () => {
    const result = venueModel.assessBookingFit(booking({ venueId: 99 }), context(), { now: NOW });

    expect(result).toMatchObject({ availability: "UNAVAILABLE", blocking: [{ code: "VENUE_NOT_FOUND" }] });
  });
});

describe("validateVenueBookingCheck (SPM-186 AC17, AC18)", () => {
  const event = { start_datetime: at("08:00"), end_datetime: at("18:00") };
  const item = (overrides = {}) => ({
    venueId: 45, label: "Main hall", start: at("10:00"), end: at("12:00"), expectedAttendance: 120, layout: "Theatre", ...overrides,
  });

  test("[SPM-186-AC17] should_check_a_booking_whose_venue_and_times_are_ready_even_without_a_label", () => {
    const { items } = validateVenueBookingCheck({ bookings: [item({ label: "" })] }, { event, now: NOW });

    expect(items[0].booking).toMatchObject({ venueId: 45, start: new Date(at("10:00")).toISOString() });
    expect(items[0].fields).toHaveProperty(["bookings.0.label"]);
  });

  test("[SPM-186-AC18] should_not_check_a_booking_outside_the_event_but_still_check_the_others", () => {
    const { items } = validateVenueBookingCheck({ bookings: [item({ start: at("17:00"), end: at("19:00") }), item({ venueId: 46, start: at("13:00"), end: at("17:00") })] }, { event, now: NOW });

    expect(items[0].booking).toBeNull();
    expect(items[0].fields["bookings.0.start"]).toEqual(expect.any(String));
    expect(items[1].booking).toMatchObject({ venueId: 46 });
  });

  test("should_not_check_a_venue_listed_twice", () => {
    const { items } = validateVenueBookingCheck({ bookings: [item(), item({ start: at("13:00"), end: at("14:00") })] }, { event, now: NOW });

    expect(items[0].booking).not.toBeNull();
    expect(items[1].booking).toBeNull();
  });

  test.each([
    [[], "body"],
    [{ bookings: [item()], eventId: 1 }, "eventId"],
    [{ bookings: [] }, "bookings"],
  ])("should_refuse_a_malformed_body_%#", (body, field) => {
    expect(validateVenueBookingCheck(body, { event, now: NOW }).fields).toHaveProperty([field]);
  });
});

describe("POST /api/events/:id/venue-bookings/check (SPM-186 AC17)", () => {
  const userModel = require("../../model/userModel");
  const eventModel = require("../../model/eventModel");
  const app = require("../../server");
  const COORDINATOR_ID = 20;

  const signedInAs = (userId, role) => {
    userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
    userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
  };
  const eventRow = (overrides = {}) => ({
    event_id: 42, organiser_id: 5, coordinator_id: COORDINATOR_ID, supervising_lead_id: 10, status: "PLANNING",
    start_datetime: "2030-03-10T01:00:00+00:00", end_datetime: "2030-03-10T09:00:00+00:00", ...overrides,
  });
  const body = { bookings: [{ venueId: 7, label: "Main", start: "2030-03-10T02:00:00+00:00", end: "2030-03-10T04:00:00+00:00", expectedAttendance: 50, layout: "Theatre" }] };
  const check = (payload = body) => request(app).post("/api/events/42/venue-bookings/check").set("Authorization", "Bearer token").send(payload);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(venueModel, "checkVenueBookings").mockResolvedValue([{ index: 0, checked: true, venueId: 7, availability: "AVAILABLE", blocking: [], warnings: [] }]);
  });
  afterEach(() => jest.restoreAllMocks());

  test("[SPM-186-AC17] should_return_each_booking's_checks_to_the_assigned_coordinator_without_an_idempotency_key", async () => {
    signedInAs(COORDINATOR_ID, "COORDINATOR");
    eventModel.findVisibleEvent.mockResolvedValue(eventRow());

    const response = await check();

    expect(response.status).toBe(200);
    expect(response.body.bookings[0]).toMatchObject({ index: 0, availability: "AVAILABLE" });
    // The event ID lets the check leave out the event's own hold a booking confirms (SPM-188 AC9).
    expect(venueModel.checkVenueBookings).toHaveBeenCalledWith(
      [expect.objectContaining({ index: 0, booking: expect.objectContaining({ venueId: 7 }) })],
      { eventId: expect.any(Number) },
    );
  });

  test("should_refuse_an_event_that_is_not_in_planning", async () => {
    signedInAs(COORDINATOR_ID, "COORDINATOR");
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status: "UNDER_REVIEW" }));

    const response = await check();

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("EVENT_NOT_IN_PLANNING");
    expect(venueModel.checkVenueBookings).not.toHaveBeenCalled();
  });

  test.each([
    ["another coordinator", 21, "COORDINATOR"],
    ["the supervising Lead", 10, "COORDINATOR_LEAD"],
    ["the organiser", 5, "ORGANISER"],
  ])("[SPM-186-TC19] should_refuse_%s", async (_name, userId, role) => {
    signedInAs(userId, role);
    eventModel.findVisibleEvent.mockResolvedValue(role === "COORDINATOR" && userId !== COORDINATOR_ID ? null : eventRow());

    const response = await check();

    expect([403, 404]).toContain(response.status);
    expect(venueModel.checkVenueBookings).not.toHaveBeenCalled();
  });

  test("should_refuse_a_malformed_body", async () => {
    signedInAs(COORDINATOR_ID, "COORDINATOR");
    eventModel.findVisibleEvent.mockResolvedValue(eventRow());

    const response = await check({ bookings: [], extra: true });

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty("bookings");
  });
});
