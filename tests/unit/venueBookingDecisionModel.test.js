// SPM-186 / SPM-189 model: what is read before the atomic decision, what the
// RPC receives, error mapping and the decision actions shown to Venue Staff.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetail: jest.fn(), getVenueDetailsByIds: jest.fn() }));
jest.mock("../../model/venueCalendarModel", () => ({ findCalendarEntries: jest.fn() }));

const supabase = require("../../config/supabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueCalendarModel = require("../../model/venueCalendarModel");
const venueModel = require("../../model/venueModel");
const { DECISION_MESSAGES } = require("../../validators/venueBookingValidator");

const FUTURE_START = "2099-11-04T01:00:00+00:00";
const FUTURE_END = "2099-11-04T04:00:00+00:00";

// A chainable stand-in for a supabase-js query that resolves to `result`.
const queryReturning = (result) => {
  const query = { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["select", "eq", "in", "order", "limit"]) query[method] = jest.fn(() => query);
  query.maybeSingle = jest.fn(() => Promise.resolve(result));
  return query;
};

const bookingRow = (overrides = {}) => ({
  booking_id: 110,
  label: "Plenary",
  status: "PENDING",
  start_datetime: FUTURE_START,
  end_datetime: FUTURE_END,
  expected_attendance: 120,
  layout_type: "Theater",
  required_facilities: [],
  accessibility_requirements: [],
  special_requirements: null,
  rejection_reason: null,
  reviewed_at: null,
  reviewer: null,
  created_at: "2026-10-07T13:32:08+00:00",
  updated_at: "2026-10-07T13:32:08+00:00",
  event_id: 442,
  room: {
    room_id: 450,
    layout_type: "Theater",
    capacity: 200,
    venue: { venue_id: 45, name: "Hall A", address: "1 Road", max_capacity: 300, operating_hours: "08:00-22:00", setup_turnaround_min: null },
  },
  ...overrides,
});

const eventRow = (status = "PLANNING") => ({
  event_id: 442, title: "Planning summit", event_type: null, status, purpose: "Plan", description: null,
  start_datetime: FUTURE_START, end_datetime: FUTURE_END, expected_attendance: 120, preferred_layout_type: null,
  accessibility_needs: null, submitted_at: null, organisation: null, coordinator: { name: "Seed Coordinator" },
});

// Queues the queries the model makes, in order, by table.
const mockTables = ({ decision = bookingRow(), afterBookings = [bookingRow()], event = eventRow() } = {}) => {
  const bookingQueries = [
    queryReturning({ data: decision && { booking_id: decision.booking_id, status: decision.status, start_datetime: decision.start_datetime, end_datetime: decision.end_datetime, room: { venue_id: 45 } }, error: null }),
    queryReturning({ data: { event_id: 442 }, error: null }),
    queryReturning({ data: afterBookings, error: null }),
  ];
  supabase.from.mockImplementation((table) => {
    if (table === "event") return queryReturning({ data: event, error: null });
    return bookingQueries.shift();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  venueDetailModel.getVenueDetail.mockResolvedValue({ setupMinutes: 30, turnaroundMinutes: 45 });
  venueCalendarModel.findCalendarEntries.mockResolvedValue([]);
  supabase.rpc.mockResolvedValue({ data: { bookingId: 110, status: "APPROVED" }, error: null });
});

describe("approveVenueBooking", () => {
  test("[SPM-186-AC1] should_send_the_actor_booking_status_and_the_venue_minutes_to_the_atomic_decision", async () => {
    mockTables({ afterBookings: [bookingRow({ status: "APPROVED", reviewed_at: "2026-10-24T10:00:00Z", reviewer: { name: "Seed Venue Staff" } })] });

    const result = await venueModel.approveVenueBooking(7, 110, { expectedStatus: "PENDING", reason: null });

    expect(supabase.rpc).toHaveBeenCalledWith("decide_venue_booking", {
      p_actor_id: 7,
      p_booking_id: 110,
      p_decision: "APPROVE",
      p_expected_status: "PENDING",
      p_reason: null,
      p_setup_minutes: 30,
      p_turnaround_minutes: 45,
    });
    expect(result.booking).toEqual(expect.objectContaining({
      bookingId: 110,
      status: "APPROVED",
      reviewedAt: "2026-10-24T10:00:00Z",
      reviewedByName: "Seed Venue Staff",
      actions: { canApprove: false, canReject: true },
    }));
  });

  test("should_check_blocks_over_the_occupied_range", async () => {
    mockTables();

    await venueModel.approveVenueBooking(7, 110, {});

    const [venueIds, from, to] = venueCalendarModel.findCalendarEntries.mock.calls[0];
    expect(venueIds).toEqual([45]);
    expect(from.toISOString()).toBe("2099-11-04T00:30:00.000Z");
    expect(to.toISOString()).toBe("2099-11-04T04:45:00.000Z");
  });

  test("should_refuse_when_an_active_block_overlaps_and_never_call_the_decision", async () => {
    mockTables();
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      { type: "HOLD", status: "ACTIVE" },
      { type: "BLOCK", status: "ACTIVE", reason: "MAINTENANCE" },
    ]);

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ code: "VENUE_BLOCKED" });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("should_ignore_lifted_blocks", async () => {
    mockTables();
    venueCalendarModel.findCalendarEntries.mockResolvedValue([{ type: "BLOCK", status: "LIFTED" }]);

    await venueModel.approveVenueBooking(7, 110, {});

    expect(supabase.rpc).toHaveBeenCalled();
  });

  test("should_refuse_with_503_when_mongodb_cannot_be_read", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    mockTables();
    venueDetailModel.getVenueDetail.mockRejectedValue(Object.assign(new Error("timeout"), { name: "MongoServerSelectionError" }));

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ code: "VENUE_DETAILS_UNAVAILABLE" });
    expect(supabase.rpc).not.toHaveBeenCalled();
    console.warn.mockRestore();
  });

  test("should_pass_missing_minutes_so_the_database_refuses_the_approval", async () => {
    mockTables();
    venueDetailModel.getVenueDetail.mockResolvedValue({ setupMinutes: 15 });

    await venueModel.approveVenueBooking(7, 110, {});

    expect(supabase.rpc.mock.calls[0][1]).toEqual(expect.objectContaining({ p_setup_minutes: 15, p_turnaround_minutes: null }));
    expect(venueCalendarModel.findCalendarEntries).not.toHaveBeenCalled();
  });

  test("should_skip_mongodb_for_a_booking_that_is_no_longer_pending", async () => {
    mockTables({ decision: bookingRow({ status: "REJECTED" }) });
    supabase.rpc.mockResolvedValue({ data: null, error: { message: "BOOKING_ALREADY_DECIDED", details: "{\"status\":\"REJECTED\"}", code: "P0001" } });

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({
      code: "BOOKING_ALREADY_DECIDED",
      currentStatus: "REJECTED",
    });
    expect(venueDetailModel.getVenueDetail).not.toHaveBeenCalled();
  });

  test("should_answer_not_found_for_a_missing_booking", async () => {
    mockTables({ decision: null });

    await expect(venueModel.approveVenueBooking(7, 999, {})).rejects.toMatchObject({ code: "BOOKING_NOT_FOUND" });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test.each([
    "BOOKING_NOT_FOUND",
    "EVENT_NOT_IN_PLANNING",
    "VENUE_NOT_AVAILABLE",
    "VENUE_CAPACITY_EXCEEDED",
    "VENUE_BUFFERS_NOT_SET",
    "VENUE_BOOKING_CONFLICT",
    "FORBIDDEN",
  ])("should_map_the_database_refusal_%s", async (message) => {
    mockTables();
    supabase.rpc.mockResolvedValue({ data: null, error: { message, code: "P0001" } });

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ name: "VenueError", code: message });
  });

  test("should_rethrow_unexpected_database_errors", async () => {
    mockTables();
    const failure = { message: "deadlock detected", code: "40P01" };
    supabase.rpc.mockResolvedValue({ data: null, error: failure });

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toBe(failure);
  });
});

