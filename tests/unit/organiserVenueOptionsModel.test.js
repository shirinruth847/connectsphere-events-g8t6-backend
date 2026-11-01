jest.mock("../../config/supabase", () => ({ from: jest.fn() }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));
jest.mock("../../model/venueCalendarModel", () => ({ findCalendarEntries: jest.fn() }));

const supabase = require("../../config/supabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueCalendarModel = require("../../model/venueCalendarModel");
const venueModel = require("../../model/venueModel");

const queryReturning = (result) => {
  const query = { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["select", "eq", "in", "lt", "gt", "gte", "or", "order", "limit", "range"]) {
    query[method] = jest.fn(() => query);
  }
  query.maybeSingle = jest.fn(() => Promise.resolve(result));
  return query;
};

const at = (time, day = "2026-12-01") => new Date(`${day}T${time}:00+08:00`);
const ORGANISER = { user_id: 5, role: "ORGANISER" };

describe("getRequestVenueAvailability (SPM-76)", () => {
  const range = { from: at("00:00"), to: at("00:00", "2026-12-02") };

  beforeEach(() => {
    jest.clearAllMocks();
    supabase.from.mockReset();
  });

  const mockVenue = () => {
    supabase.from
      .mockReturnValueOnce(queryReturning({ data: { venue_id: 45 }, error: null }))
      .mockReturnValueOnce(queryReturning({ data: [{ venue_id: 45, name: "Grand Hall", address: "1 Road", operating_hours: "08:00-22:00", status: "ACTIVE", status_reason: "Internal note" }], error: null }))
      .mockReturnValueOnce(queryReturning({
        data: [{
          booking_id: 110, status: "APPROVED", event_id: 442,
          start_datetime: at("10:00").toISOString(), end_datetime: at("12:00").toISOString(),
          room: { venue_id: 45 }, event: { event_id: 442, title: "Private board meeting", coordinator_id: 98 },
        }],
        error: null,
      }))
      .mockReturnValueOnce(queryReturning({ data: [{ event_id: 500, title: "Another event", coordinator_id: 98 }], error: null }));
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([["45", { setupMinutes: 30, turnaroundMinutes: 45 }]]));
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      {
        id: "h1", venueId: 45, eventId: 500, type: "HOLD", status: "ACTIVE",
        start: at("15:00"), end: at("16:00"), occupiedStart: at("14:30"), occupiedEnd: at("16:45"),
        holdExpiresAt: new Date("2099-01-01T00:00:00Z"),
      },
      {
        id: "b1", venueId: 45, type: "BLOCK", status: "ACTIVE", reason: "SAFETY", note: "Ceiling inspection",
        start: at("18:00"), end: at("20:00"), occupiedStart: at("18:00"), occupiedEnd: at("20:00"),
      },
    ]);
  };

  test("[SPM-76-AC3][TC3] should_show_busy_periods_by_kind_without_whose_they_are", async () => {
    mockVenue();

    const result = await venueModel.getRequestVenueAvailability(45, { ...range, check: { start: at("11:00"), end: at("13:00") } }, ORGANISER);

    expect(result.venue.busyPeriods).toEqual([
      { type: "BOOKING", label: "Unavailable – booking", occupiedStart: at("09:30").toISOString(), occupiedEnd: at("12:45").toISOString() },
      { type: "HOLD", label: "Unavailable – active hold", occupiedStart: at("14:30").toISOString(), occupiedEnd: at("16:45").toISOString() },
      { type: "BLOCK", label: "Unavailable – operational block", occupiedStart: at("18:00").toISOString(), occupiedEnd: at("20:00").toISOString() },
    ]);
    expect(result.venue.check).toMatchObject({ availability: "UNAVAILABLE_BOOKING", conflicts: [expect.objectContaining({ type: "BOOKING" })] });
    const shown = JSON.stringify(result);
    for (const secret of ["Private board meeting", "Another event", "REQ-", "Ceiling inspection", "SAFETY", "Internal note", "110", "holdExpiresAt", "message"]) {
      expect(shown).not.toContain(secret);
    }
  });

  test("[SPM-76-TC4] should_not_find_a_venue_that_cannot_be_chosen", async () => {
    supabase.from.mockReturnValueOnce(queryReturning({ data: null, error: null }));
    await expect(venueModel.getRequestVenueAvailability(45, range, ORGANISER)).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
    expect(venueCalendarModel.findCalendarEntries).not.toHaveBeenCalled();
  });

  test("[SPM-76-AC7] should_never_show_a_venue_as_available_when_mongodb_is_down", async () => {
    supabase.from
      .mockReturnValueOnce(queryReturning({ data: { venue_id: 45 }, error: null }))
      .mockReturnValueOnce(queryReturning({ data: [{ venue_id: 45, name: "Grand Hall", operating_hours: "08:00-22:00", status: "ACTIVE" }], error: null }))
      .mockReturnValueOnce(queryReturning({ data: [], error: null }));
    venueDetailModel.getVenueDetailsByIds.mockRejectedValue(Object.assign(new Error("down"), { name: "MongoNetworkError" }));
    jest.spyOn(console, "warn").mockImplementation(() => {});

    await expect(venueModel.getRequestVenueAvailability(45, range, ORGANISER)).rejects.toMatchObject({ code: "AVAILABILITY_UNAVAILABLE" });
  });
});

