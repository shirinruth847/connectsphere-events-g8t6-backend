jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../config/venueLockDatabase", () => ({ getVenueLockPool: jest.fn() }));
jest.mock("../../model/venueDetailModel", () => ({
  ...jest.requireActual("../../model/venueDetailModel"),
  getVenueDetailsByIds: jest.fn(),
}));
jest.mock("../../model/venueCalendarModel", () => ({
  findCalendarEntries: jest.fn(),
  findEventHolds: jest.fn(),
}));

const { EventEmitter } = require("node:events");
const { getVenueLockPool } = require("../../config/venueLockDatabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueCalendarModel = require("../../model/venueCalendarModel");
const venueModel = require("../../model/venueModel");

const EVENT_ID = 42;
const HALL = 7;
const ANNEX = 8;
const KEY = "spm179-model-0001";

const item = (overrides = {}) => ({
  venueId: HALL,
  label: "Main hall",
  start: "2030-03-10T02:00:00.000Z",
  end: "2030-03-10T04:00:00.000Z",
  expectedAttendance: 150,
  layout: "Theatre",
  requiredFacilities: [],
  accessibilityNeeds: [],
  specialRequirements: null,
  isPrimary: false,
  ...overrides,
});
const venueRow = (venueId, overrides = {}) => ({
  venueId, name: `Venue ${venueId}`, maxCapacity: 200, status: "ACTIVE", isActive: true, operatingHours: "08:00-22:00", ...overrides,
});
const pgError = (message, detail, code = "P0001") => Object.assign(new Error(message), { code, detail });

let client;
let started;
let saved;
const statements = () => client.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/).slice(0, 2).join(" "));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  started = { replay: null, event: { eventId: EVENT_ID }, venues: [venueRow(HALL), venueRow(ANNEX)] };
  saved = { eventId: EVENT_ID, requestId: "REQ-000042", replayed: false, warnings: [], bookings: [{ bookingId: 900, status: "PENDING" }] };
  // An EventEmitter like pg's Client: emitting "error" with no listener throws.
  client = Object.assign(new EventEmitter(), {
    release: jest.fn(),
    query: jest.fn(async (sql) => {
      if (sql.includes("begin_venue_booking_request")) return { rows: [{ result: started }] };
      if (sql.includes("request_venue_bookings")) return { rows: [{ result: saved }] };
      return { rows: [] };
    }),
  });
  getVenueLockPool.mockReturnValue({ connect: jest.fn().mockResolvedValue(client) });
  venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([
    [String(HALL), { setupMinutes: 30, turnaroundMinutes: 45, supportedLayouts: ["Theatre"], facilities: ["Stage"], accessibilityFeatures: ["Wheelchair access"] }],
    [String(ANNEX), { setupMinutes: 0, turnaroundMinutes: 0 }],
  ]));
  venueCalendarModel.findCalendarEntries.mockResolvedValue([]);
});

const requestBookings = (bookings = [item()]) =>
  venueModel.requestVenueBookings({ actorId: 20, eventId: EVENT_ID, bookings, idempotencyKey: KEY });

