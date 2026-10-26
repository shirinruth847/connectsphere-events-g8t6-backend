jest.mock("../../config/supabase", () => ({ from: jest.fn() }));
jest.mock("../../model/venueDetailModel", () => ({
  getVenueDetailsByIds: jest.fn(),
  getVenueDetail: jest.fn(),
  saveVenueDetails: jest.fn(),
  EDITABLE_DETAIL_FIELDS: ["description", "facilities", "accessibilityFeatures", "supportedLayouts", "emergencyAccess", "knownRestrictions", "setupMinutes", "turnaroundMinutes"],
}));
jest.mock("../../model/venueCalendarModel", () => ({ findCalendarEntries: jest.fn() }));
jest.mock("../../model/activityModel", () => ({ appendActivity: jest.fn() }));

const supabase = require("../../config/supabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueCalendarModel = require("../../model/venueCalendarModel");
const activityModel = require("../../model/activityModel");
const venueModel = require("../../model/venueModel");

// A chainable stand-in for a supabase-js query resolving to `result`.
const queryReturning = (result) => {
  const query = { calls: [], then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["select", "eq", "in", "lt", "gt", "gte", "or", "order", "limit", "range"]) {
    query[method] = jest.fn((...args) => {
      query.calls.push([method, ...args]);
      return query;
    });
  }
  query.maybeSingle = jest.fn(() => Promise.resolve(result));
  return query;
};

const at = (time, day = "2026-11-04") => new Date(`${day}T${time}:00+08:00`);
const venueRow = { venue_id: 45, name: "Grand Hall", address: "1 Harbourfront Walk", version: 4, contact_email: "a@b.co", contact_number: null };

beforeEach(() => {
  jest.clearAllMocks();
  supabase.from.mockReset();
});

describe("updateVenueDetails (SPM-73, Master 5.4.1, 7.4)", () => {
  const mockVenueRow = () => supabase.from.mockReturnValueOnce(queryReturning({ data: venueRow, error: null }));

  test("should_save_changed_fields_and_append_the_audit_entry", async () => {
    mockVenueRow();
    venueDetailModel.getVenueDetail.mockResolvedValue({ version: 2, facilities: ["Stage"], setupMinutes: 30 });
    venueDetailModel.saveVenueDetails.mockResolvedValue({ version: 3, facilities: ["Stage", "PA"], setupMinutes: 30 });

    const result = await venueModel.updateVenueDetails(3, 45, 2, { facilities: ["Stage", "PA"], setupMinutes: 30 });

    expect(result.changed).toBe(true);
    expect(result.details).toMatchObject({ facilities: ["Stage", "PA"], version: 3 });
    expect(venueDetailModel.saveVenueDetails).toHaveBeenCalledWith(expect.objectContaining({
      venueId: 45, expectedVersion: 2, fields: { facilities: ["Stage", "PA"] }, name: "Grand Hall", pgVersion: 4, actorId: 3,
    }));
    expect(activityModel.appendActivity).toHaveBeenCalledWith(expect.objectContaining({
      userId: 3, entityId: 45, action: "VENUE_DETAILS_UPDATED", audience: "STAFF_ONLY",
      changes: { facilities: { before: ["Stage"], after: ["Stage", "PA"] } },
    }));
  });

  test("should_not_write_when_nothing_changed", async () => {
    mockVenueRow();
    venueDetailModel.getVenueDetail.mockResolvedValue({ version: 2, setupMinutes: 30 });

    const result = await venueModel.updateVenueDetails(3, 45, 2, { setupMinutes: 30 });

    expect(result.changed).toBe(false);
    expect(venueDetailModel.saveVenueDetails).not.toHaveBeenCalled();
    expect(activityModel.appendActivity).not.toHaveBeenCalled();
  });

  test("[T16] should_refuse_to_change_a_setup_or_turnaround_time_once_set", async () => {
    mockVenueRow();
    venueDetailModel.getVenueDetail.mockResolvedValue({ version: 2, setupMinutes: 30, turnaroundMinutes: 0 });

    await expect(venueModel.updateVenueDetails(3, 45, 2, { setupMinutes: 60, turnaroundMinutes: 15 })).rejects.toMatchObject({
      code: "VENUE_BUFFERS_LOCKED",
      fields: ["setupMinutes", "turnaroundMinutes"],
    });
    expect(venueDetailModel.saveVenueDetails).not.toHaveBeenCalled();
  });

  test("[T16] should_set_each_time_once_and_guard_the_write", async () => {
    mockVenueRow();
    venueDetailModel.getVenueDetail.mockResolvedValue({ version: 2, setupMinutes: 30 });
    venueDetailModel.saveVenueDetails.mockResolvedValue({ version: 3, setupMinutes: 30, turnaroundMinutes: 45 });

    await expect(venueModel.updateVenueDetails(3, 45, 2, { setupMinutes: 30, turnaroundMinutes: 45 })).resolves.toMatchObject({ changed: true });
    expect(venueDetailModel.saveVenueDetails).toHaveBeenCalledWith(expect.objectContaining({
      fields: { turnaroundMinutes: 45 },
      unsetFields: ["turnaroundMinutes"],
    }));
  });

  test("[T16] should_allow_zero_as_a_first_value_and_then_lock_it", async () => {
    mockVenueRow();
    venueDetailModel.getVenueDetail.mockResolvedValue({ version: 1, setupMinutes: 0, turnaroundMinutes: 0 });

    await expect(venueModel.updateVenueDetails(3, 45, 1, { setupMinutes: 5 })).rejects.toMatchObject({ code: "VENUE_BUFFERS_LOCKED", fields: ["setupMinutes"] });
  });

  test("should_refuse_a_stale_version_before_any_write", async () => {
    mockVenueRow();
    venueDetailModel.getVenueDetail.mockResolvedValue({ version: 3 });

    await expect(venueModel.updateVenueDetails(3, 45, 2, { setupMinutes: 60 })).rejects.toMatchObject({ code: "VENUE_DETAILS_VERSION_CONFLICT" });
  });

  test("should_answer_not_found_for_a_deleted_venue", async () => {
    supabase.from.mockReturnValueOnce(queryReturning({ data: null, error: null }));

    await expect(venueModel.updateVenueDetails(3, 45, 0, { setupMinutes: 60 })).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
  });

  test("[Master 7.4] should_report_mongodb_unavailable", async () => {
    mockVenueRow();
    venueDetailModel.getVenueDetail.mockRejectedValue(Object.assign(new Error("timeout"), { name: "MongoServerSelectionError" }));

    await expect(venueModel.updateVenueDetails(3, 45, 0, { setupMinutes: 60 })).rejects.toMatchObject({ code: "VENUE_DETAILS_UNAVAILABLE" });
  });

  test("[Master 7.4 step 3] should_keep_the_saved_details_when_the_audit_entry_fails", async () => {
    mockVenueRow();
    venueDetailModel.getVenueDetail.mockResolvedValue({ version: 2 });
    venueDetailModel.saveVenueDetails.mockResolvedValue({ version: 3, description: "New" });
    activityModel.appendActivity.mockRejectedValue({ code: "42501" });
    jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(venueModel.updateVenueDetails(3, 45, 2, { description: "New" })).resolves.toMatchObject({ changed: true });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("getVenueAvailability (SPM-74)", () => {
  const range = { from: at("00:00"), to: at("00:00", "2026-11-05") };
  const bookingRow = (coordinatorId) => ({
    booking_id: 110,
    status: "APPROVED",
    start_datetime: at("10:00").toISOString(),
    end_datetime: at("12:00").toISOString(),
    event_id: 442,
    room: { venue_id: 45 },
    event: { event_id: 442, title: "Private planning forum", coordinator_id: coordinatorId },
  });

  const mockStores = (coordinatorId = 98) => {
    supabase.from
      .mockReturnValueOnce(queryReturning({ data: [{ venue_id: 45, name: "Grand Hall", address: "1 Road", operating_hours: "08:00-22:00", status: "ACTIVE" }], error: null }))
      .mockReturnValueOnce(queryReturning({ data: [bookingRow(coordinatorId)], error: null }));
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([["45", { setupMinutes: 30, turnaroundMinutes: 45 }]]));
    venueCalendarModel.findCalendarEntries.mockResolvedValue([]);
  };

  test("[SPM-74-TC2][TC3] should_use_the_mongodb_buffers_for_postgres_bookings", async () => {
    mockStores();

    const result = await venueModel.getVenueAvailability(range, { user_id: 7, role: "VENUE_STAFF" });

    const [venue] = result.venues;
    expect(venue).toMatchObject({ venueId: 45, setupMinutes: 30, turnaroundMinutes: 45, buffersRecorded: true, summary: "UNAVAILABLE_BOOKING" });
    expect(venue.entries[0]).toMatchObject({
      bookingId: 110,
      occupiedStart: at("09:30").toISOString(),
      occupiedEnd: at("12:45").toISOString(),
      eventTitle: "Private planning forum",
    });
  });

  test("event context excludes its own booking and hold but retains another event's hold", async () => {
    mockStores(7);
    supabase.from.mockReturnValueOnce(queryReturning({ data: [], error: null }));
    const hold = (id, eventId) => ({
      id, venueId: 45, eventId, type: "HOLD", status: "ACTIVE",
      start: at("10:00"), end: at("12:00"), occupiedStart: at("09:30"), occupiedEnd: at("12:45"),
      holdExpiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    venueCalendarModel.findCalendarEntries.mockResolvedValue([hold("own", 442), hold("other", 500)]);
    const result = await venueModel.getVenueAvailability({ ...range, excludeEventId: 442, check: { start: at("10:00"), end: at("12:00") } }, { user_id: 7, role: "COORDINATOR" });
    expect(result.venues[0].entries).toHaveLength(1);
    expect(result.venues[0].entries[0].type).toBe("HOLD");
    expect(result.venues[0].entries[0].requestId).toBe("REQ-000500");
    expect(result.venues[0].check.availability).toBe("UNAVAILABLE_HOLD");

    mockStores(7);
    const ownOnly = await venueModel.getVenueAvailability({ ...range, excludeEventId: 442, check: { start: at("10:00"), end: at("12:00") } }, { user_id: 7, role: "COORDINATOR" });
    expect(ownOnly.venues[0].entries).toEqual([]);
    expect(ownOnly.venues[0].check.availability).toBe("AVAILABLE");
  });

  test("[Master 4.2] should_hide_titles_of_events_not_assigned_to_the_coordinator", async () => {
    mockStores(98);
    const other = await venueModel.getVenueAvailability(range, { user_id: 7, role: "COORDINATOR" });
    expect(other.venues[0].entries[0]).toMatchObject({ requestId: "REQ-000442", eventTitle: null });

    mockStores(7);
    const own = await venueModel.getVenueAvailability(range, { user_id: 7, role: "COORDINATOR" });
    expect(own.venues[0].entries[0].eventTitle).toBe("Private planning forum");
  });

  test("[SPM-74-TC13] should_refuse_rather_than_show_availability_when_mongodb_is_down", async () => {
    mockStores();
    venueCalendarModel.findCalendarEntries.mockRejectedValue(Object.assign(new Error("down"), { name: "MongoServerSelectionError" }));
    jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(venueModel.getVenueAvailability(range, { user_id: 7, role: "VENUE_STAFF" })).rejects.toMatchObject({ code: "AVAILABILITY_UNAVAILABLE" });
  });

  test("[Master 5.4.1] should_flag_venues_without_recorded_buffers", async () => {
    mockStores();
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map());

    const result = await venueModel.getVenueAvailability(range, { user_id: 7, role: "VENUE_STAFF" });

    expect(result.venues[0]).toMatchObject({ setupMinutes: null, turnaroundMinutes: null, buffersRecorded: false });
  });

  test("should_return_no_venues_without_reading_bookings", async () => {
    supabase.from.mockReturnValueOnce(queryReturning({ data: [], error: null }));

    await expect(venueModel.getVenueAvailability(range, { user_id: 7, role: "VENUE_STAFF" })).resolves.toMatchObject({ venues: [] });
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });
});

describe("getVenueCatalogue filters", () => {
  const rows = [
    { venue_id: 1, name: "Grand Hall", address: "1 Road", max_capacity: 300, rooms: [{ room_id: 1, layout_type: "Theater", capacity: 300 }], accessibility_features: null },
    { venue_id: 2, name: "Studio", address: "2 Road", max_capacity: 80, rooms: [{ room_id: 2, layout_type: "Boardroom", capacity: 80 }], accessibility_features: "Lift" },
  ];

  test("should_search_name_or_address_literally_and_filter_by_capacity", async () => {
    const query = queryReturning({ data: rows, error: null });
    supabase.from.mockReturnValueOnce(query);
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map());

    await venueModel.getVenueCatalogue({ search: "50%_off, (x)", minCapacity: 50 });

    expect(query.calls).toEqual(expect.arrayContaining([
      ["or", 'name.ilike."%50\\\\%\\\\_off, (x)%",address.ilike."%50\\\\%\\\\_off, (x)%"'],
      ["gte", "max_capacity", 50],
    ]));
  });

  test("should_filter_layout_facility_and_accessibility_on_details", async () => {
    supabase.from.mockReturnValueOnce(queryReturning({ data: rows, error: null }));
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([
      ["1", { facilities: ["Stage", "PA system"], accessibilityFeatures: ["Hearing loop"] }],
      ["2", { facilities: ["Whiteboard"] }],
    ]));

    const byFacility = await venueModel.getVenueCatalogue({ facility: "pa sys" });
    expect(byFacility.venues.map((venue) => venue.venueId)).toEqual([1]);
  });

  test("[M4] should_report_the_facility_filter_as_not_checked_without_mongodb", async () => {
    supabase.from.mockReturnValueOnce(queryReturning({ data: rows, error: null }));
    venueDetailModel.getVenueDetailsByIds.mockRejectedValue(new Error("down"));
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await venueModel.getVenueCatalogue({ facility: "Stage", layout: "board", accessibility: "lift" });

    expect(result).toMatchObject({ detailsAvailable: false, filtersNotChecked: ["facility"] });
    expect(result.venues.map((venue) => venue.venueId)).toEqual([2]);
  });
});
