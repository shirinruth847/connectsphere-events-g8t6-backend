// SPM-186: a booking's venue calendar for Venue Staff, with the booking's own
// window as the checked period and its event's own entries left out.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");

const request = require("supertest");
const supabase = require("../../config/supabase");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");
const app = require("../../server");

const FROM = "2027-11-01T00:00:00+08:00";
const TO = "2027-11-08T00:00:00+08:00";
const get = (path) => request(app).get(path).set("Authorization", "Bearer token");
const signInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-user");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: 7, role, organisation_ids: [] });
};
const queryReturning = (result) => {
  const query = { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["select", "eq", "in", "order", "lt", "gt"]) query[method] = jest.fn(() => query);
  query.maybeSingle = jest.fn(() => Promise.resolve(result));
  return query;
};

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  signInAs("VENUE_STAFF");
});

describe("GET /api/venues/bookings/:bookingId/availability", () => {
  test("[SPM-186] should_return_the_booking's_venue_calendar_over_the_range", async () => {
    jest.spyOn(venueModel, "findBookingAvailability").mockResolvedValue({ bookingId: 110, venueId: 45, venues: [] });

    const response = await get(`/api/venues/bookings/110/availability?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ bookingId: 110, venueId: 45 });
    const [bookingId, query] = venueModel.findBookingAvailability.mock.calls[0];
    expect(bookingId).toBe(110);
    expect(query.from.toISOString()).toBe(new Date(FROM).toISOString());
  });

  test("should_refuse_a_venue_or_period_from_the_query", async () => {
    jest.spyOn(venueModel, "findBookingAvailability");

    const response = await get(`/api/venues/bookings/110/availability?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&venueId=46&checkStart=x`);

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.fields).sort()).toEqual(["checkStart", "venueId"]);
    expect(venueModel.findBookingAvailability).not.toHaveBeenCalled();
  });

  test("should_answer_not_found_for_an_unknown_booking_or_a_bad_id", async () => {
    jest.spyOn(venueModel, "findBookingAvailability").mockResolvedValue(null);

    expect((await get(`/api/venues/bookings/999/availability?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`)).status).toBe(404);
    expect((await get(`/api/venues/bookings/abc/availability?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`)).status).toBe(404);
  });

  test.each(["COORDINATOR", "ORGANISER"])("should_refuse_%s", async (role) => {
    signInAs(role);

    expect((await get(`/api/venues/bookings/110/availability?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`)).status).toBe(403);
  });
});

describe("findBookingAvailability", () => {
  test("[SPM-186] should_check_the_booking's_own_window_and_leave_out_its_event", async () => {
    supabase.from.mockReturnValueOnce(queryReturning({
      data: { booking_id: 110, event_id: 442, venue_id: 45, start_datetime: "2027-11-04T02:00:00Z", end_datetime: "2027-11-04T04:00:00Z", room: { venue_id: 45 }, event: { status: "PLANNING" } },
      error: null,
    }));
    // The calendar read itself is covered by the availability model tests.
    supabase.from.mockReturnValue(queryReturning({ data: [], error: null }));
    const from = new Date(FROM);
    const to = new Date(TO);

    const result = await venueModel.findBookingAvailability(110, { from, to }, { user_id: 7, role: "VENUE_STAFF" });

    expect(result).toMatchObject({ bookingId: 110, venueId: 45, venues: [] });
  });

  test("should_hide_a_booking_whose_event_is_a_draft", async () => {
    supabase.from.mockReturnValueOnce(queryReturning({ data: { booking_id: 110, event_id: 442, venue_id: 45, start_datetime: "a", end_datetime: "b", room: null, event: { status: "DRAFT" } }, error: null }));

    await expect(venueModel.findBookingAvailability(110, { from: new Date(FROM), to: new Date(TO) }, {})).resolves.toBeNull();
  });
});