describe("requestVenueBookings (SPM-179)", () => {
  test("[SPM-179-TC-01] should_lock_check_and_save_in_one_transaction_on_one_client", async () => {
    const result = await requestBookings();

    expect(statements()).toEqual(["BEGIN", "SET LOCAL", "SELECT public.begin_venue_booking_request($1,", "SELECT public.request_venue_bookings($1,", "COMMIT"]);
    const [, beginArgs] = client.query.mock.calls[2];
    expect(beginArgs.slice(0, 4)).toEqual([20, EVENT_ID, [HALL], KEY]);
    expect(beginArgs[4]).toMatch(/^[0-9a-f]{64}$/);
    const [, requestArgs] = client.query.mock.calls[3];
    expect(JSON.parse(requestArgs[3])).toEqual({ [HALL]: { setupMinutes: 30, turnaroundMinutes: 45 } });
    expect(result.bookings).toEqual([{ bookingId: 900, status: "PENDING", statusLabel: "Pending" }]);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  test("[SPM-179-TC-17] should_commit_and_return_a_replay_without_reading_mongodb", async () => {
    started = { replay: { ...saved, replayed: true } };
    const result = await requestBookings();
    expect(result.replayed).toBe(true);
    expect(statements()).toEqual(["BEGIN", "SET LOCAL", "SELECT public.begin_venue_booking_request($1,", "COMMIT"]);
    expect(venueDetailModel.getVenueDetailsByIds).not.toHaveBeenCalled();
  });

  test("[SPM-179-TC-13] should_roll_back_when_mongodb_cannot_be_read", async () => {
    venueCalendarModel.findCalendarEntries.mockRejectedValue(Object.assign(new Error("timeout"), { name: "MongoServerSelectionError" }));
    await expect(requestBookings()).rejects.toMatchObject({ name: "VenueError", code: "AVAILABILITY_UNAVAILABLE" });
    expect(statements()).toContain("ROLLBACK");
    expect(statements()).not.toContain("COMMIT");
  });

  test("[SPM-179-TC-14] should_refuse_a_venue_without_setup_and_turnaround_minutes", async () => {
    await expect(requestBookings([item({ venueId: ANNEX }), item({ venueId: 9 })])).rejects.toMatchObject({
      code: "VENUE_NOT_BOOKABLE", index: 1, venueId: 9,
    });
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map());
    await expect(requestBookings()).rejects.toMatchObject({ code: "VENUE_BUFFERS_NOT_SET", index: 0, venueId: HALL });
  });

  test("[SPM-179-TC-11] should_refuse_active_blocks_and_other_events_holds_over_the_occupied_range", async () => {
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      // Ends exactly when the requested setup starts (01:30): adjacent, allowed.
      { venueId: HALL, type: "BLOCK", status: "ACTIVE", reason: "MAINTENANCE", occupiedStart: "2030-03-10T00:00:00Z", occupiedEnd: "2030-03-10T01:30:00Z" },
      // Starts one minute before the requested turnaround ends (04:45): conflict.
      { venueId: HALL, type: "HOLD", status: "ACTIVE", eventId: 99, holdExpiresAt: "2030-03-01T00:00:00Z", occupiedStart: "2030-03-10T04:44:00Z", occupiedEnd: "2030-03-10T06:00:00Z" },
    ]);
    await expect(requestBookings()).rejects.toMatchObject({
      code: "BOOKING_CONFLICT",
      index: 0,
      conflicts: [{ type: "HOLD", occupiedStart: "2030-03-10T04:44:00.000Z", occupiedEnd: "2030-03-10T06:00:00.000Z", holdExpiresAt: "2030-03-01T00:00:00.000Z" }],
    });
    expect(statements()).toContain("ROLLBACK");
  });

  test("[SPM-179-AC7] should_refuse_its_own_active_hold_without_saving_any_booking", async () => {
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      { venueId: ANNEX, type: "HOLD", status: "ACTIVE", eventId: EVENT_ID,
        holdExpiresAt: "2030-03-01T00:00:00Z",
        occupiedStart: "2030-03-10T02:00:00Z", occupiedEnd: "2030-03-10T03:00:00Z" },
    ]);
    await expect(requestBookings([item(), item({ venueId: ANNEX })])).rejects.toMatchObject({
      name: "VenueError", code: "BOOKING_CONFLICT", index: 1, venueId: ANNEX,
      conflicts: [{ type: "HOLD", occupiedStart: "2030-03-10T02:00:00.000Z",
        occupiedEnd: "2030-03-10T03:00:00.000Z", holdExpiresAt: "2030-03-01T00:00:00.000Z" }],
    });
    // The first venue is valid, but the whole request must stop before the SQL
    // writer can create bookings, activity, notifications or a replay result.
    expect(statements()).toEqual(["BEGIN", "SET LOCAL", "SELECT public.begin_venue_booking_request($1,", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  test("[SPM-179-TC-11] should_ignore_expired_holds_and_lifted_blocks", async () => {
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      { venueId: HALL, type: "HOLD", status: "ACTIVE", eventId: 99, holdExpiresAt: "2020-01-01T00:00:00Z", occupiedStart: "2030-03-10T02:00:00Z", occupiedEnd: "2030-03-10T03:00:00Z" },
      { venueId: HALL, type: "BLOCK", status: "LIFTED", occupiedStart: "2030-03-10T02:00:00Z", occupiedEnd: "2030-03-10T03:00:00Z" },
    ]);
    await expect(requestBookings()).resolves.toMatchObject({ requestId: "REQ-000042" });
  });

  test("[SPM-179-AC8] should_pass_advisory_warnings_without_blocking", async () => {
    await requestBookings([item({
      start: "2030-03-10T13:30:00.000Z", end: "2030-03-10T14:00:00.000Z", layout: "Banquet",
      requiredFacilities: ["Stage", "Projector"], accessibilityNeeds: ["Wheelchair accessible"],
    })]);
    const [, requestArgs] = client.query.mock.calls[3];
    const warnings = JSON.parse(requestArgs[4]);
    expect(warnings).toEqual([{ index: 0, venueId: HALL, messages: [
      expect.stringMatching(/outside operating hours/),
      "Venue 7 does not list the Banquet layout.",
      'Venue 7 does not list the facility "Projector".',
    ] }]);
  });

  test.each([
    ["VENUE_CAPACITY_EXCEEDED", '{"index": 1, "venueId": 8, "capacity": 80, "expectedAttendance": 81}', { index: 1, venueId: ANNEX, capacity: 80, expectedAttendance: 81 }],
    ["EVENT_NOT_IN_PLANNING", null, {}],
    ["BOOKING_CONFLICT", "not json", {}],
  ])("[SPM-179-AC7] should_map_database_refusal_%s", async (message, detail, extra) => {
    client.query.mockImplementation(async (sql) => {
      if (sql.includes("begin_venue_booking_request")) return { rows: [{ result: started }] };
      if (sql.includes("request_venue_bookings")) throw pgError(message, detail);
      return { rows: [] };
    });
    await expect(requestBookings([item(), item({ venueId: ANNEX })])).rejects.toMatchObject({ name: "VenueError", code: message, ...extra });
    expect(statements()).toContain("ROLLBACK");
  });

  test("[SPM-179-TC-18] should_turn_a_lock_timeout_into_a_retryable_conflict", async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql.includes("begin_venue_booking_request")) throw pgError("canceling statement due to lock timeout", null, "55P03");
      return { rows: [] };
    });
    await expect(requestBookings()).rejects.toMatchObject({ code: "VENUE_LOCK_TIMEOUT" });
  });

  test.each([
    ["40P01", "VENUE_LOCK_TIMEOUT"],
    ["40001", "VENUE_LOCK_TIMEOUT"],
    ["57014", "VENUE_BOOKINGS_UNAVAILABLE"],
    ["25P03", "VENUE_BOOKINGS_UNAVAILABLE"],
    ["08006", "VENUE_BOOKINGS_UNAVAILABLE"],
  ])("[SPM-179-AC16] should_answer_postgres_%s_with_a_retryable_%s", async (code, expected) => {
    client.query.mockImplementation(async (sql) => {
      if (sql.includes("request_venue_bookings")) throw pgError("stopped", null, code);
      if (sql.includes("begin_venue_booking_request")) return { rows: [{ result: started }] };
      return { rows: [] };
    });
    await expect(requestBookings()).rejects.toMatchObject({ name: "VenueError", code: expected });
    expect(statements()).toContain("ROLLBACK");
  });

  test("[SPM-179-AC16] should_survive_a_connection_lost_during_the_mongodb_read", async () => {
    venueCalendarModel.findCalendarEntries.mockImplementation(async () => {
      // The pooler drops the idle-in-transaction connection while MongoDB is read.
      client.emit("error", Object.assign(new Error("terminating connection due to idle-in-transaction timeout"), { code: "25P03" }));
      return [];
    });
    client.query.mockImplementation(async (sql) => {
      if (sql.includes("begin_venue_booking_request")) return { rows: [{ result: started }] };
      if (sql.includes("request_venue_bookings")) throw new Error("Client has encountered a connection error and is not queryable");
      return { rows: [] };
    });

    await expect(requestBookings()).rejects.toMatchObject({ name: "VenueError", code: "VENUE_BOOKINGS_UNAVAILABLE" });
    expect(statements()).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.listenerCount("error")).toBe(0);
  });

  test("[SPM-179-AC16] should_pass_unknown_failures_through_and_discard_a_broken_client", async () => {
    client.query.mockImplementation(async (sql) => {
      if (sql.includes("begin_venue_booking_request")) throw new Error("connection terminated");
      if (sql === "ROLLBACK") throw new Error("connection terminated");
      return { rows: [] };
    });
    await expect(requestBookings()).rejects.toThrow("connection terminated");
    expect(client.release).toHaveBeenCalledWith(true);
  });

  test("[SPM-179-T33] should_refuse_cleanly_when_the_lock_connection_is_not_configured", async () => {
    getVenueLockPool.mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "VENUE_LOCK_NOT_CONFIGURED" }); });
    await expect(requestBookings()).rejects.toMatchObject({ code: "VENUE_BOOKINGS_UNAVAILABLE" });
  });
});

