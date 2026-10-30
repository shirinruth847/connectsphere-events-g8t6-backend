jest.mock("../../config/supabase", () => ({ from: jest.fn() }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));

const supabase = require("../../config/supabase");
const venueModel = require("../../model/venueModel");
const venueDetailModel = require("../../model/venueDetailModel");

// A chainable stand-in for a supabase-js query that resolves to `result` and
// records every filter call.
const queryReturning = (result) => {
  const calls = [];
  const query = {
    calls,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ["select", "eq", "lt", "gt", "order", "limit"]) {
    query[method] = jest.fn((...args) => {
      calls.push([method, ...args]);
      return query;
    });
  }
  query.maybeSingle = jest.fn(() => Promise.resolve(result));
  return query;
};

const room = (venueId, name) => ({
  room_id: venueId * 10,
  layout_type: "Theater",
  capacity: 200,
  venue: { venue_id: venueId, name, address: `${name} Road`, max_capacity: 300, operating_hours: "08:00-22:00", setup_turnaround_min: 30 },
});

const bookingRow = (bookingId, status, venueId, name) => ({
  booking_id: bookingId,
  label: null,
  status,
  start_datetime: "2026-11-04T01:00:00+00:00",
  end_datetime: "2026-11-04T04:00:00+00:00",
  expected_attendance: 120,
  layout_type: "Theater",
  required_facilities: ["Stage"],
  accessibility_requirements: [],
  special_requirements: null,
  rejection_reason: null,
  created_at: "2026-10-07T13:32:08+00:00",
  updated_at: "2026-10-08T02:00:00+00:00",
  event_id: 442,
  room: room(venueId, name),
});

const eventRow = (status = "PLANNING") => ({
  event_id: 442,
  title: "Planning",
  event_type: "SEMINAR",
  status,
  purpose: "Review",
  description: null,
  start_datetime: "2026-11-04T00:00:00+00:00",
  end_datetime: "2026-11-04T06:00:00+00:00",
  expected_attendance: 120,
  preferred_layout_type: "Theater",
  accessibility_needs: "[\"Wheelchair access\"]",
  submitted_at: "2026-10-07T12:00:00+00:00",
  organisation: { name: "Org A" },
  coordinator: { name: "Seed Coordinator" },
});

beforeEach(() => jest.clearAllMocks());

describe("findVenueBookings", () => {
  test("[SPM-181-AC1] should_map_list_fields_and_report_more_pages", async () => {
    const rows = [1, 2, 3].map((id) => ({
      ...bookingRow(id, "PENDING", 45, "Hall A"),
      event: { event_id: 442, title: "Planning", event_type: null, status: "PLANNING" },
    }));
    const list = queryReturning({ data: rows, error: null });
    const pending = queryReturning({ count: 3, error: null });
    const approved = queryReturning({ count: 5, error: null });
    supabase.from.mockReturnValueOnce(list).mockReturnValueOnce(pending).mockReturnValueOnce(approved);

    const result = await venueModel.findVenueBookings({ status: "PENDING", venueId: 45, eventId: null, from: null, to: null, limit: 2 });

    expect(result.hasMore).toBe(true);
    expect(result.pendingCount).toBe(3);
    expect(result.approvedCount).toBe(5);
    expect(pending.eq).toHaveBeenCalledWith("status", "PENDING");
    expect(approved.eq).toHaveBeenCalledWith("status", "APPROVED");
    expect(result.bookings).toHaveLength(2);
    expect(result.bookings[0]).toEqual({
      bookingId: 1,
      label: null,
      status: "PENDING",
      statusLabel: "Pending",
      venueId: 45,
      venueName: "Hall A",
      startDatetime: "2026-11-04T01:00:00+00:00",
      endDatetime: "2026-11-04T04:00:00+00:00",
      expectedAttendance: 120,
      submittedAt: "2026-10-07T13:32:08+00:00",
      updatedAt: "2026-10-08T02:00:00+00:00",
      event: { eventId: 442, requestId: "REQ-000442", title: "Planning", status: "PLANNING", eventType: null, eventTypeLabel: null },
    });
    expect(list.calls).toEqual(expect.arrayContaining([
      ["eq", "status", "PENDING"],
      ["eq", "room.venue_id", 45],
      ["limit", 3],
    ]));
  });

  test("[SPM-181-AC5] should_filter_by_overlap_with_the_requested_day", async () => {
    const list = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValueOnce(list).mockReturnValueOnce(queryReturning({ count: 0, error: null })).mockReturnValueOnce(queryReturning({ count: 0, error: null }));

    await venueModel.findVenueBookings({ status: null, venueId: null, eventId: 442, from: "A", to: "B", limit: 100 });

    expect(list.calls).toEqual(expect.arrayContaining([["eq", "event_id", 442], ["lt", "start_datetime", "B"], ["gt", "end_datetime", "A"]]));
  });

  test("should_throw_database_errors_instead_of_returning_an_empty_list", async () => {
    supabase.from
      .mockReturnValueOnce(queryReturning({ data: null, error: { code: "42P01" } }))
      .mockReturnValueOnce(queryReturning({ count: 0, error: null }))
      .mockReturnValueOnce(queryReturning({ count: 0, error: null }));

    await expect(venueModel.findVenueBookings({ limit: 10 })).rejects.toEqual({ code: "42P01" });
  });
});

