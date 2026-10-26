jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));

const supabase = require("../../config/supabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueModel = require("../../model/venueModel");

// Venues A and B are available. The others are not: deleted as unusable
// (SPM-72), or taken out of service by Venue Staff (SPM-73).
const venueA = {
  venue_id: 1,
  name: "Venue A",
  address: "A Street",
  max_capacity: 100,
  operating_hours: "09:00-18:00",
  accessibility_features: null,
  setup_turnaround_min: 15,
  is_active: true,
  status: "ACTIVE",
  rooms: [],
};
const venueB = {
  venue_id: 2,
  name: "Venue B",
  address: "B Street",
  max_capacity: 200,
  operating_hours: "08:00-22:00",
  accessibility_features: "Lift to all floors",
  setup_turnaround_min: 30,
  is_active: true,
  status: "ACTIVE",
  rooms: [{ room_id: 8, layout_type: "THEATRE", capacity: 200 }],
};
const deletedVenue = { ...venueA, venue_id: 3, name: "Venue Z (deleted)", is_active: false };
const inactiveVenue = { ...venueA, venue_id: 4, name: "Venue Y (inactive)", status: "INACTIVE" };
const maintainedVenue = { ...venueA, venue_id: 5, name: "Venue X (maintenance)", status: "UNDER_MAINTENANCE" };

// Applies .eq() filters and .order() calls to the rows, like PostgREST would,
// so the tests check the model's query rather than a pre-filtered result.
const tableOf = (rows, error = null) => {
  const filters = [];
  const orders = [];
  const query = {
    select: jest.fn(() => query),
    eq: jest.fn((column, value) => {
      filters.push([column, value]);
      return query;
    }),
    in: jest.fn((column, values) => {
      filters.push([column, values]);
      return query;
    }),
    order: jest.fn((column, { ascending }) => {
      orders.push([column, ascending]);
      return query;
    }),
  };
  query.then = (resolve) => {
    if (error) return resolve({ data: null, error });
    const data = rows
      .filter((row) => filters.every(([column, value]) => (Array.isArray(value) ? value.includes(row[column]) : row[column] === value)))
      .sort((a, b) => {
        for (const [column, ascending] of orders) {
          if (a[column] < b[column]) return ascending ? -1 : 1;
          if (a[column] > b[column]) return ascending ? 1 : -1;
        }
        return 0;
      })
      .map(({ is_active: _active, status: _status, ...row }) => row);
    return resolve({ data, error: null });
  };
  return query;
};

const venueADetails = {
  _id: "1",
  description: "Quiet hall",
  facilities: ["Projector"],
  accessibilityFeatures: ["Step-free access"],
  supportedLayouts: ["THEATRE"],
  emergencyAccess: "North exit",
  knownRestrictions: ["No open flames"],
};

let table;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  table = tableOf([venueB, deletedVenue, maintainedVenue, venueA, inactiveVenue]);
  supabase.from.mockReturnValue(table);
  venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([["1", venueADetails]]));
});

afterEach(() => jest.restoreAllMocks());

