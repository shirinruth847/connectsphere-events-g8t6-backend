// SPM-188 AC9/AC10: confirming a hold as a booking. The booking's checks leave
// out only the event's own hold it confirms; the MongoDB conversion and the
// expiry job's acknowledgement exclude each other. MongoDB is a local in-memory server
// (Master M7), never Atlas.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));

const { MongoMemoryServer } = require("mongodb-memory-server");
const { ObjectId } = require("mongodb");
const venueModel = require("../../model/venueModel");
const { validateVenueBookingRequest } = require("../../validators/venueBookingValidator");

jest.setTimeout(120000);

const ORIGINAL_ENV = { ...process.env };
const NOW = new Date("2027-10-01T00:00:00Z");
const at = (time) => `2027-11-04T${time}:00+08:00`;
const HOLD_ID = "6720a1b2c3d4e5f60718293a";

describe("booking checks leave out the hold being confirmed (SPM-188 AC9)", () => {
  const hall = { venueId: 45, name: "Synthetic Hall", maxCapacity: 200, operatingHours: "08:00-22:00", status: "ACTIVE", statusReason: null, isActive: true };
  const context = (entries) => ({
    venues: new Map([[45, hall]]),
    details: new Map([["45", { setupMinutes: 30, turnaroundMinutes: 45, supportedLayouts: [], facilities: [], accessibilityFeatures: [] }]]),
    bookings: [],
    entries,
    detailsRead: true,
  });
  const ownHold = { id: HOLD_ID, venueId: 45, eventId: 42, type: "HOLD", status: "ACTIVE", occupiedStart: at("09:30"), occupiedEnd: at("12:45"), holdExpiresAt: "2027-10-20T00:00:00Z" };
  const booking = (overrides = {}) => ({ venueId: 45, start: at("10:00"), end: at("12:00"), expectedAttendance: 100, layout: "", requiredFacilities: [], accessibilityNeeds: [], ...overrides });
  const codes = (result) => result.blocking.map((check) => check.code);

  test("[SPM-188-AC9] should_not_count_the_event's_own_hold_against_the_booking_that_confirms_it", () => {
    const result = venueModel.assessBookingFit(booking({ holdId: HOLD_ID }), context([ownHold]), { eventId: 42, now: NOW });
    expect(codes(result)).toEqual([]);
    expect(result.availability).toBe("AVAILABLE");
  });

  test("[SPM-188-AC3] should_still_refuse_the_hold_for_a_booking_that_does_not_confirm_it", () => {
    const result = venueModel.assessBookingFit(booking(), context([ownHold]), { eventId: 42, now: NOW });
    expect(codes(result)).toEqual(["VENUE_HELD"]);
  });

  test("[SPM-188-AC3] should_refuse_another_event's_hold_even_when_its_id_is_sent", () => {
    const result = venueModel.assessBookingFit(booking({ holdId: HOLD_ID }), context([ownHold]), { eventId: 99, now: NOW });
    expect(codes(result)).toEqual(["VENUE_HELD"]);
  });

  test("[SPM-188-AC5] should_leave_out_only_the_named_hold", () => {
    const second = { ...ownHold, id: "6720a1b2c3d4e5f60718293b", occupiedStart: at("12:00"), occupiedEnd: at("13:00") };
    const result = venueModel.assessBookingFit(booking({ holdId: HOLD_ID }), context([ownHold, second]), { eventId: 42, now: NOW });
    expect(codes(result)).toEqual(["VENUE_HELD"]);
  });
});

describe("holdId on a booking item (SPM-188 AC9)", () => {
  const event = { start_datetime: "2030-03-10T00:00:00Z", end_datetime: "2030-03-10T10:00:00Z" };
  const item = (holdId) => ({
    venueId: 7, label: "Main hall", start: "2030-03-10T10:00:00+08:00", end: "2030-03-10T12:00:00+08:00",
    expectedAttendance: 150, layout: "Theatre", ...(holdId === undefined ? {} : { holdId }),
  });
  const validate = (holdId) => validateVenueBookingRequest({ bookings: [item(holdId)] }, { event, now: new Date("2030-01-01T00:00:00Z") });

  test("should_accept_a_hold_id_and_default_to_none", () => {
    expect(validate(HOLD_ID).bookings[0].holdId).toBe(HOLD_ID);
    // No key at all, so an ordinary booking hashes as before SPM-188.
    expect(validate(undefined).bookings[0]).not.toHaveProperty("holdId");
  });

  test.each([["not-a-hold"], [42], ["6720A1B2C3D4E5F60718293A"]])("should_refuse_a_malformed_hold_id_%p", (holdId) => {
    expect(validate(holdId).fields).toEqual({ "bookings.0.holdId": "This hold could not be found." });
  });
});

