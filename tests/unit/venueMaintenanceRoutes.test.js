// SPM-73 routes with the model mocked: access, validation, error mapping.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({
  getVenueCatalogue: jest.fn(),
  listManagedVenues: jest.fn(),
  findManagedVenueRow: jest.fn(),
  getManagedVenue: jest.fn(),
  getManagedVenueDetails: jest.fn(),
  createVenue: jest.fn(),
  updateVenue: jest.fn(),
  setVenueStatus: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");
const { MESSAGES } = require("../../validators/venueValidator");

const STAFF_ID = 31;
const venueError = (code, extra = {}) => Object.assign(new Error(code), { name: "VenueError", code, ...extra });

const marina = {
  name: "Marina Conference Hall",
  address: "10 Bayfront Avenue",
  maxCapacity: 500,
  contactPerson: "Alex Tan",
  contactEmail: "alex.tan@example.com",
  contactNumber: "+65 6123 4567",
  status: "ACTIVE",
};
const savedVenue = { venueId: 7, ...marina, statusReason: null, version: 1 };

const as = (method, path) => request(app)[method](path).set("Authorization", "Bearer token");

const MAINTENANCE_ROUTES = [
  ["get", "/api/venues/manage"],
  ["get", "/api/venues/7"],
  ["post", "/api/venues"],
  ["put", "/api/venues/7"],
  ["put", "/api/venues/7/status"],
];
const MODEL_CALLS = ["listManagedVenues", "getManagedVenue", "createVenue", "updateVenue", "setVenueStatus", "findManagedVenueRow"];

beforeEach(() => {
  jest.clearAllMocks();
  userModel.verifyAccessToken.mockResolvedValue("auth-staff");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: STAFF_ID, role: "VENUE_STAFF", organisation_ids: [] });
  venueModel.findManagedVenueRow.mockResolvedValue({ venue_id: 7, contact_email: "alex.tan@example.com", contact_number: null });
});

describe("SPM-73 access", () => {
  test.each(MAINTENANCE_ROUTES)("[SPM-73-TC9] should_return_401_without_a_session_for_%s_%s", async (method, path) => {
    const response = await request(app)[method](path).send(marina);

    expect(response.status).toBe(401);
    MODEL_CALLS.forEach((name) => expect(venueModel[name]).not.toHaveBeenCalled());
  });

  const deniedRoles = ["COORDINATOR", "COORDINATOR_LEAD", "ORGANISER", "TECH_SUPPORT", "ATTENDEE"];
  test.each(deniedRoles.flatMap((role) => MAINTENANCE_ROUTES.map(([method, path]) => [role, method, path])))(
    "[SPM-73-TC9] should_deny_%s_on_%s_%s_and_change_nothing",
    async (role, method, path) => {
      userModel.findUserByAuthId.mockResolvedValue({ user_id: 40, role });

      const response = await as(method, path).send(marina);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
      MODEL_CALLS.forEach((name) => expect(venueModel[name]).not.toHaveBeenCalled());
    }
  );

  test("[SPM-73-AC1] should_answer_403_when_the_database_finds_the_actor_is_no_longer_venue_staff", async () => {
    venueModel.createVenue.mockRejectedValue(venueError("FORBIDDEN"));

    const response = await as("post", "/api/venues").send(marina);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });
});

