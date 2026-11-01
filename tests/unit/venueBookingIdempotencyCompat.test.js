// SPM-188 added holdId to booking items. A retry of an ordinary booking sent
// before that deployment must still hash the same, or its idempotency key is
// refused as reused instead of replaying the saved result.
const { hashRequest } = require("../../model/eventModel");
const { validateVenueBookingRequest } = require("../../validators/venueBookingValidator");

const event = { start_datetime: "2030-03-10T01:00:00.000Z", end_datetime: "2030-03-10T06:00:00.000Z" };
const now = new Date("2030-01-01T00:00:00Z");
const item = (overrides = {}) => ({
  venueId: 7, label: "Main hall", start: "2030-03-10T10:00:00+08:00", end: "2030-03-10T12:00:00+08:00",
  expectedAttendance: 150, layout: "Theatre", requiredFacilities: ["Stage"], ...overrides,
});
const hashOf = (body) => hashRequest({ bookings: validateVenueBookingRequest(body, { event, now }).bookings }, {}, [42]);

// The hash main's validator (before SPM-188) gives this request.
const BEFORE_SPM_188 = "a4696905f47bea986a07a10d22c1cfc01fad623d117cbf4334442d6efc18a120";

describe("booking request hash across the SPM-188 deployment", () => {
  test("[SPM-188] should_hash_a_booking_without_a_hold_as_before_the_deployment", () => {
    const { bookings } = validateVenueBookingRequest({ bookings: [item()] }, { event, now });
    expect(bookings[0]).not.toHaveProperty("holdId");
    expect(hashOf({ bookings: [item()] })).toBe(BEFORE_SPM_188);
  });

  test("[SPM-188] should_treat_an_empty_holdId_as_no_hold", () => {
    expect(hashOf({ bookings: [item({ holdId: null })] })).toBe(BEFORE_SPM_188);
    expect(hashOf({ bookings: [item({ holdId: "" })] })).toBe(BEFORE_SPM_188);
  });

  test("[SPM-188-AC9] should_keep_the_hold_in_a_booking_that_confirms_one", () => {
    const holdId = "6720a1b2c3d4e5f60718293a";
    const { bookings } = validateVenueBookingRequest({ bookings: [item({ holdId })] }, { event, now });
    expect(bookings[0].holdId).toBe(holdId);
    expect(hashOf({ bookings: [item({ holdId })] })).not.toBe(BEFORE_SPM_188);
  });
});