// SPM-195: the booking list also reads the event's incidents (none here).
const noIncidents = () => ({
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnValueOnce({ order: jest.fn().mockResolvedValue({ data: [], error: null }) }),
});
const byTable = (bookingQuery) => (table) => (table === "resource_incidents" ? noIncidents() : bookingQuery);

describe("listEventVenueBookings (SPM-179)", () => {
  test("[SPM-179-AC12] should_map_bookings_with_labels_and_the_occupied_range", async () => {
    const supabase = require("../../config/supabase");
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn()
        .mockReturnValueOnce({ order: jest.fn().mockResolvedValue({
          data: [{
            booking_id: 900, venue_id: HALL, label: "Main hall", status: "PENDING", start_datetime: "2030-03-10T02:00:00+00:00",
            end_datetime: "2030-03-10T04:00:00+00:00", expected_attendance: 150, layout_type: "Theatre", required_facilities: [],
            accessibility_requirements: [], special_requirements: null, rejection_reason: null, is_primary: true,
            occupied_range: '["2030-03-10 01:30:00+00","2030-03-10 04:45:00+00")', created_at: "2030-01-01T00:00:00+00:00",
            venue: { name: "Hall" },
          }],
          error: null,
        }) }),
    };
    supabase.from.mockImplementation(byTable(query));

    const [booking] = await venueModel.listEventVenueBookings(EVENT_ID);
    expect(booking).toEqual(expect.objectContaining({
      bookingId: 900, venueName: "Hall", statusLabel: "Pending", isPrimary: true,
      occupiedStart: "2030-03-10T01:30:00.000Z", occupiedEnd: "2030-03-10T04:45:00.000Z",
    }));
    expect(supabase.from).toHaveBeenCalledWith("venue_booking");
  });

  const listWith = async (rows) => {
    const supabase = require("../../config/supabase");
    const row = (overrides) => ({
      venue_id: HALL, label: null, start_datetime: "2030-03-10T02:00:00+00:00", end_datetime: "2030-03-10T04:00:00+00:00",
      expected_attendance: 50, layout_type: "Theatre", required_facilities: [], accessibility_requirements: [],
      special_requirements: null, rejection_reason: null, is_primary: false, occupied_range: null,
      created_at: "2030-01-01T00:00:00+00:00", venue: { name: "Hall" }, ...overrides,
    });
    supabase.from.mockImplementation(byTable({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnValueOnce({ order: jest.fn().mockResolvedValue({ data: rows.map(row), error: null }) }),
    }));
    return venueModel.listEventVenueBookings(EVENT_ID);
  };

  test("[SPM-179-AC10] should_report_an_unflagged_only_active_booking_as_the_primary_venue", async () => {
    const bookings = await listWith([
      { booking_id: 1, status: "REJECTED" },
      { booking_id: 2, status: "APPROVED" },
    ]);
    expect(bookings.map((booking) => [booking.bookingId, booking.isPrimary])).toEqual([[1, false], [2, true]]);
  });

  test("[SPM-179-AC10] should_not_pick_a_primary_among_several_unflagged_active_bookings", async () => {
    const bookings = await listWith([
      { booking_id: 1, status: "PENDING" },
      { booking_id: 2, status: "APPROVED" },
    ]);
    expect(bookings.every((booking) => booking.isPrimary === false)).toBe(true);
  });
});
