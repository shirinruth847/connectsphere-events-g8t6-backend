// SPM-188 AC9/AC10 and Master T35: confirming a hold inside the booking request
// transaction. The MongoDB hold is marked CONVERTED before COMMIT; a refused
// COMMIT undoes it, a lost COMMIT leaves it, and the retry restores a hold that
// no booking names (a lost commit) before converting it again.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../config/venueLockDatabase", () => ({ getVenueLockPool: jest.fn() }));
jest.mock("../../model/venueDetailModel", () => ({
  ...jest.requireActual("../../model/venueDetailModel"),
  getVenueDetailsByIds: jest.fn(),
}));
jest.mock("../../model/venueCalendarModel", () => ({
  findCalendarEntries: jest.fn(),
  findCalendarEntry: jest.fn(),
  convertHold: jest.fn(),
  revertConvertedHold: jest.fn(),
  restoreOrphanConversion: jest.fn(),
  ownsHoldWrite: jest.fn(),
}));

const { EventEmitter } = require("node:events");
const supabase = require("../../config/supabase");
const { getVenueLockPool } = require("../../config/venueLockDatabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueCalendarModel = require("../../model/venueCalendarModel");
const venueModel = require("../../model/venueModel");

const EVENT_ID = 42;
const HALL = 7;
const HOLD_ID = "6720a1b2c3d4e5f60718293a";
const DB_NOW = "2030-03-01T00:00:00.000Z";
const START = "2030-03-10T02:00:00.000Z";
const END = "2030-03-10T04:00:00.000Z";

const item = { venueId: HALL, label: "Keynote hall", start: START, end: END, expectedAttendance: 120, layout: "Theatre", requiredFacilities: [], accessibilityNeeds: [], specialRequirements: null, isPrimary: false, holdId: HOLD_ID };
const hold = (overrides = {}) => ({
  id: HOLD_ID, venueId: HALL, eventId: EVENT_ID, type: "HOLD", status: "ACTIVE", start: new Date(START), end: new Date(END),
  holdExpiresAt: new Date("2030-03-05T00:00:00Z"), version: 3, convertedBookingId: null, ...overrides,
});
const pgError = (message, code = "P0001") => Object.assign(new Error(message), { code });

let client;
let commit;
let linkedBooking;
const statements = () => client.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/).slice(0, 2).join(" "));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  commit = async () => ({ rows: [] });
  linkedBooking = null;
  client = Object.assign(new EventEmitter(), {
    release: jest.fn(),
    query: jest.fn(async (sql) => {
      if (sql === "COMMIT") return commit();
      if (sql.includes("clock_timestamp")) return { rows: [{ result: DB_NOW }] };
      if (sql.includes("begin_venue_booking_request")) {
        return { rows: [{ result: { replay: null, venues: [{ venueId: HALL, name: "Hall", maxCapacity: 200, status: "ACTIVE", isActive: true, operatingHours: "08:00-22:00" }] } }] };
      }
      if (sql.includes("request_venue_bookings")) return { rows: [{ result: { eventId: EVENT_ID, bookings: [{ index: 0, bookingId: 900, status: "PENDING" }], warnings: [] } }] };
      if (sql.includes("record_venue_hold_conversion")) return { rows: [{ result: { holdId: HOLD_ID, bookingId: 900 } }] };
      return { rows: [] };
    }),
  });
  getVenueLockPool.mockReturnValue({ connect: jest.fn().mockResolvedValue(client) });
  venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([[String(HALL), { setupMinutes: 30, turnaroundMinutes: 0 }]]));
  venueCalendarModel.findCalendarEntries.mockResolvedValue([hold()]);
  venueCalendarModel.findCalendarEntry.mockResolvedValue(hold());
  venueCalendarModel.convertHold.mockImplementation(async ({ expectedVersion, bookingId }) => hold({ status: "CONVERTED", version: expectedVersion + 1, convertedBookingId: bookingId }));
  venueCalendarModel.restoreOrphanConversion.mockImplementation(async ({ expectedVersion }) => hold({ version: expectedVersion + 1 }));
  // GET venue_booking by calendar_hold_id (the lost-commit check).
  supabase.from.mockImplementation(() => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: linkedBooking ? { booking_id: linkedBooking } : null, error: null }),
    };
    return chain;
  });
});

const confirm = () => venueModel.requestVenueBookings({ actorId: 20, eventId: EVENT_ID, bookings: [item], idempotencyKey: "spm188-key" });