describe("POST /api/venues", () => {
  test("[SPM-73-TC1] should_create_the_venue_as_the_signed_in_venue_staff", async () => {
    venueModel.createVenue.mockResolvedValue({ venue: savedVenue, changed: true });

    const response = await as("post", "/api/venues").send(marina);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ message: "Venue created.", venue: savedVenue });
    expect(venueModel.createVenue).toHaveBeenCalledWith(STAFF_ID, {
      name: "Marina Conference Hall",
      address: "10 Bayfront Avenue",
      max_capacity: 500,
      contact_person: "Alex Tan",
      contact_email: "alex.tan@example.com",
      contact_number: "+65 6123 4567",
      status: "ACTIVE",
      status_reason: null,
    });
  });

  test("[SPM-73-TC2] should_block_a_venue_without_name_and_capacity_and_create_nothing", async () => {
    const response = await as("post", "/api/venues").send({ ...marina, name: "", maxCapacity: undefined });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Please correct the highlighted fields.",
      code: "VALIDATION_FAILED",
      fields: { name: "Venue name is required", maxCapacity: "Capacity is required" },
    });
    expect(venueModel.createVenue).not.toHaveBeenCalled();
  });

  test.each([0, -10, 10.5, "ten"])("[SPM-73-TC3] should_reject_capacity_%p_and_create_nothing", async (maxCapacity) => {
    const response = await as("post", "/api/venues").send({ ...marina, maxCapacity });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ maxCapacity: "Capacity must be a positive whole number" });
    expect(venueModel.createVenue).not.toHaveBeenCalled();
  });

  test("[SPM-73-TC5] should_block_a_duplicate_venue_name", async () => {
    venueModel.createVenue.mockRejectedValue(venueError("VENUE_NAME_TAKEN"));

    const response = await as("post", "/api/venues").send(marina);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "A venue with this name already exists",
      code: "VENUE_NAME_TAKEN",
      fields: { name: "A venue with this name already exists" },
    });
  });

  test("should_refuse_mass_assigned_fields_such_as_created_by", async () => {
    const response = await as("post", "/api/venues").send({ ...marina, created_by: 1, updated_by: 1 });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ created_by: MESSAGES.unknownField, updated_by: MESSAGES.unknownField });
    expect(venueModel.createVenue).not.toHaveBeenCalled();
  });

  test("should_return_a_safe_500_without_the_database_message", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    venueModel.createVenue.mockRejectedValue(Object.assign(new Error("relation venue does not exist"), { code: "42P01" }));

    const response = await as("post", "/api/venues").send(marina);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
    console.error.mockRestore();
  });
});

describe("PUT /api/venues/:venueId", () => {
  test("[SPM-73-TC6] should_save_only_the_changed_details_against_the_loaded_version", async () => {
    venueModel.updateVenue.mockResolvedValue({ venue: { ...savedVenue, maxCapacity: 650, version: 2 }, changed: true });

    const response = await as("put", "/api/venues/7").send({ maxCapacity: 650, contactNumber: "+65 6000 0000", version: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ message: "Venue updated.", changed: true }));
    expect(venueModel.updateVenue).toHaveBeenCalledWith(STAFF_ID, 7, 1, { max_capacity: 650, contact_number: "+65 6000 0000" });
  });

  test("should_report_an_unchanged_save", async () => {
    venueModel.updateVenue.mockResolvedValue({ venue: savedVenue, changed: false });

    const response = await as("put", "/api/venues/7").send({ maxCapacity: 500, version: 1 });

    expect(response.body).toEqual(expect.objectContaining({ message: "No changes to save.", changed: false }));
  });

  test("should_refuse_a_save_over_a_newer_version", async () => {
    venueModel.updateVenue.mockRejectedValue(venueError("VENUE_VERSION_CONFLICT"));

    const response = await as("put", "/api/venues/7").send({ maxCapacity: 650, version: 1 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("VENUE_VERSION_CONFLICT");
  });

  test.each(["0", "abc", "99999999999", "7.5"])("should_answer_404_for_venue_id_%p", async (id) => {
    const response = await as("put", `/api/venues/${id}`).send({ maxCapacity: 650, version: 1 });

    expect(response.status).toBe(404);
    expect(venueModel.updateVenue).not.toHaveBeenCalled();
  });

  test("should_answer_404_for_a_deleted_or_missing_venue", async () => {
    venueModel.findManagedVenueRow.mockResolvedValue(null);

    const response = await as("put", "/api/venues/7").send({ maxCapacity: 650, version: 1 });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("VENUE_NOT_FOUND");
    expect(venueModel.updateVenue).not.toHaveBeenCalled();
  });

  test("should_refuse_status_in_the_details_update", async () => {
    const response = await as("put", "/api/venues/7").send({ status: "INACTIVE", version: 1 });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ status: MESSAGES.statusNotEditable });
  });
});

