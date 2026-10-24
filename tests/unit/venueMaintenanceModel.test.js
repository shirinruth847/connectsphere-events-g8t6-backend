jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));
jest.mock("../../model/venuePhotoModel", () => ({ findCoverPhotoIds: jest.fn().mockResolvedValue(new Map()) }));

const supabase = require("../../config/supabase");
const venueModel = require("../../model/venueModel");
const { MESSAGES } = require("../../validators/venueValidator");

const row = (overrides = {}) => ({
  venue_id: 7,
  name: "Marina Conference Hall",
  address: "10 Bayfront Avenue",
  max_capacity: 500,
  status: "ACTIVE",
  status_reason: null,
  contact_person: "Alex Tan",
  contact_email: "alex.tan@example.com",
  contact_number: "+65 6123 4567",
  version: 1,
  created_at: "2026-10-19T03:00:00+00:00",
  updated_at: "2026-10-19T03:00:00+00:00",
  created_by: 31,
  updated_by: 31,
  ...overrides,
});

const chain = (result) => {
  const query = {};
  for (const method of ["select", "eq", "in", "ilike", "order", "range"]) query[method] = jest.fn(() => query);
  query.maybeSingle = jest.fn().mockResolvedValue(result);
  query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return query;
};

let venues;
let users;

beforeEach(() => {
  jest.clearAllMocks();
  venues = chain({ data: [row()], error: null });
  users = chain({ data: [{ user_id: 31, name: "Venue Staff A" }], error: null });
  supabase.from.mockImplementation((table) => (table === "user" ? users : venues));
});

describe("listManagedVenues", () => {
  test("[SPM-73-TC11] should_filter_name_and_location_case_insensitively_and_by_status", async () => {
    await venueModel.listManagedVenues({ search: "marina", location: "Bayfront", status: "INACTIVE" }, { limit: 20, offset: 40 });

    expect(venues.eq).toHaveBeenCalledWith("is_active", true);
    expect(venues.ilike).toHaveBeenCalledWith("name", "%marina%");
    expect(venues.ilike).toHaveBeenCalledWith("address", "%Bayfront%");
    expect(venues.eq).toHaveBeenCalledWith("status", "INACTIVE");
    expect(venues.range).toHaveBeenCalledWith(40, 60);
  });

  test("[SPM-73-TC11] should_list_every_status_when_no_filter_is_set", async () => {
    await venueModel.listManagedVenues({}, { limit: 50, offset: 0 });

    expect(venues.ilike).not.toHaveBeenCalled();
    expect(venues.eq).toHaveBeenCalledTimes(1);
    expect(venues.eq).toHaveBeenCalledWith("is_active", true);
  });

  test("should_search_wildcard_characters_literally", async () => {
    await venueModel.listManagedVenues({ search: "100%_hall\\" }, { limit: 50, offset: 0 });

    expect(venues.ilike).toHaveBeenCalledWith("name", "%100\\%\\_hall\\\\%");
  });

  test("[SPM-73-AC9] should_map_venues_with_who_created_and_last_changed_them", async () => {
    const result = await venueModel.listManagedVenues({}, { limit: 50, offset: 0 });

    expect(users.in).toHaveBeenCalledWith("user_id", [31]);
    expect(result).toEqual({
      venues: [{
        venueId: 7,
        name: "Marina Conference Hall",
        address: "10 Bayfront Avenue",
        maxCapacity: 500,
        status: "ACTIVE",
        statusReason: null,
        contactPerson: "Alex Tan",
        contactEmail: "alex.tan@example.com",
        contactNumber: "+65 6123 4567",
        version: 1,
        createdAt: "2026-10-19T03:00:00+00:00",
        updatedAt: "2026-10-19T03:00:00+00:00",
        createdBy: { userId: 31, name: "Venue Staff A" },
        updatedBy: { userId: 31, name: "Venue Staff A" },
        setupMinutes: null,
        turnaroundMinutes: null,
        coverPhotoId: null,
      }],
      nextOffset: null,
      detailsAvailable: false,
      sortNotChecked: false,
    });
  });

  test("should_return_the_next_offset_only_when_another_page_exists", async () => {
    venues = chain({ data: [row({ venue_id: 1 }), row({ venue_id: 2 }), row({ venue_id: 3 })], error: null });

    const result = await venueModel.listManagedVenues({}, { limit: 2, offset: 0 });

    expect(result.venues.map(({ venueId }) => venueId)).toEqual([1, 2]);
    expect(result.nextOffset).toBe(2);
  });

  test("should_leave_older_venues_without_an_author_unnamed", async () => {
    venues = chain({ data: [row({ created_by: null, updated_by: null })], error: null });

    const result = await venueModel.listManagedVenues({}, { limit: 50, offset: 0 });

    expect(result.venues[0].createdBy).toBeNull();
    expect(supabase.from).not.toHaveBeenCalledWith("user");
  });
});