describe("confirming a hold in the booking request transaction (SPM-188 AC9)", () => {
  test("should_link_the_booking_and_convert_the_hold_before_commit_using_database_time", async () => {
    await confirm();

    expect(statements()).toEqual([
      "BEGIN", "SET LOCAL", "SELECT public.begin_venue_booking_request($1,", "SELECT clock_timestamp()",
      "SELECT public.request_venue_bookings($1,", "SELECT public.record_venue_hold_conversion($1,", "COMMIT",
    ]);
    expect(venueCalendarModel.convertHold).toHaveBeenCalledWith(expect.objectContaining({
      holdId: HOLD_ID, venueId: HALL, expectedVersion: 3, bookingId: 900, now: new Date(DB_NOW),
    }));
    expect(venueCalendarModel.revertConvertedHold).not.toHaveBeenCalled();
  });

  test("[SPM-188-AC10] should_undo_the_conversion_when_the_server_refuses_the_commit", async () => {
    commit = async () => { throw pgError("could not serialize", "40001"); };

    await expect(confirm()).rejects.toMatchObject({ code: "VENUE_LOCK_TIMEOUT" });
    const { writeToken } = venueCalendarModel.convertHold.mock.calls[0][0];
    expect(venueCalendarModel.revertConvertedHold).toHaveBeenCalledWith({ holdId: HOLD_ID, venueId: HALL, version: 4, writeToken });
  });

  test("[T35] should_leave_the_hold_when_the_commit_is_lost_and_answer_try_again", async () => {
    commit = async () => { throw pgError("connection terminated", "08006"); };

    await expect(confirm()).rejects.toMatchObject({ code: "VENUE_BOOKINGS_UNAVAILABLE" });
    expect(venueCalendarModel.revertConvertedHold).not.toHaveBeenCalled();
  });

  test("[T35] should_restore_and_convert_again_a_hold_whose_commit_was_lost", async () => {
    // The lost attempt converted the hold to booking 899, which was never saved.
    venueCalendarModel.findCalendarEntry.mockResolvedValue(hold({ status: "CONVERTED", version: 4, convertedBookingId: 899 }));

    await confirm();

    expect(venueCalendarModel.restoreOrphanConversion).toHaveBeenCalledWith({ holdId: HOLD_ID, venueId: HALL, expectedVersion: 4, convertedBookingId: 899 });
    expect(venueCalendarModel.convertHold).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 5, bookingId: 900 }));
    expect(statements()).toContain("COMMIT");
  });

  test("[SPM-188-AC9] should_refuse_a_hold_that_a_saved_booking_names", async () => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(hold({ status: "CONVERTED", version: 4, convertedBookingId: 899 }));
    linkedBooking = 899;

    await expect(confirm()).rejects.toMatchObject({ code: "HOLD_ALREADY_CONVERTED", index: 0 });
    expect(venueCalendarModel.restoreOrphanConversion).not.toHaveBeenCalled();
    expect(statements()).not.toContain("SELECT public.request_venue_bookings($1,");
  });

  test("[T35] should_refuse_when_the_lost_commit_cannot_be_repaired", async () => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(hold({ status: "CONVERTED", version: 4, convertedBookingId: 899 }));
    venueCalendarModel.restoreOrphanConversion.mockResolvedValue(null);

    await expect(confirm()).rejects.toMatchObject({ code: "HOLD_NOT_ACTIVE" });
    expect(venueCalendarModel.convertHold).not.toHaveBeenCalled();
  });

  test("[T35] should_refuse_an_expired_hold_after_repairing_a_lost_commit", async () => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(hold({ status: "CONVERTED", version: 4, convertedBookingId: 899, holdExpiresAt: new Date("2030-02-01T00:00:00Z") }));
    venueCalendarModel.restoreOrphanConversion.mockResolvedValue(hold({ version: 5, holdExpiresAt: new Date("2030-02-01T00:00:00Z") }));

    await expect(confirm()).rejects.toMatchObject({ code: "HOLD_EXPIRED" });
    expect(venueCalendarModel.restoreOrphanConversion).toHaveBeenCalled();
  });

  test("should_report_an_unknown_outcome_when_the_undo_itself_fails", async () => {
    commit = async () => { throw pgError("could not serialize", "40001"); };
    venueCalendarModel.revertConvertedHold.mockRejectedValue(new Error("mongo down"));

    await expect(confirm()).rejects.toMatchObject({ code: "VENUE_CALENDAR_OUTCOME_UNKNOWN" });
  });
});