describe("PUT /api/venues/:venueId/status", () => {
  test("[SPM-73-TC7] should_put_a_venue_under_maintenance_with_its_reason", async () => {
    venueModel.setVenueStatus.mockResolvedValue({
      venue: { ...savedVenue, status: "UNDER_MAINTENANCE", statusReason: "Roof repair", version: 2 },
      changed: true,
      upcomingBookings: 0,
    });

    const response = await as("put", "/api/venues/7/status").send({ status: "UNDER_MAINTENANCE", reason: "Roof repair", version: 1 });

    expect(response.status).toBe(200);
    expect(response.body.venue.status).toBe("UNDER_MAINTENANCE");
    expect(venueModel.setVenueStatus).toHaveBeenCalledWith(STAFF_ID, 7, {
      status: "UNDER_MAINTENANCE",
      reason: "Roof repair",
      version: 1,
      confirmUpcomingBookings: false,
    });
  });

  test("[SPM-73-TC7] should_require_a_reason_for_maintenance", async () => {
    const response = await as("put", "/api/venues/7/status").send({ status: "UNDER_MAINTENANCE", version: 1 });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ reason: MESSAGES.reasonRequired });
    expect(venueModel.setVenueStatus).not.toHaveBeenCalled();
  });

  const affectedEvent = {
    eventId: 442, requestId: "REQ-000442", title: "Planning summit", status: "CONFIRMED",
    firstStart: "2027-03-02T01:00:00+00:00", bookings: 2,
  };

  test("[SPM-73-TC8] should_warn_about_upcoming_bookings_before_deactivating", async () => {
    venueModel.setVenueStatus.mockRejectedValue(
      venueError("VENUE_HAS_UPCOMING_BOOKINGS", {
        upcomingBookings: 2,
        firstStart: "2027-03-02T01:00:00+00:00",
        affectedEvents: [affectedEvent],
      }),
    );

    const response = await as("put", "/api/venues/7/status").send({ status: "INACTIVE", version: 1 });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "This venue has 2 upcoming bookings. Confirm to continue; existing bookings and events are kept, "
        + "and their coordinators and organisers are notified.",
      code: "VENUE_HAS_UPCOMING_BOOKINGS",
      upcomingBookings: 2,
      firstStart: "2027-03-02T01:00:00+00:00",
      affectedEvents: [affectedEvent],
    });
  });

  test("[SPM-73-TC8] should_deactivate_after_confirmation_and_report_the_kept_bookings", async () => {
    venueModel.setVenueStatus.mockResolvedValue({
      venue: { ...savedVenue, status: "INACTIVE", version: 2 },
      changed: true,
      upcomingBookings: 2,
    });

    const response = await as("put", "/api/venues/7/status").send({ status: "INACTIVE", version: 1, confirmUpcomingBookings: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ message: "Venue status updated.", upcomingBookings: 2 }));
    expect(venueModel.setVenueStatus.mock.calls[0][2].confirmUpcomingBookings).toBe(true);
  });
});

describe("GET /api/venues/manage and /api/venues/:venueId", () => {
  test("[SPM-73-TC11] should_pass_search_location_status_and_paging_to_the_model", async () => {
    venueModel.listManagedVenues.mockResolvedValue({ venues: [savedVenue], nextOffset: null });

    const response = await as("get", "/api/venues/manage?search=marina&location=Bayfront&status=ACTIVE&limit=20&offset=40");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ venues: [savedVenue], nextOffset: null });
    expect(venueModel.listManagedVenues).toHaveBeenCalledWith(
      { search: "marina", location: "Bayfront", status: "ACTIVE", sort: "name", order: "asc" },
      { limit: 20, offset: 40 },
    );
  });

  test("[SPM-73-TC11] should_list_every_status_when_no_filter_is_set", async () => {
    venueModel.listManagedVenues.mockResolvedValue({ venues: [], nextOffset: null });

    await as("get", "/api/venues/manage");

    expect(venueModel.listManagedVenues).toHaveBeenCalledWith({ sort: "name", order: "asc" }, { limit: 50, offset: 0 });
  });

  test("should_reject_an_unknown_status_filter_or_bad_paging", async () => {
    expect((await as("get", "/api/venues/manage?status=Gone")).body.fields).toEqual({ status: MESSAGES.statusInvalid });
    expect((await as("get", "/api/venues/manage?limit=500")).status).toBe(400);
    expect(venueModel.listManagedVenues).not.toHaveBeenCalled();
  });

  test("[SPM-73-AC9] should_return_one_venue_with_who_last_changed_it", async () => {
    const venue = { ...savedVenue, updatedAt: "2026-10-19T03:00:00Z", updatedBy: { userId: STAFF_ID, name: "Venue Staff" } };
    venueModel.getManagedVenue.mockResolvedValue(venue);
    venueModel.getManagedVenueDetails.mockResolvedValue({ details: null, detailStatus: "NOT_CHECKED" });

    const response = await as("get", "/api/venues/7");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ venue, details: null, detailStatus: "NOT_CHECKED" });
    expect(venueModel.getManagedVenue).toHaveBeenCalledWith(7);
  });

  test("should_answer_404_for_a_missing_venue", async () => {
    venueModel.getManagedVenue.mockRejectedValue(venueError("VENUE_NOT_FOUND"));

    const response = await as("get", "/api/venues/7");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Venue not found.", code: "VENUE_NOT_FOUND" });
  });
});
