// SPM-186 / SPM-189 model: what is read before the atomic decision, what the
// RPC receives, error mapping and the decision actions shown to Venue Staff.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetail: jest.fn(), getVenueDetailsByIds: jest.fn() }));
jest.mock("../../model/venueCalendarModel", () => ({ findCalendarEntries: jest.fn() }));
jest.mock("../../config/venueLockDatabase", () => ({ getVenueLockPool: jest.fn() }));

const { EventEmitter } = require("events");
const { getVenueLockPool } = require("../../config/venueLockDatabase");

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
  for (const method of ["select", "eq", "in", "lt", "gt", "order", "limit"]) query[method] = jest.fn(() => query);
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

// Queues the queries the model makes after a decision, in order, by table.
const mockTables = ({ afterBookings = [bookingRow()], event = eventRow() } = {}) => {
  const bookingQueries = [
    queryReturning({ data: { event_id: 442 }, error: null }),
    queryReturning({ data: afterBookings, error: null }),
    // The active bookings near the window, for the per-booking checks (SPM-186).
    queryReturning({ data: [], error: null }),
  ];
  supabase.from.mockImplementation((table) => {
    if (table === "event") return queryReturning({ data: event, error: null });
    if (table === "venue") return queryReturning({ data: [{ venue_id: 45, name: "Hall A", max_capacity: 300, operating_hours: "08:00-22:00", status: "ACTIVE", status_reason: null, is_active: true }], error: null });
    return bookingQueries.shift();
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  venueDetailModel.getVenueDetail.mockResolvedValue({ setupMinutes: 30, turnaroundMinutes: 45 });
  venueCalendarModel.findCalendarEntries.mockResolvedValue([]);
  venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([["45", { setupMinutes: 30, turnaroundMinutes: 45 }]]));
  supabase.rpc.mockResolvedValue({ data: { bookingId: 110, status: "APPROVED" }, error: null });
});