describe("convertHold and the expiry job (SPM-188 AC10)", () => {
  // The expiry job's write after it records an expiry (acknowledgeHoldNotice).
  const expire = (expectedVersion = 1) => calendarModel.acknowledgeHoldNotice({ holdId: HOLD_ID, expectedVersion, expiresAt: EXPIRES, kind: "EXPIRED" });
  let server;
  let db;
  let calendarModel;
  let closeMongoDb;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    process.env.MONGODB_URI = server.getUri();
    process.env.MONGODB_DB_NAME = "spm188_unit";
    jest.resetModules();
    calendarModel = require("../../model/venueCalendarModel");
    const { applyMigrations } = require("../../mongodb/migrate");
    const mongo = require("../../config/mongodb");
    closeMongoDb = mongo.closeMongoDb;
    db = await mongo.getMongoDb();
    await applyMigrations(db);
  });

  afterAll(async () => {
    await closeMongoDb();
    await server.stop();
    process.env = ORIGINAL_ENV;
  });

  const EXPIRES = new Date("2027-10-10T00:00:00Z");
  const placeHold = async () => {
    await db.collection("venue_calendar").deleteMany({});
    await calendarModel.insertHold({
      holdId: HOLD_ID, venueId: 45, eventId: 42, label: "Main hall", start: at("10:00"), end: at("12:00"),
      occupiedStart: at("09:30"), occupiedEnd: at("12:45"), holdExpiresAt: EXPIRES, createdBy: 11, writeToken: "place-token",
    });
  };
  const convert = (now, overrides = {}) => calendarModel.convertHold({
    holdId: HOLD_ID, venueId: 45, expectedVersion: 1, bookingId: 900, now, writeToken: "convert-token", ...overrides,
  });
  const stored = () => db.collection("venue_calendar").findOne({ _id: new ObjectId(HOLD_ID) });

  test("[SPM-188-AC9] should_convert_an_active_unexpired_hold_and_name_its_booking", async () => {
    await placeHold();
    const converted = await convert(new Date(EXPIRES.getTime() - 1000));
    expect(converted).toMatchObject({ status: "CONVERTED", convertedBookingId: 900, version: 2 });
    // A converted hold no longer reserves the venue; its booking does.
    expect(await expire()).toBe(false);
    expect(await expire(2)).toBe(false);
    expect((await stored()).status).toBe("CONVERTED");
  });

  test("[SPM-188-AC10] should_not_convert_a_hold_at_or_after_its_expiry", async () => {
    await placeHold();
    expect(await convert(EXPIRES)).toBeNull();
    expect(await expire()).toBe(true);
    expect(await convert(new Date(EXPIRES.getTime() - 1000), { expectedVersion: 2 })).toBeNull();
    expect((await stored()).status).toBe("EXPIRED");
  });

  test("[SPM-188-AC10] should_let_exactly_one_of_a_conversion_and_an_expiry_change_the_hold", async () => {
    await placeHold();
    const [converted, expired] = await Promise.all([
      convert(new Date(EXPIRES.getTime() - 1)),
      expire(),
    ]);
    expect([Boolean(converted), expired].filter(Boolean)).toHaveLength(1);
    expect(["CONVERTED", "EXPIRED"]).toContain((await stored()).status);
  });

  test("[SPM-188-AC9] should_put_a_hold_back_only_for_its_own_rolled_back_conversion", async () => {
    await placeHold();
    await convert(new Date(EXPIRES.getTime() - 1000));
    await calendarModel.revertConvertedHold({ holdId: HOLD_ID, venueId: 45, version: 2, writeToken: "someone-else" });
    expect((await stored()).status).toBe("CONVERTED");
    await calendarModel.revertConvertedHold({ holdId: HOLD_ID, venueId: 45, version: 2, writeToken: "convert-token" });
    expect(await stored()).toMatchObject({ status: "ACTIVE", convertedBookingId: null, version: 3 });
  });

  test("[SPM-188-AC9] should_refuse_a_stale_version", async () => {
    await placeHold();
    expect(await convert(new Date(EXPIRES.getTime() - 1000), { expectedVersion: 7 })).toBeNull();
  });
});