describe("rejectVenueBooking", () => {
  test("[SPM-189-AC3] should_send_the_reason_without_reading_mongodb", async () => {
    mockTables({ afterBookings: [bookingRow({ status: "REJECTED", rejection_reason: "Closed for rewiring" })] });
    supabase.rpc.mockResolvedValue({ data: { status: "REJECTED" }, error: null });

    const result = await venueModel.rejectVenueBooking(7, 110, { expectedStatus: "PENDING", reason: "Closed for rewiring" });

    expect(supabase.rpc).toHaveBeenCalledWith("decide_venue_booking", expect.objectContaining({
      p_decision: "REJECT", p_expected_status: "PENDING", p_reason: "Closed for rewiring",
      p_setup_minutes: null, p_turnaround_minutes: null,
    }));
    expect(venueDetailModel.getVenueDetail).not.toHaveBeenCalled();
    expect(result.booking).toEqual(expect.objectContaining({ rejectionReason: "Closed for rewiring", actions: { canApprove: false, canReject: false } }));
  });

  test("should_map_an_invalid_reason_from_the_database_to_a_field_error", async () => {
    mockTables();
    supabase.rpc.mockResolvedValue({ data: null, error: { message: "REJECTION_REASON_INVALID", code: "P0001" } });

    await expect(venueModel.rejectVenueBooking(7, 110, { expectedStatus: "PENDING", reason: " " })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      fields: { reason: DECISION_MESSAGES.reasonRequired },
    });
  });

  test.each(["BOOKING_ALREADY_STARTED", "EVENT_NOT_ACTIVE"])("should_map_%s", async (message) => {
    mockTables({ decision: bookingRow({ status: "APPROVED" }) });
    supabase.rpc.mockResolvedValue({ data: null, error: { message, code: "P0001" } });

    await expect(venueModel.rejectVenueBooking(7, 110, { expectedStatus: "APPROVED", reason: "Closed" })).rejects.toMatchObject({ code: message });
  });
});