describe("venueModel.getVenueCatalogue", () => {
  test("[TC-VC-001][SPM-72-AC2] should_list_available_venues_by_name_when_two_venues_exist", async () => {
    const result = await venueModel.getVenueCatalogue();

    expect(supabase.from).toHaveBeenCalledWith("venue");
    expect(result.venues.map(({ name }) => name)).toEqual(["Venue A", "Venue B"]);
    expect(table.order).toHaveBeenNthCalledWith(1, "name", { ascending: true });
    expect(table.order).toHaveBeenNthCalledWith(2, "venue_id", { ascending: true });
  });

  test("[TC-VC-001][SPM-72-AC3] should_show_postgres_and_mongodb_details_when_both_are_available", async () => {
    const result = await venueModel.getVenueCatalogue();

    expect(result.detailsAvailable).toBe(true);
    expect(result.venues[0]).toEqual({
      venueId: 1,
      name: "Venue A",
      address: "A Street",
      maxCapacity: 100,
      operatingHours: "09:00-18:00",
      accessibilityFeatures: ["Step-free access"],
      setupTurnaroundMinutes: 15,
      setupMinutes: null,
      turnaroundMinutes: null,
      rooms: [],
      detailStatus: "CURRENT",
      description: "Quiet hall",
      facilities: ["Projector"],
      supportedLayouts: ["THEATRE"],
      emergencyAccess: "North exit",
      knownRestrictions: ["No open flames"],
      relatedVenues: [],
    });
    expect(venueDetailModel.getVenueDetailsByIds).toHaveBeenCalledWith([1, 2]);
  });

  test("[SPM-72-AC3] should_mark_details_not_available_and_keep_postgres_fields_when_a_venue_has_no_document", async () => {
    const result = await venueModel.getVenueCatalogue();

    expect(result.venues[1]).toEqual({
      venueId: 2,
      name: "Venue B",
      address: "B Street",
      maxCapacity: 200,
      operatingHours: "08:00-22:00",
      accessibilityFeatures: ["Lift to all floors"],
      setupTurnaroundMinutes: 30,
      setupMinutes: null,
      turnaroundMinutes: null,
      rooms: [{ roomId: 8, layoutType: "THEATRE", capacity: 200 }],
      detailStatus: "NOT_AVAILABLE",
      description: null,
      facilities: null,
      supportedLayouts: null,
      emergencyAccess: null,
      knownRestrictions: null,
      relatedVenues: [],
    });
  });

  test("[SPM-75 TC-VS-003] should_match_a_venue_with_any_chosen_layout_facility_or_accessibility_feature", async () => {
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([
      ["1", { ...venueADetails, supportedLayouts: ["THEATRE"], facilities: ["Stage"], accessibilityFeatures: ["Step-free access"] }],
      ["2", { _id: "2", supportedLayouts: ["BANQUET"], facilities: ["Projector"], accessibilityFeatures: ["Hearing loop"] }],
    ]));
    const ids = async (filters) => (await venueModel.getVenueCatalogue(filters)).venues.map(({ venueId }) => venueId);

    expect(await ids({ layout: ["Theatre", "Banquet"] })).toEqual([1, 2]);
    expect(await ids({ facility: ["projector", "stage"] })).toEqual([1, 2]);
    expect(await ids({ facility: ["Stage", "Whiteboard"] })).toEqual([1]);
    expect(await ids({ accessibility: ["hearing loop", "Lift"] })).toEqual([2]);
    // Every filter used must match: a banquet layout with a stage fits neither venue.
    expect(await ids({ layout: ["Banquet"], facility: ["Stage"] })).toEqual([]);
  });

  test("[SPM-72-AC4] should_link_related_venues_by_name_when_they_are_still_available", async () => {
    // Venue A is a hall; B is one of its rooms. Deleted and inactive rooms are not linked.
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([
      ["1", { ...venueADetails, relatedVenueIds: ["2", "3", "4"] }],
      ["2", { _id: "2", relatedVenueIds: ["1"] }],
    ]));

    const result = await venueModel.getVenueCatalogue();

    expect(result.venues[0].relatedVenues).toEqual([{ venueId: 2, name: "Venue B" }]);
    expect(result.venues[1].relatedVenues).toEqual([{ venueId: 1, name: "Venue A" }]);
    expect(table.in).toHaveBeenCalledWith("venue_id", [2, 3, 4, 1]);
  });

  test("[SPM-72-AC11] should_leave_related_venues_unknown_when_mongodb_is_unavailable", async () => {
    venueDetailModel.getVenueDetailsByIds.mockRejectedValue(new Error("down"));

    const result = await venueModel.getVenueCatalogue();

    expect(result.venues.map(({ relatedVenues }) => relatedVenues)).toEqual([null, null]);
  });

  test("[TC-VC-003][SPM-72-AC4] should_exclude_a_deleted_venue_when_it_is_inactive_in_postgres", async () => {
    const result = await venueModel.getVenueCatalogue();

    expect(table.eq).toHaveBeenCalledWith("is_active", true);
    expect(result.venues.map(({ venueId }) => venueId)).toEqual([1, 2]);
    expect(result.venues.some(({ name }) => name === deletedVenue.name)).toBe(false);
    // Details are not even looked up for the deleted venue.
    expect(venueDetailModel.getVenueDetailsByIds.mock.calls[0][0]).not.toContain(deletedVenue.venue_id);
  });

  test("[SPM-73] should_exclude_inactive_and_under_maintenance_venues", async () => {
    const result = await venueModel.getVenueCatalogue();

    expect(table.eq).toHaveBeenCalledWith("status", "ACTIVE");
    expect(result.venues.map(({ name }) => name)).toEqual(["Venue A", "Venue B"]);
  });

  test("[TC-VC-002][SPM-72-AC5] should_return_an_empty_catalogue_when_no_venue_is_available", async () => {
    supabase.from.mockReturnValue(tableOf([deletedVenue, inactiveVenue, maintainedVenue]));
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map());

    const result = await venueModel.getVenueCatalogue();

    expect(result).toEqual({ venues: [], detailsAvailable: true, filtersNotChecked: [] });
    expect(venueDetailModel.getVenueDetailsByIds).toHaveBeenCalledWith([]);
  });

  test("[M4] should_return_postgres_rows_with_details_not_checked_when_mongodb_is_unavailable", async () => {
    venueDetailModel.getVenueDetailsByIds.mockRejectedValue(
      Object.assign(new Error("Mongo unavailable"), { code: "MONGODB_NOT_CONFIGURED" }),
    );

    const result = await venueModel.getVenueCatalogue();

    expect(result.detailsAvailable).toBe(false);
    expect(result.venues.map(({ detailStatus }) => detailStatus)).toEqual(["NOT_CHECKED", "NOT_CHECKED"]);
    expect(result.venues[1]).toEqual(expect.objectContaining({
      maxCapacity: 200,
      rooms: [{ roomId: 8, layoutType: "THEATRE", capacity: 200 }],
      // The PostgreSQL accessibility note is kept, not discarded.
      accessibilityFeatures: ["Lift to all floors"],
      description: null,
      facilities: null,
      supportedLayouts: null,
      emergencyAccess: null,
      knownRestrictions: null,
    }));
    expect(result.venues[0].accessibilityFeatures).toBeNull();
    expect(console.warn).toHaveBeenCalledWith("[venue-catalogue] MongoDB detail read unavailable", { code: "MONGODB_NOT_CONFIGURED" });
  });

  test("should_propagate_postgres_failures_instead_of_reporting_an_empty_catalogue", async () => {
    const databaseError = Object.assign(new Error("database unavailable"), { code: "PGRST000" });
    supabase.from.mockReturnValue(tableOf([], databaseError));

    await expect(venueModel.getVenueCatalogue()).rejects.toBe(databaseError);
    expect(venueDetailModel.getVenueDetailsByIds).not.toHaveBeenCalled();
  });
});