describe("findVenueBooking", () => {
  const mockEventContext = (event, bookings) => {
    supabase.from
      .mockReturnValueOnce(queryReturning({ data: { event_id: 442 }, error: null }))
      .mockReturnValueOnce(queryReturning({ data: event, error: null }))
      .mockReturnValueOnce(queryReturning({ data: bookings, error: null }));
  };

  test("[SPM-181-AC2][SPM-181-AC3] should_return_requirements_event_details_and_sibling_bookings", async () => {
    mockEventContext(eventRow(), [bookingRow(110, "PENDING", 45, "Hall A"), bookingRow(112, "REJECTED", 47, "Room C")]);
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([["45", { setupMinutes: 30, turnaroundMinutes: 45 }]]));

    const result = await venueModel.findVenueBooking(110);

    expect(result.booking).toMatchObject({
      bookingId: 110,
      requiredFacilities: ["Stage"],
      accessibilityRequirements: [],
      layoutType: "Theater",
      // SPM-186: setup and turnaround come from MongoDB, not the deprecated column.
      venue: { venueId: 45, name: "Hall A", maxCapacity: 300, setupMinutes: 30, turnaroundMinutes: 45, detailsAvailable: true },
    });
    expect(result.booking.venue).not.toHaveProperty("setupTurnaroundMinutes");
    expect(venueDetailModel.getVenueDetailsByIds).toHaveBeenCalledWith([45, 47]);
    expect(result.event).toMatchObject({
      requestId: "REQ-000442",
      eventTypeLabel: "Seminar",
      coordinatorName: "Seed Coordinator",
      organisationName: "Org A",
      accessibilityNeeds: ["Wheelchair access"],
    });
    expect(result.event).not.toHaveProperty("organiserId");
    expect(result.otherBookings).toEqual([
      expect.objectContaining({ bookingId: 112, venueName: "Room C", status: "REJECTED", statusLabel: "Rejected" }),
    ]);
    expect(result.otherBookings[0]).not.toHaveProperty("requiredFacilities");
  });

  test("[SPM-186] should_report_setup_and_turnaround_as_unknown_when_mongodb_is_down", async () => {
    mockEventContext(eventRow(), [bookingRow(110, "PENDING", 45, "Hall A")]);
    venueDetailModel.getVenueDetailsByIds.mockRejectedValue(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));

    const result = await venueModel.findVenueBooking(110);

    expect(result.booking.venue).toMatchObject({ setupMinutes: null, turnaroundMinutes: null, detailsAvailable: false });
  });

  test("should_return_null_for_a_missing_booking", async () => {
    supabase.from.mockReturnValueOnce(queryReturning({ data: null, error: null }));

    await expect(venueModel.findVenueBooking(999)).resolves.toBeNull();
  });

  test("should_hide_bookings_on_a_private_draft", async () => {
    mockEventContext(eventRow("DRAFT"), [bookingRow(110, "PENDING", 45, "Hall A")]);

    await expect(venueModel.findVenueBooking(110)).resolves.toBeNull();
  });
});