describe("approveVenueBooking under the venue lock (Master 7.4, T33)", () => {
  const pgError = (message, detail, code = "P0001") => Object.assign(new Error(message), { code, detail });
  let client;
  let locked;
  let decideError;

  // A pg client on the venue lock connection: begin locks event then venue,
  // decide_venue_booking commits the decision in the same transaction.
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    locked = { bookingId: 110, eventId: 442, venueId: 45, status: "PENDING", start: FUTURE_START, end: FUTURE_END };
    decideError = null;
    client = Object.assign(new EventEmitter(), {
      release: jest.fn(),
      query: jest.fn(async (sql) => {
        if (sql.includes("begin_venue_booking_decision")) {
          if (locked instanceof Error) throw locked;
          return { rows: [{ result: locked }] };
        }
        if (sql.includes("decide_venue_booking") && decideError) throw decideError;
        return { rows: [{}] };
      }),
    });
    getVenueLockPool.mockReturnValue({ connect: jest.fn().mockResolvedValue(client) });
  });
  afterEach(() => jest.restoreAllMocks());

  const statements = () => client.query.mock.calls.map(([sql]) => sql.trim().split(/[\s(]+/).slice(0, 2).join(" "));
  const decideParams = () => client.query.mock.calls.find(([sql]) => sql.includes("decide_venue_booking"))?.[1];

  test("[SPM-186-AC1][SPM-186-AC8] should_lock_check_and_decide_in_one_transaction", async () => {
    mockTables({ afterBookings: [bookingRow({ status: "APPROVED", reviewed_at: "2026-10-24T10:00:00Z", reviewer: { name: "Seed Venue Staff" } })] });

    const result = await venueModel.approveVenueBooking(7, 110, { expectedStatus: "PENDING", reason: null });

    expect(statements()).toEqual([
      "BEGIN",
      "SET LOCAL",
      "SELECT public.begin_venue_booking_decision",
      "SELECT public.decide_venue_booking",
      "COMMIT",
    ]);
    expect(decideParams()).toEqual([7, 110, "PENDING", 30, 45]);
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(result.booking).toEqual(expect.objectContaining({
      bookingId: 110,
      status: "APPROVED",
      reviewedAt: "2026-10-24T10:00:00Z",
      reviewedByName: "Seed Venue Staff",
      actions: { canApprove: false, canReject: true },
    }));
  });

  test("should_read_holds_and_blocks_for_the_occupied_range_with_a_short_timeout", async () => {
    mockTables();

    await venueModel.approveVenueBooking(7, 110, {});

    const [venueIds, from, to, options] = venueCalendarModel.findCalendarEntries.mock.calls[0];
    expect(venueIds).toEqual([45]);
    expect(from.toISOString()).toBe("2099-11-04T00:30:00.000Z");
    expect(to.toISOString()).toBe("2099-11-04T04:45:00.000Z");
    expect(options).toEqual({ maxTimeMS: 3000 });
    // The MongoDB read happens between the lock and the decision.
    const [, , decideOrder] = client.query.mock.invocationCallOrder;
    expect(venueCalendarModel.findCalendarEntries.mock.invocationCallOrder[0]).toBeLessThan(client.query.mock.invocationCallOrder[3]);
    expect(decideOrder).toBeDefined();
  });

  test("[SPM-186-TC8] should_refuse_an_active_block_and_roll_back", async () => {
    mockTables();
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      { venueId: 45, type: "BLOCK", status: "ACTIVE", reason: "MAINTENANCE", occupiedStart: FUTURE_START, occupiedEnd: FUTURE_END },
    ]);

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ code: "VENUE_BLOCKED" });
    expect(decideParams()).toBeUndefined();
    expect(statements()).toContain("ROLLBACK");
  });

  test("[SPM-186-TC8] should_refuse_another_event's_unexpired_hold", async () => {
    mockTables();
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      { venueId: 45, type: "HOLD", status: "ACTIVE", eventId: 9, occupiedStart: "2099-11-04T04:00:00Z", occupiedEnd: "2099-11-04T05:00:00Z", holdExpiresAt: "2099-11-01T00:00:00Z" },
    ]);

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ code: "VENUE_HELD" });
    expect(decideParams()).toBeUndefined();
  });

  test("should_ignore_overdue_holds_lifted_blocks_and_other_venues", async () => {
    mockTables();
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      { venueId: 45, type: "HOLD", status: "ACTIVE", occupiedStart: FUTURE_START, occupiedEnd: FUTURE_END, holdExpiresAt: "2020-01-01T00:00:00Z" },
      { venueId: 45, type: "BLOCK", status: "LIFTED", occupiedStart: FUTURE_START, occupiedEnd: FUTURE_END },
      { venueId: 46, type: "BLOCK", status: "ACTIVE", occupiedStart: FUTURE_START, occupiedEnd: FUTURE_END },
    ]);

    await venueModel.approveVenueBooking(7, 110, {});

    expect(decideParams()).toEqual([7, 110, null, 30, 45]);
  });

  test("[SPM-186-TC13] should_refuse_with_503_when_mongodb_cannot_be_read", async () => {
    mockTables();
    venueDetailModel.getVenueDetailsByIds.mockRejectedValue(Object.assign(new Error("timeout"), { name: "MongoServerSelectionError" }));

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ code: "VENUE_DETAILS_UNAVAILABLE" });
    expect(decideParams()).toBeUndefined();
    expect(statements()).toContain("ROLLBACK");
  });

  test("should_pass_missing_minutes_so_the_database_refuses_the_approval", async () => {
    mockTables();
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([["45", { setupMinutes: 15 }]]));
    decideError = pgError("VENUE_BUFFERS_NOT_SET");

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ code: "VENUE_BUFFERS_NOT_SET" });
    expect(decideParams()).toEqual([7, 110, null, 15, null]);
  });

  test("should_skip_mongodb_for_a_booking_that_is_no_longer_pending", async () => {
    mockTables();
    locked = { ...locked, status: "REJECTED" };
    decideError = pgError("BOOKING_ALREADY_DECIDED", "{\"status\":\"REJECTED\"}");

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ code: "BOOKING_ALREADY_DECIDED", currentStatus: "REJECTED" });
    expect(venueDetailModel.getVenueDetailsByIds).not.toHaveBeenCalled();
  });

  test.each([
    ["BOOKING_NOT_FOUND", "P0002"],
    ["FORBIDDEN", "P0001"],
  ])("should_map_a_refusal_while_locking_%s", async (message, code) => {
    locked = pgError(message, null, code);

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ name: "VenueError", code: message });
    expect(decideParams()).toBeUndefined();
  });

  test.each([
    "EVENT_NOT_IN_PLANNING",
    "VENUE_NOT_AVAILABLE",
    "VENUE_CAPACITY_EXCEEDED",
    "VENUE_BUFFERS_NOT_SET",
    "VENUE_BOOKING_CONFLICT",
  ])("should_map_the_database_refusal_%s", async (message) => {
    mockTables();
    decideError = pgError(message);

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ name: "VenueError", code: message });
  });

  test.each(["55P03", "40P01", "40001"])("should_answer_a_retryable_lock_conflict_%s", async (code) => {
    mockTables();
    locked = pgError("could not obtain lock", null, code);

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ code: "VENUE_LOCK_TIMEOUT" });
  });

  test("should_answer_unavailable_without_the_venue_lock_connection", async () => {
    getVenueLockPool.mockImplementation(() => { throw new Error("VENUE_LOCK_DATABASE_URL is not set"); });

    await expect(venueModel.approveVenueBooking(7, 110, {})).rejects.toMatchObject({ code: "VENUE_BOOKINGS_UNAVAILABLE" });
  });

  test("should_rethrow_unexpected_database_errors", async () => {
    mockTables();
    const failure = pgError("internal", null, "XX000");
    decideError = failure;

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
