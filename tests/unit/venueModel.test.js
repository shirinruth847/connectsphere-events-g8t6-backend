jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));

const supabase = require("../../config/supabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueModel = require("../../model/venueModel");

const rows = [
  {
    venue_id: 2,
    name: "Venue B",
    address: "B Street",
    max_capacity: 200,
    operating_hours: "08:00-22:00",
    accessibility_features: "Lift",
    setup_turnaround_min: 30,
    rooms: [{ room_id: 8, layout_type: "THEATRE", capacity: 200 }],
  },
  {
    venue_id: 1,
    name: "Venue A",
    address: "A Street",
    max_capacity: 100,
    operating_hours: "09:00-18:00",
    accessibility_features: null,
    setup_turnaround_min: 15,
    rooms: [],
  },
];

const queryFor = (data, error = null) => {
  const query = {
    select: jest.fn(() => query),
    order: jest.fn(() => query),
  };
  query.then = (resolve) => resolve({ data, error });
  return query;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  supabase.from.mockReturnValue(queryFor(rows));
  venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([
    ["1", {
      description: "Quiet hall",
      facilities: ["Projector"],
      accessibilityFeatures: ["Step-free access"],
      supportedLayouts: ["THEATRE"],
      emergencyAccess: "North exit",
      knownRestrictions: [],
    }],
  ]));
});

afterEach(() => jest.restoreAllMocks());

describe("venueModel.getVenueCatalogue", () => {
  test("[TC-VC-001] should_map_postgres_venue_and_room_fields_with_mongodb_details", async () => {
    const result = await venueModel.getVenueCatalogue();

    expect(result.detailsAvailable).toBe(true);
    expect(result.venues).toEqual([
      expect.objectContaining({
        venueId: 2,
        name: "Venue B",
        rooms: [{ roomId: 8, layoutType: "THEATRE", capacity: 200 }],
        detailStatus: "NOT_AVAILABLE",
      }),
      expect.objectContaining({
        venueId: 1,
        detailStatus: "CURRENT",
        description: "Quiet hall",
        facilities: ["Projector"],
        emergencyAccess: "North exit",
      }),
    ]);
    expect(venueDetailModel.getVenueDetailsByIds).toHaveBeenCalledWith([2, 1]);
  });

  test("[TC-VC-003] should_exclude_a_deleted_venue_when_its_postgres_row_is_absent", async () => {
    supabase.from.mockReturnValue(queryFor([rows[0]]));

    const result = await venueModel.getVenueCatalogue();

    expect(result.venues.map(({ venueId }) => venueId)).toEqual([2]);
    expect(result.venues.some(({ venueId }) => venueId === 1)).toBe(false);
  });

  test("[AC-VC-003] should_return_postgres_catalogue_rows_when_mongodb_details_are_unavailable", async () => {
    venueDetailModel.getVenueDetailsByIds.mockRejectedValue(Object.assign(new Error("Mongo unavailable"), { code: "MONGODB_NOT_CONFIGURED" }));

    const result = await venueModel.getVenueCatalogue();

    expect(result.detailsAvailable).toBe(false);
    expect(result.venues[0]).toEqual(expect.objectContaining({
      venueId: 2,
      detailStatus: "NOT_CHECKED",
      description: "not checked",
      facilities: "not checked",
      supportedLayouts: "not checked",
      accessibilityFeatures: "not checked",
    }));
    expect(console.warn).toHaveBeenCalledWith("[venue-catalogue] MongoDB detail read unavailable", { code: "MONGODB_NOT_CONFIGURED" });
  });

  test("[TC-VC-002] should_return_an_empty_catalogue_without_connecting_to_mongodb", async () => {
    supabase.from.mockReturnValue(queryFor([]));

    const result = await venueModel.getVenueCatalogue();

    expect(result).toEqual({ venues: [], detailsAvailable: true });
    expect(venueDetailModel.getVenueDetailsByIds).toHaveBeenCalledWith([]);
  });

  test("should_propagate_postgres_failures_instead_of_reporting_success", async () => {
    const databaseError = Object.assign(new Error("database unavailable"), { code: "PGRST000" });
    supabase.from.mockReturnValue(queryFor(null, databaseError));

    await expect(venueModel.getVenueCatalogue()).rejects.toBe(databaseError);
    expect(venueDetailModel.getVenueDetailsByIds).not.toHaveBeenCalled();
  });
});