describe("getEventVenueChoices (organiser venue cards, 1 November 2026)", () => {
  const event = {
    event_id: 42,
    start_datetime: at("11:00").toISOString(),
    end_datetime: at("13:00").toISOString(),
    expected_attendance: 100,
    preferred_layout_type: null,
    accessibility_needs: null,
    event_venue_preference: [
      { venue_id: 46, preference_order: 2, requested_start: null, requested_end: null },
      { venue_id: 45, preference_order: 1, requested_start: at("11:00").toISOString(), requested_end: at("12:00").toISOString() },
    ],
    venue_suggestions: [
      { venue_id: 47, suggested_at: "2026-11-01T02:00:00Z", withdrawn_at: null },
      { venue_id: 46, suggested_at: "2026-11-01T01:00:00Z", withdrawn_at: null },
      { venue_id: 48, suggested_at: "2026-11-01T00:00:00Z", withdrawn_at: "2026-11-01T03:00:00Z" },
    ],
  };
  const venueRow = (venue_id, name) => ({ venue_id, name, address: "1 Road", max_capacity: 300, operating_hours: "08:00-22:00", accessibility_features: null, setup_turnaround_min: null, rooms: [], status: "ACTIVE" });

  beforeEach(() => {
    jest.clearAllMocks();
    supabase.from.mockReset();
    supabase.from.mockImplementation((table) => {
      if (table === "venue") return queryReturning({ data: [venueRow(45, "Grand Hall"), venueRow(46, "Annex"), venueRow(47, "Rooftop")], error: null });
      if (table === "venue_booking") {
        return queryReturning({
          data: [{
            booking_id: 110, status: "APPROVED", event_id: 442,
            start_datetime: at("11:30").toISOString(), end_datetime: at("12:30").toISOString(),
            room: { venue_id: 45 }, event: { event_id: 442, title: "Private board meeting", coordinator_id: 98 },
          }],
          error: null,
        });
      }
      return queryReturning({ data: [{ event_id: 442, title: "Private board meeting", coordinator_id: 98 }], error: null });
    });
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map(["45", "46", "47"].map((id) => [id, { setupMinutes: 30, turnaroundMinutes: 45 }])));
    venueCalendarModel.findCalendarEntries.mockResolvedValue([]);
    // Cover photos are read from MongoDB; none here.
    jest.spyOn(require("../../model/venuePhotoModel"), "findCoverPhotoIds").mockResolvedValue(new Map());
  });

  test("should_list_the_choices_in_rank_and_the_coordinators_current_venues_by_kind_only", async () => {
    const result = await venueModel.getEventVenueChoices(event, ORGANISER);

    expect(result.preferredVenues.map((choice) => [choice.rank, choice.venueId])).toEqual([[1, 45], [2, 46]]);
    // Withdrawn venues are left out; the organiser's own choice is "selected".
    expect(result.suggestedVenues.map((item) => [item.venueId, item.fromOrganiserChoices])).toEqual([[46, true], [47, false]]);
    expect(result.suggestedVenues[1].option).toEqual(expect.objectContaining({ venueId: 47, name: "Rooftop" }));
    const grandHall = result.preferredVenues[0];
    expect(grandHall.requestedAvailability).toEqual(expect.objectContaining({ status: "UNAVAILABLE_BOOKING" }));
    expect(grandHall.requestedAvailability.conflicts).toEqual([expect.objectContaining({ type: "BOOKING", label: "Unavailable – booking" })]);
    const shown = JSON.stringify(result);
    for (const secret of ["Private board meeting", "REQ-", "holdExpiresAt", "reasonLabel"]) expect(shown).not.toContain(secret);
  });
});