describe("getManagedVenue", () => {
  test("should_not_return_a_deleted_or_missing_venue", async () => {
    venues = chain({ data: null, error: null });

    await expect(venueModel.getManagedVenue(7)).rejects.toMatchObject({ name: "VenueError", code: "VENUE_NOT_FOUND" });
    expect(venues.eq).toHaveBeenCalledWith("is_active", true);
  });
});

describe("writes", () => {
  test("[SPM-73-TC1] should_create_through_the_atomic_rpc_as_the_actor", async () => {
    supabase.rpc.mockResolvedValue({ data: { venue: row(), changed: true }, error: null });
    const values = { name: "Marina Conference Hall", max_capacity: 500 };

    const result = await venueModel.createVenue(31, values);

    expect(supabase.rpc).toHaveBeenCalledWith("create_venue", { p_actor_id: 31, p_venue: values });
    expect(result.venue).toEqual(expect.objectContaining({ venueId: 7, status: "ACTIVE", createdBy: { userId: 31, name: "Venue Staff A" } }));
  });

  test("[SPM-73-TC6] should_update_with_the_expected_version", async () => {
    supabase.rpc.mockResolvedValue({ data: { venue: row({ version: 2 }), changed: true }, error: null });

    const result = await venueModel.updateVenue(31, 7, 1, { max_capacity: 650 });

    expect(supabase.rpc).toHaveBeenCalledWith("update_venue", {
      p_actor_id: 31,
      p_venue_id: 7,
      p_expected_version: 1,
      p_changes: { max_capacity: 650 },
    });
    expect(result.changed).toBe(true);
  });

  test("[SPM-73-TC8] should_pass_the_confirmation_and_return_the_kept_booking_count", async () => {
    supabase.rpc.mockResolvedValue({ data: { venue: row({ status: "INACTIVE" }), changed: true, upcoming_bookings: 2 }, error: null });

    const result = await venueModel.setVenueStatus(31, 7, { version: 1, status: "INACTIVE", reason: null, confirmUpcomingBookings: true });

    expect(supabase.rpc).toHaveBeenCalledWith("set_venue_status", {
      p_actor_id: 31,
      p_venue_id: 7,
      p_expected_version: 1,
      p_status: "INACTIVE",
      p_reason: null,
      p_confirm_upcoming: true,
    });
    expect(result.upcomingBookings).toBe(2);
  });

  test.each(["FORBIDDEN", "VENUE_NOT_FOUND", "VENUE_VERSION_CONFLICT", "VENUE_NAME_TAKEN"])(
    "should_turn_the_database_signal_%s_into_a_venue_error",
    async (message) => {
      supabase.rpc.mockResolvedValue({ data: null, error: { message, code: "P0001" } });

      await expect(venueModel.createVenue(31, {})).rejects.toMatchObject({ name: "VenueError", code: message });
    }
  );

  test("[SPM-73-TC8] should_carry_the_upcoming_booking_count_and_first_start", async () => {
    supabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "VENUE_HAS_UPCOMING_BOOKINGS", code: "P0001", details: '{"firstStart": "2027-03-02T01:00:00+00:00", "upcomingBookings": 2}' },
    });

    await expect(venueModel.setVenueStatus(31, 7, { version: 1, status: "INACTIVE" })).rejects.toMatchObject({
      code: "VENUE_HAS_UPCOMING_BOOKINGS",
      upcomingBookings: 2,
      firstStart: "2027-03-02T01:00:00+00:00",
    });
  });

  test("should_map_check_constraints_to_field_errors", async () => {
    supabase.rpc.mockResolvedValue({
      data: null,
      error: { message: 'new row for relation "venue" violates check constraint "venue_maintenance_reason_check"', code: "23514" },
    });

    await expect(venueModel.setVenueStatus(31, 7, { version: 1, status: "UNDER_MAINTENANCE" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      fields: { reason: MESSAGES.reasonRequired },
    });
  });

  test("should_rethrow_unexpected_database_errors_for_a_safe_500", async () => {
    const failure = { message: "permission denied for function create_venue", code: "42501" };
    supabase.rpc.mockResolvedValue({ data: null, error: failure });

    await expect(venueModel.createVenue(31, {})).rejects.toBe(failure);
  });
});
