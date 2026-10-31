jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/venueCalendarModel", () => ({ findEntriesByIds: jest.fn() }));

const supabase = require("../../config/supabase");
const calendar = require("../../model/venueCalendarModel");
const { listEventHolds } = require("../../model/venueModel");

const HOLD_ID = "a".repeat(24);
const row = {
  hold_request_id: 3, event_id: 42, venue_id: 7, status: "PLACED", calendar_hold_id: HOLD_ID,
  label: "Synthetic hall", start_datetime: "2035-03-10T02:00:00Z", end_datetime: "2035-03-10T04:00:00Z",
};
let bookingRead;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  bookingRead = async () => ({ data: [{ booking_id: 900, status: "PENDING", calendar_hold_id: HOLD_ID }], error: null });
  supabase.from.mockImplementation((table) => {
    const query = {
      select: () => query, eq: () => query, order: () => query,
      in: () => bookingRead(),
      then: (resolve, reject) => Promise.resolve({ data: table === "venue_hold_request" ? [row] : [], error: null }).then(resolve, reject),
    };
    return query;
  });
  calendar.findEntriesByIds.mockImplementation(async () => new Map([[HOLD_ID, {
    id: HOLD_ID, eventId: 42, venueId: 7, type: "HOLD", status: "CONVERTED", convertedBookingId: 900,
    holdExpiresAt: new Date("2035-03-05T00:00:00Z"),
  }]]));
});

test("a verified saved booking confirms the conversion", async () => {
  const [request] = await listEventHolds(42);
  expect(request.hold).toMatchObject({
    bookingUnavailable: false, bookingMissing: false,
    convertedBooking: { bookingId: 900, status: "PENDING", statusLabel: "Pending" },
  });
});

test.each(["returned error", "rejected promise"])("a %s leaves the booking outcome unknown and a later read can recover", async (failure) => {
  bookingRead = failure === "returned error"
    ? async () => ({ data: null, error: { code: "SYNTHETIC_READ_FAILURE" } })
    : async () => { throw new Error("Synthetic connection failure"); };
  const [unknown] = await listEventHolds(42);
  expect(unknown.statusLabel).toBe("Booking outcome unavailable");
  expect(unknown.hold).toMatchObject({
    bookingUnavailable: true, bookingMissing: false, convertedBooking: null, convertedBookingId: null,
  });

  bookingRead = async () => ({ data: [], error: null });
  const [missing] = await listEventHolds(42);
  expect(missing.statusLabel).toBe("Booking not saved – confirm again");
  expect(missing.hold).toMatchObject({ bookingUnavailable: false, bookingMissing: true });

  bookingRead = async () => ({ data: [{ booking_id: 900, status: "APPROVED", calendar_hold_id: HOLD_ID }], error: null });
  const [confirmed] = await listEventHolds(42);
  expect(confirmed.hold).toMatchObject({ bookingUnavailable: false, bookingMissing: false, convertedBooking: { status: "APPROVED" } });
});
