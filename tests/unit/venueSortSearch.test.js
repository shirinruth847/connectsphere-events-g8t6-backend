// SPM-181 follow-up: My Requests search and sort, My Venues sort and the venue
// options list. Supabase and MongoDB reads are stubbed; the rules under test are
// the query composition and the in-memory MongoDB sort.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/venueDetailModel", () => ({
  getVenueDetailsByIds: jest.fn(),
  getVenueDetail: jest.fn(),
  saveVenueDetails: jest.fn(),
  EDITABLE_DETAIL_FIELDS: [],
}));
jest.mock("../../model/venuePhotoModel", () => ({ findCoverPhotoIds: jest.fn().mockResolvedValue(new Map()) }));

const supabase = require("../../config/supabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueModel = require("../../model/venueModel");
const { parseBookingFilters } = require("../../validators/venueBookingValidator");
const { validateVenueListQuery } = require("../../validators/venueValidator");

// A chainable stand-in for a supabase-js query that records every call.
const queryReturning = (result) => {
  const query = { calls: [], then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["select", "eq", "in", "lt", "gt", "or", "ilike", "order", "limit", "range"]) {
    query[method] = jest.fn((...args) => {
      query.calls.push([method, ...args]);
      return query;
    });
  }
  return query;
};

beforeEach(() => {
  jest.clearAllMocks();
  supabase.from.mockReset();
});

describe("parseBookingFilters search and sort (SPM-181)", () => {
  test("[TC-VENUE-181-01] should_default_to_pending_first_ascending_when_no_sort_is_sent", () => {
    expect(parseBookingFilters({}).filters).toMatchObject({ q: null, sort: "default", order: "asc" });
  });

  test.each(["date", "attendance", "lastEdited", "alphabetical"])("[TC-VENUE-181-02] should_accept_sort_%s", (sort) => {
    expect(parseBookingFilters({ sort, order: "desc" }).filters).toMatchObject({ sort, order: "desc" });
  });

  test("[TC-VENUE-181-03] should_trim_the_search_and_drop_a_blank_one", () => {
    expect(parseBookingFilters({ q: "  hall " }).filters.q).toBe("hall");
    expect(parseBookingFilters({ q: "   " }).filters.q).toBeNull();
  });

  test.each([
    [{ sort: "lastOpened" }, "sort"],
    [{ sort: "price" }, "sort"],
    [{ order: "up" }, "order"],
    [{ q: "x".repeat(101) }, "q"],
    [{ q: ["a", "b"] }, "q"],
  ])("[TC-VENUE-181-04] should_reject_%p", (query, field) => {
    expect(parseBookingFilters(query).fields).toHaveProperty(field);
  });
});

describe("findVenueBookings search and sort (SPM-181)", () => {
  const callsFor = async (filters, { events = [], venues = [] } = {}) => {
    const eventMatches = queryReturning({ data: events, error: null });
    const venueMatches = queryReturning({ data: venues, error: null });
    const list = queryReturning({ data: [], error: null });
    const pending = queryReturning({ count: 0, error: null });
    supabase.from.mockReset();
    supabase.from.mockImplementation((table) => {
      if (table === "event") return eventMatches;
      if (table === "venue") return venueMatches;
      return supabase.from.mock.calls.filter(([name]) => name === "venue_booking").length === 1 ? list : pending;
    });
    await venueModel.findVenueBookings({ status: null, venueId: null, eventId: null, from: null, to: null, limit: 50, sort: "default", order: "asc", q: null, ...filters });
    return { list: list.calls, eventMatches: eventMatches.calls, venueMatches: venueMatches.calls };
  };

  test("[TC-VENUE-181-05] should_put_pending_first_then_the_soonest_booking_by_default", async () => {
    const { list } = await callsFor({});
    const orders = list.filter(([method]) => method === "order");
    expect(orders).toEqual([
      ["order", "status", { ascending: true }],
      ["order", "start_datetime", { ascending: true }],
      ["order", "booking_id", { ascending: true }],
    ]);
  });

  test.each([
    ["date", "start_datetime"],
    ["attendance", "expected_attendance"],
    ["lastEdited", "updated_at"],
    ["alphabetical", "event(title)"],
  ])("[TC-VENUE-181-06] should_sort_%s_descending_with_missing_values_last", async (sort, column) => {
    const { list } = await callsFor({ sort, order: "desc" });
    const orders = list.filter(([method]) => method === "order");
    expect(orders[0]).toEqual(["order", column, { ascending: false, nullsFirst: false }]);
    expect(orders.at(-1)).toEqual(["order", "booking_id", { ascending: true }]);
    expect(orders.some(([, name]) => name === "status")).toBe(false);
  });

  test("[TC-VENUE-181-07] should_search_label_title_venue_booking_id_and_request_reference", async () => {
    const { list, eventMatches, venueMatches } = await callsFor(
      { q: "110" },
      { events: [{ event_id: 442 }], venues: [{ venue_id: 45, rooms: [{ room_id: 51 }, { room_id: 52 }] }] },
    );

    expect(eventMatches).toContainEqual(["ilike", "title", "%110%"]);
    expect(venueMatches).toContainEqual(["ilike", "name", "%110%"]);
    expect(list).toContainEqual(["or", 'label.ilike."%110%",booking_id.eq.110,event_id.in.(442),room_id.in.(51,52)']);
  });

  test("[TC-VENUE-181-08] should_match_a_request_reference_and_a_hash_booking_id", async () => {
    expect((await callsFor({ q: "REQ-000442" })).list).toContainEqual(["or", 'label.ilike."%REQ-000442%",event_id.eq.442']);
    expect((await callsFor({ q: "#110" })).list).toContainEqual(["or", 'label.ilike."%#110%",booking_id.eq.110']);
  });

  test("[TC-VENUE-181-09] should_treat_search_wildcards_and_filter_syntax_literally", async () => {
    const { list, eventMatches } = await callsFor({ q: '50%_off,"x"' });

    expect(eventMatches).toContainEqual(["ilike", "title", '%50\\%\\_off,"x"%']);
    expect(list).toContainEqual(["or", 'label.ilike."%50\\\\%\\\\_off,\\"x\\"%"']);
  });

  test("[TC-VENUE-181-10] should_not_search_when_no_text_is_given", async () => {
    const { list, eventMatches } = await callsFor({ q: null });
    expect(list.some(([method]) => method === "or")).toBe(false);
    expect(eventMatches).toEqual([]);
  });

  test("[TC-VENUE-181-11] should_return_the_booking_id_and_last_edited_time_without_a_generated_reference", async () => {
    const row = {
      booking_id: 110, label: null, status: "PENDING", start_datetime: "a", end_datetime: "b", expected_attendance: 5,
      created_at: "c", updated_at: "d", event_id: 1,
      room: { venue: { venue_id: 45, name: "Hall" } },
      event: { event_id: 1, title: "T", event_type: null, status: "PLANNING" },
    };
    supabase.from.mockReturnValueOnce(queryReturning({ data: [row], error: null })).mockReturnValueOnce(queryReturning({ count: 1, error: null }))
      .mockReturnValueOnce(queryReturning({ count: 0, error: null }));

    const { bookings } = await venueModel.findVenueBookings({ limit: 10 });

    expect(bookings[0]).toMatchObject({ bookingId: 110, updatedAt: "d" });
    expect(bookings[0]).not.toHaveProperty("bookingReference");
  });
});

describe("listManagedVenues sort (SPM-181)", () => {
  const venueRow = (venueId, name) => ({ venue_id: venueId, name, address: "Road", max_capacity: 100, status: "ACTIVE", created_by: null, updated_by: null });

  test("[TC-VENUE-181-12] should_validate_the_my_venues_sort_and_order", () => {
    expect(validateVenueListQuery({ sort: "capacity", order: "desc" }).filters).toMatchObject({ sort: "capacity", order: "desc" });
    expect(validateVenueListQuery({ sort: "price" }).fields).toHaveProperty("sort");
    expect(validateVenueListQuery({ order: "sideways" }).fields).toHaveProperty("order");
  });

  test.each([
    ["capacity", "max_capacity"],
    ["updatedAt", "updated_at"],
    ["name", "name"],
  ])("[TC-VENUE-181-13] should_sort_%s_in_postgresql", async (sort, column) => {
    const venues = queryReturning({ data: [venueRow(1, "A")], error: null });
    supabase.from.mockReturnValue(venues);
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([["1", { setupMinutes: 30, turnaroundMinutes: 45 }]]));

    const result = await venueModel.listManagedVenues({ sort, order: "desc" }, { limit: 20, offset: 0 });

    expect(venues.calls).toContainEqual(["order", column, { ascending: false }]);
    expect(result.venues[0]).toMatchObject({ setupMinutes: 30, turnaroundMinutes: 45 });
    expect(result.sortNotChecked).toBe(false);
  });

  test("[TC-VENUE-181-14] should_sort_setup_minutes_in_memory_with_unrecorded_venues_last_and_page_after_sorting", async () => {
    const rows = [venueRow(1, "Alpha"), venueRow(2, "Bravo"), venueRow(3, "Charlie"), venueRow(4, "Delta")];
    supabase.from.mockReturnValue(queryReturning({ data: rows, error: null }));
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([
      ["1", { setupMinutes: 30 }],
      ["2", { setupMinutes: 0 }],
      ["4", { setupMinutes: 30 }],
    ]));

    const ascending = await venueModel.listManagedVenues({ sort: "setupMinutes", order: "asc" }, { limit: 3, offset: 0 });
    expect(ascending.venues.map((venue) => venue.venueId)).toEqual([2, 1, 4]);
    expect(ascending.nextOffset).toBe(3);

    const nextPage = await venueModel.listManagedVenues({ sort: "setupMinutes", order: "asc" }, { limit: 3, offset: 3 });
    expect(nextPage.venues.map((venue) => venue.venueId)).toEqual([3]);
    expect(nextPage.nextOffset).toBeNull();

    const descending = await venueModel.listManagedVenues({ sort: "setupMinutes", order: "desc" }, { limit: 4, offset: 0 });
    expect(descending.venues.map((venue) => venue.venueId)).toEqual([1, 4, 2, 3]);
  });

  test("[TC-VENUE-181-15] should_keep_name_order_and_flag_the_sort_when_mongodb_is_unavailable", async () => {
    supabase.from.mockReturnValue(queryReturning({ data: [venueRow(1, "Alpha"), venueRow(2, "Bravo")], error: null }));
    venueDetailModel.getVenueDetailsByIds.mockRejectedValue(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
    jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await venueModel.listManagedVenues({ sort: "turnaroundMinutes", order: "desc" }, { limit: 10, offset: 0 });

    expect(result.venues.map((venue) => venue.venueId)).toEqual([1, 2]);
    expect(result).toMatchObject({ sortNotChecked: true, detailsAvailable: false });
    expect(result.venues[0].turnaroundMinutes).toBeNull();
  });
});

describe("listVenueOptions (SPM-181)", () => {
  test("[TC-VENUE-181-16] should_list_every_non_deleted_venue_by_name", async () => {
    const venues = queryReturning({ data: [{ venue_id: 9, name: "New Hall", status: "INACTIVE" }], error: null });
    supabase.from.mockReturnValue(venues);

    await expect(venueModel.listVenueOptions()).resolves.toEqual({ venues: [{ venueId: 9, name: "New Hall", status: "INACTIVE" }] });
    expect(venues.calls).toContainEqual(["eq", "is_active", true]);
    expect(venues.calls).toContainEqual(["order", "name", { ascending: true }]);
  });

  test("[TC-VENUE-181-17] should_throw_database_errors_instead_of_returning_no_options", async () => {
    supabase.from.mockReturnValue(queryReturning({ data: null, error: { code: "XX000" } }));
    await expect(venueModel.listVenueOptions()).rejects.toEqual({ code: "XX000" });
  });
});