describe("decision actions on the booking view (SPM-186 AC4, SPM-189 AC6, T32)", () => {
  const actionsFor = async (row, eventStatus) => {
    supabase.from.mockImplementation((table) =>
      table === "event" ? queryReturning({ data: eventRow(eventStatus), error: null }) : queryReturning({ data: [row], error: null }));
    const result = await venueModel.findEventBookings(442);
    return result.bookings[0].actions;
  };

  test.each([
    ["PENDING", FUTURE_START, "PLANNING", { canApprove: true, canReject: true }],
    ["PENDING", FUTURE_START, "SAFETY_REVIEW", { canApprove: false, canReject: true }],
    ["APPROVED", FUTURE_START, "CONFIRMED", { canApprove: false, canReject: true }],
    ["APPROVED", "2020-01-01T01:00:00+00:00", "PREPARATION", { canApprove: false, canReject: false }],
    ["APPROVED", FUTURE_START, "CANCELLED", { canApprove: false, canReject: false }],
    ["REJECTED", FUTURE_START, "PLANNING", { canApprove: false, canReject: false }],
    ["CANCELLED", FUTURE_START, "PLANNING", { canApprove: false, canReject: false }],
  ])("a_%s_booking_starting_%s_in_a_%s_event", async (status, start, eventStatus, expected) => {
    expect(await actionsFor(bookingRow({ status, start_datetime: start }), eventStatus)).toEqual(expected);
  });
});

describe("setVenueStatus (Master 5.4.4, T32)", () => {
  const venueRow = { venue_id: 7, name: "Hall A", status: "INACTIVE", version: 2, created_by: null, updated_by: null };
  const affected = [{ eventId: 442, requestId: "REQ-000442", title: "Planning summit", status: "CONFIRMED", firstStart: FUTURE_START, bookings: 1, extra: "dropped" }];

  beforeEach(() => {
    supabase.from.mockImplementation(() => queryReturning({ data: [], error: null }));
  });

  test("should_return_the_affected_events_without_extra_fields", async () => {
    supabase.rpc.mockResolvedValue({ data: { venue: venueRow, changed: true, upcoming_bookings: 1, affected_events: affected }, error: null });

    const result = await venueModel.setVenueStatus(31, 7, { version: 1, status: "INACTIVE", reason: null, confirmUpcomingBookings: true });

    expect(result.affectedEvents).toEqual([{ eventId: 442, requestId: "REQ-000442", title: "Planning summit", status: "CONFIRMED", firstStart: FUTURE_START, bookings: 1 }]);
  });

  test("should_carry_the_affected_events_on_the_warning", async () => {
    supabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "VENUE_HAS_UPCOMING_BOOKINGS", code: "P0001", details: JSON.stringify({ upcomingBookings: 1, firstStart: FUTURE_START, affectedEvents: affected }) },
    });

    await expect(venueModel.setVenueStatus(31, 7, { version: 1, status: "INACTIVE" })).rejects.toMatchObject({
      code: "VENUE_HAS_UPCOMING_BOOKINGS",
      upcomingBookings: 1,
      affectedEvents: [expect.objectContaining({ eventId: 442 })],
    });
  });

  test("should_retry_a_serialization_failure_and_then_succeed", async () => {
    supabase.rpc
      .mockResolvedValueOnce({ data: null, error: { message: "VENUE_AFFECTED_EVENTS_CHANGED", code: "40001" } })
      .mockResolvedValueOnce({ data: { venue: venueRow, changed: true, upcoming_bookings: 0 }, error: null });

    const result = await venueModel.setVenueStatus(31, 7, { version: 1, status: "INACTIVE", confirmUpcomingBookings: true });

    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(result.changed).toBe(true);
  });

  test("should_stop_retrying_after_three_serialization_failures", async () => {
    const failure = { message: "VENUE_AFFECTED_EVENTS_CHANGED", code: "40001" };
    supabase.rpc.mockResolvedValue({ data: null, error: failure });

    await expect(venueModel.setVenueStatus(31, 7, { version: 1, status: "INACTIVE" })).rejects.toBe(failure);
    expect(supabase.rpc).toHaveBeenCalledTimes(3);
  });
});
