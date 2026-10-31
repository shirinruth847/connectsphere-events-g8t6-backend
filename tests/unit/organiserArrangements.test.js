jest.mock("../../config/supabase", () => ({ from: jest.fn() }));
jest.mock("../../model/venueCalendarModel", () => ({ findEventHolds: jest.fn(), findCalendarEntries: jest.fn() }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));

const supabase = require("../../config/supabase");
const calendar = require("../../model/venueCalendarModel");
const details = require("../../model/venueDetailModel");
const { findOrganiserArrangements, findTechnicalArrangements } = require("../../model/organiserArrangementModel");

const now = new Date("2030-01-01T00:00:00Z");
const event = { event_id: 42, status: "PLANNING", arrangement_version: 3 };
const booking = (id, venueId, status = "APPROVED") => ({
  booking_id: id, event_id: 42, status, label: `Room ${id}`,
  start_datetime: "2030-02-01T02:00:00Z", end_datetime: "2030-02-01T04:00:00Z",
  room: { venue: { venue_id: venueId, name: `Venue ${venueId}` } },
  internal_notes: "PRIVATE booking note", requested_by: 999,
});
let tables;
let failures;
let calls;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  tables = { event: { ...event }, venue_booking: [], venue: [1, 2].map((id) => ({
    venue_id: id, name: id === 1 ? "Main Hall" : "Breakout Hall", status: "ACTIVE", is_active: true,
  })),
    resource_incidents: [], technical_requests: [], technical_request: [], equipment_request: [], event_equipment_requirement: [], safety_reviews: [] };
  failures = {};
  calls = [];
  supabase.from.mockImplementation((table) => {
    const call = { table, filters: [] }; calls.push(call);
    const query = { then: (resolve, reject) => Promise.resolve({ data: tables[table], error: failures[table] }).then(resolve, reject) };
    for (const method of ["select", "eq", "in", "is", "order", "maybeSingle"]) query[method] = (...args) => { call.filters.push([method, ...args]); return query; };
    return query;
  });
  calendar.findEventHolds.mockResolvedValue([]);
  calendar.findCalendarEntries.mockResolvedValue([]);
  details.getVenueDetailsByIds.mockResolvedValue(new Map(["1", "2"].map((id) => [id, { setupMinutes: 30, turnaroundMinutes: 15 }])));
});
afterEach(() => jest.restoreAllMocks());

test("AC3: all bookings retain their own status and explicit primary designation", async () => {
  tables.venue_booking = [
    { ...booking(1, 1), is_primary: true }, { ...booking(2, 2, "PENDING"), is_primary: false }, booking(3, 2, "REJECTED"),
  ];
  const { venues } = await findOrganiserArrangements(event, () => now);
  expect(venues.bookings.map((item) => [item.venueName, item.status, item.isPrimary])).toEqual([
    ["Main Hall", "APPROVED", true], ["Breakout Hall", "PENDING", false], ["Breakout Hall", "REJECTED", false],
  ]);
  expect(venues.primaryVenueStatus).toBe("READY");
  expect(venues.bookings[0]).toMatchObject({ startDatetime: tables.venue_booking[0].start_datetime, label: "Room 1" });
});

test("AC3: legacy primary follows the existing sole-active-booking rule; multiple venues are never guessed", async () => {
  tables.venue_booking = [booking(1, 1), booking(2, 2, "REJECTED")];
  expect((await findOrganiserArrangements(event, () => now)).venues.bookings[0].isPrimary).toBe(true);
  tables.venue_booking.push(booking(3, 2));
  const result = await findOrganiserArrangements(event, () => now);
  expect(result.venues.bookings.every((item) => !item.isPrimary)).toBe(true);
  expect(result.venues.primaryVenueStatus).toBe("NOT_DESIGNATED");
  tables.venue_booking = [{ ...booking(1, 1), is_primary: false }];
  expect((await findOrganiserArrangements(event, () => now)).venues.bookings[0].isPrimary).toBe(false);
});

test("AC4: overdue ACTIVE holds expire at read time, including the exact expiry boundary", async () => {
  calendar.findEventHolds.mockResolvedValue(["2029-12-31", "2030-01-01", "2030-01-02"].map((expiry, index) => ({
    id: String(index), venueId: 1, label: null, status: "ACTIVE", holdExpiresAt: `${expiry}T00:00:00Z`,
    start: "2030-02-01T02:00:00Z", end: "2030-02-01T04:00:00Z",
    occupiedStart: "2030-02-01T01:30:00Z", occupiedEnd: "2030-02-01T04:15:00Z",
    note: "PRIVATE hold note", eventId: 42,
  })));
  const { venues } = await findOrganiserArrangements(event, () => now);
  expect(venues.holds.map((hold) => hold.status)).toEqual(["EXPIRED", "EXPIRED", "ACTIVE"]);
  expect(calendar.findEventHolds).toHaveBeenCalledWith(42);
  expect(JSON.stringify(venues)).not.toContain("PRIVATE");
});

test("AC5: operational blocks overlapping setup time flag only affected venues and give a pending next action", async () => {
  tables.venue_booking = [booking(1, 1), booking(2, 2)];
  calendar.findCalendarEntries.mockResolvedValue([{ type: "BLOCK", status: "ACTIVE", venueId: 1,
    occupiedStart: "2030-02-01T01:40:00Z", occupiedEnd: "2030-02-01T01:50:00Z", note: "PRIVATE block note" }]);
  const { venues } = await findOrganiserArrangements(event, () => now);
  expect(venues.bookings[0].impact).toMatchObject({ status: "AFFECTED", nextAction: "Your coordinator will decide the next action." });
  expect(venues.bookings[1].impact.status).toBe("NOT_REPORTED");
  expect(event.status).toBe("PLANNING");
  expect(JSON.stringify(venues)).not.toContain("PRIVATE");
});

test("AC5: recorded incidents remain visible without MongoDB and resolved incidents describe the recorded action", async () => {
  tables.venue_booking = [booking(1, 1), booking(2, 2)];
  tables.resource_incidents = [{ booking_id: 1, status: "OPEN" }, { booking_id: 2, status: "RESOLVED", resolution: "REPLACED" }];
  calendar.findCalendarEntries.mockRejectedValue(new Error("PRIVATE provider failure"));
  const { venues } = await findOrganiserArrangements(event, () => now);
  expect(venues.bookings[0].impact.status).toBe("AFFECTED");
  expect(venues.bookings[1].impact).toMatchObject({ status: "RESOLVED", nextAction: "A replacement venue has been arranged." });
  expect(venues.availabilityStatus).toBe("UNAVAILABLE");
});

test.each([
  ["maintenance", "UNDER_MAINTENANCE", true],
  ["inactive", "INACTIVE", true],
  ["unusable", "ACTIVE", false],
])("AC5: %s venue state affects its active bookings and holds without incident storage", async (_, status, isActive) => {
  tables.venue[0] = { ...tables.venue[0], status, is_active: isActive, status_reason: "PRIVATE maintenance reason" };
  tables.venue_booking = [booking(1, 1), booking(2, 1, "PENDING"), booking(3, 2)];
  failures.resource_incidents = { code: "PGRST205" };
  calendar.findEventHolds.mockResolvedValue([1, 2].map((venueId) => ({
    id: `hold-${venueId}`, venueId, status: "ACTIVE", holdExpiresAt: "2030-01-02T00:00:00Z",
    start: "2030-02-01T02:00:00Z", end: "2030-02-01T04:00:00Z",
    occupiedStart: "2030-02-01T01:30:00Z", occupiedEnd: "2030-02-01T04:15:00Z",
  })));
  const { venues } = await findOrganiserArrangements(event, () => now);
  expect(venues.bookings.map((item) => item.status)).toEqual(["APPROVED", "PENDING", "APPROVED"]);
  for (const item of [...venues.bookings.slice(0, 2), venues.holds[0]]) {
    expect(item.impact).toEqual({ status: "AFFECTED", message: "This venue arrangement is affected by unavailability.",
      nextAction: "Your coordinator will decide the next action." });
  }
  expect(venues.bookings[2].impact.status).toBe("UNKNOWN");
  expect(venues.holds[1].impact.status).toBe("UNKNOWN");
  expect(venues.availabilityStatus).toBe("UNAVAILABLE");
  expect(JSON.stringify(venues)).not.toContain("PRIVATE");
  expect(calls.find((call) => call.table === "venue").filters)
    .toContainEqual(["select", "venue_id,name,status,is_active"]);
});

test("AC5: known venue unavailability survives unavailable calendar and buffer reads", async () => {
  tables.venue[0].status = "UNDER_MAINTENANCE";
  tables.venue_booking = [booking(1, 1)];
  failures.resource_incidents = { code: "42P01" };
  details.getVenueDetailsByIds.mockRejectedValue(new Error("PRIVATE MongoDB outage"));
  calendar.findEventHolds.mockRejectedValue(new Error("PRIVATE MongoDB outage"));
  const { venues } = await findOrganiserArrangements(event, () => now);
  expect(venues.bookings[0]).toMatchObject({ status: "APPROVED", impact: {
    status: "AFFECTED", nextAction: "Your coordinator will decide the next action.",
  } });
  expect(venues.holdsStatus).toBe("UNAVAILABLE");
  expect(venues.availabilityStatus).toBe("UNAVAILABLE");
  expect(JSON.stringify(venues)).not.toContain("PRIVATE");
});

test.each([
  ["before", "2029-12-31T23:59:59.999Z", "INACTIVE"],
  ["at", "2030-01-01T00:00:00Z", "INACTIVE"],
  ["after", "2030-01-01T00:00:00.001Z", "AFFECTED"],
])("AC5: occupied periods ending %s the response clock preserve historical accuracy", async (_, occupiedEnd, expected) => {
  tables.venue[0].status = "UNDER_MAINTENANCE";
  tables.venue_booking = [{ ...booking(1, 1), start_datetime: "2029-12-31T22:00:00Z", end_datetime: occupiedEnd }];
  tables.resource_incidents = [{ booking_id: 1, status: "OPEN" }];
  details.getVenueDetailsByIds.mockResolvedValue(new Map([["1", { setupMinutes: 0, turnaroundMinutes: 0 }]]));
  calendar.findEventHolds.mockResolvedValue([{ id: "hold-1", venueId: 1, status: "ACTIVE",
    holdExpiresAt: "2030-01-02T00:00:00Z", start: "2029-12-31T22:00:00Z", end: occupiedEnd,
    occupiedStart: "2029-12-31T22:00:00Z", occupiedEnd }]);
  const { venues } = await findOrganiserArrangements(event, () => now);
  expect(venues.bookings[0].impact.status).toBe(expected);
  expect(venues.holds[0].impact.status).toBe(expected);
  if (expected === "INACTIVE") {
    expect(venues.bookings[0].impact.nextAction).toBeNull();
    expect(venues.holds[0].impact.nextAction).toBeNull();
  }
  tables.resource_incidents = [{ booking_id: 1, status: "RESOLVED", resolution: "RESTORED" }];
  expect((await findOrganiserArrangements(event, () => now)).venues.bookings[0].impact.status)
    .toBe(expected === "INACTIVE" ? "RESOLVED" : "AFFECTED");
});

test("AC5: ongoing turnaround remains affected, but ends during delayed reads without a current warning", async () => {
  tables.venue[0].status = "UNDER_MAINTENANCE";
  tables.venue_booking = [{ ...booking(1, 1), start_datetime: "2029-12-31T22:00:00Z", end_datetime: "2029-12-31T23:59:00Z" }];
  details.getVenueDetailsByIds.mockResolvedValue(new Map([["1", { setupMinutes: 0, turnaroundMinutes: 2 }]]));
  expect((await findOrganiserArrangements(event, () => now)).venues.bookings[0].impact.status).toBe("AFFECTED");
  let responseTime = now;
  calendar.findCalendarEntries.mockImplementation(async () => {
    responseTime = new Date("2030-01-01T00:01:00Z");
    return [];
  });
  expect((await findOrganiserArrangements(event, () => responseTime)).venues.bookings[0].impact)
    .toEqual({ status: "INACTIVE", message: null, nextAction: null });
});

test("AC6/8: canonical technical needs, decisions and support are allowlisted independently", async () => {
  tables.event_equipment_requirement = [{ equipment_id: 1, quantity_requested: 3, equipment: { name: "Projector" } }];
  tables.technical_requests = [{ request_id: 7, status: "PENDING", support_required: true, support_notes: "PRIVATE support note",
    technical_request_lines: [{ equipment_id: 1, quantity: 2, equipment: { name: "Projector" }, internal_notes: "PRIVATE" }] }];
  const { technical } = await findOrganiserArrangements(event, () => now);
  expect(technical.requirements).toEqual([{ equipmentId: 1, quantity: 3, name: "Projector" }]);
  expect(technical.requests[0]).toEqual({ requestId: 7, status: "PENDING", supportRequired: true,
    equipment: [{ equipmentId: 1, quantity: 2, name: "Projector" }] });
  expect(JSON.stringify(technical)).not.toContain("PRIVATE");
});

test("AC6: existing equipment requests remain readable when canonical technical tables are absent", async () => {
  failures.technical_requests = { code: "PGRST205" };
  tables.equipment_request = [{ equip_request_id: 9, equipment_id: 1, quantity_requested: 2,
    status: "APPROVED", equipment: { name: "Projector" }, technical_notes: "PRIVATE notes" }];
  const { technical } = await findOrganiserArrangements(event, () => now);
  expect(technical.supportStatus).toBe("UNAVAILABLE");
  expect(technical.requests[0]).toMatchObject({ requestId: null, status: "APPROVED", supportRequired: null });
  expect(JSON.stringify(technical)).not.toContain("PRIVATE");
});

test("[SPM-286-AC4][SPM-287] one row per technical request header with its lines, not one per line", async () => {
  failures.technical_requests = { code: "PGRST205" };
  tables.technical_request = [
    { technical_request_id: 12, status: "PENDING", created_at: "2030-01-02T00:00:00Z", decided_at: null, equipment_request: [
      { equipment_id: 2, quantity_requested: 1, equipment: { name: "Speaker" } },
      { equipment_id: 1, quantity_requested: 3, equipment: { name: "Microphone" } },
    ] },
    { technical_request_id: 11, status: "REJECTED", created_at: "2030-01-01T00:00:00Z", decided_at: "2030-01-01T05:00:00Z", equipment_request: [
      { equipment_id: 1, quantity_requested: 2, equipment: { name: "Microphone" } },
    ] },
  ];
  const { technical } = await findOrganiserArrangements(event, () => now);
  expect(technical.requests).toEqual([
    { requestId: 12, status: "PENDING", supportRequired: null, createdAt: "2030-01-02T00:00:00Z", decidedAt: null,
      equipment: [{ equipmentId: 1, name: "Microphone", quantity: 3 }, { equipmentId: 2, name: "Speaker", quantity: 1 }] },
    { requestId: 11, status: "REJECTED", supportRequired: null, createdAt: "2030-01-01T00:00:00Z", decidedAt: "2030-01-01T05:00:00Z",
      equipment: [{ equipmentId: 1, name: "Microphone", quantity: 2 }] },
  ]);
  const looseQuery = calls.find((call) => call.table === "equipment_request");
  expect(looseQuery.filters).toContainEqual(["is", "technical_request_id", null]);
});

test("[SPM-286-AC5] the coordinator projection carries the technical section only", async () => {
  failures.technical_requests = { code: "PGRST205" };
  tables.technical_request = [{ technical_request_id: 6, status: "APPROVED", created_at: "2030-01-01T00:00:00Z", decided_at: null, equipment_request: [] }];
  const result = await findTechnicalArrangements(event);
  expect(Object.keys(result)).toEqual(["technical"]);
  expect(result.technical.requests.map((request) => request.requestId)).toEqual([6]);
  expect(calls.some((call) => ["venue_booking", "safety_reviews"].includes(call.table))).toBe(false);
});

test.each(["PENDING", "APPROVED", "REJECTED", "NOT_REQUIRED", "CANCELLED", "SUPERSEDED"])("AC6: preserves technical outcome %s", async (status) => {
  tables.technical_requests = [{ request_id: 7, status, support_required: false, technical_request_lines: [] }];
  expect((await findOrganiserArrangements(event, () => now)).technical.requests[0].status).toBe(status);
});

test("AC7/8: only current-version safety reviews count as current; staff fields never leave the API", async () => {
  tables.safety_reviews = [{ review_id: 5, round_number: 2, arrangement_version: 3, status: "OPEN", organiser_comment: "Please keep exits clear",
    internal_notes: "PRIVATE notes", checklist: { secret: "PRIVATE checklist" }, requested_changes: ["PRIVATE"], claimed_by: 999 },
  { review_id: 4, round_number: 1, arrangement_version: 2, status: "APPROVED", organiser_comment: "Earlier approval" }];
  const { safety } = await findOrganiserArrangements(event, () => now);
  expect(safety.reviews.map((review) => review.isCurrent)).toEqual([true, false]);
  expect(safety.reviews[0].organiserComment).toBe("Please keep exits clear");
  expect(JSON.stringify(safety)).not.toContain("PRIVATE");
  expect(JSON.stringify(safety)).not.toContain("claimed_by");
  expect(event.status).toBe("PLANNING");
});

test("AC10: true empty data stays distinct from service failures and missing incident storage", async () => {
  const empty = await findOrganiserArrangements(event, () => now);
  expect(empty.venues).toMatchObject({ status: "READY", bookings: [], holds: [] });
  expect(empty.technical).toMatchObject({ status: "READY", requirements: [], requests: [] });
  expect(empty.safety).toEqual({ status: "READY", reviews: [] });
  failures.safety_reviews = { code: "42501", message: "PRIVATE database error" };
  failures.resource_incidents = { code: "42P01" };
  calendar.findEventHolds.mockRejectedValue(new Error("PRIVATE MongoDB failure"));
  const degraded = await findOrganiserArrangements(event, () => now);
  expect(degraded.safety).toEqual({ status: "UNAVAILABLE" });
  expect(degraded.venues).toMatchObject({ status: "READY", holdsStatus: "UNAVAILABLE", availabilityStatus: "UNAVAILABLE" });
  expect(JSON.stringify(degraded)).not.toContain("PRIVATE");
});

test("AC8/9: every arrangement query is scoped to the authorised event; reads never mutate it", async () => {
  const original = JSON.stringify(event);
  await findOrganiserArrangements(event, () => now);
  for (const call of calls.filter((call) => call.table !== "venue")) {
    expect(call.filters).toContainEqual(["eq", "event_id", 42]);
    const selection = call.filters.find(([method]) => method === "select")[1];
    if (call.table !== "venue_booking") expect(selection).not.toMatch(/internal_notes|technical_notes|support_notes|checklist|requested_changes/);
  }
  expect(JSON.stringify(event)).toBe(original);
  // The stand-in exposes no insert/update/delete/rpc methods: any write fails.
});

test("drafts have empty arrangements without accessing resource stores", async () => {
  expect((await findOrganiserArrangements({ ...event, status: "DRAFT" }, () => now)).venues.bookings).toEqual([]);
  expect(supabase.from).not.toHaveBeenCalled();
  expect(calendar.findEventHolds).not.toHaveBeenCalled();
});


test("AC7: rejects an interleaved arrangement edit instead of showing the old approval as current", async () => {
  tables.safety_reviews = [{ review_id: 5, round_number: 2, arrangement_version: 3, status: "APPROVED" }];
  details.getVenueDetailsByIds.mockImplementation(async () => {
    tables.event.arrangement_version = 4;
    tables.venue_booking = [booking(2, 2)];
    return new Map();
  });
  await expect(findOrganiserArrangements(event, () => now)).rejects.toMatchObject({ code: "ARRANGEMENTS_CHANGED" });
});

test.each(["status", "version"])("a concurrent event %s change also invalidates the read", async (field) => {
  tables.event[field] = field === "status" ? "CANCELLED" : 2;
  await expect(findOrganiserArrangements(event, () => now)).rejects.toMatchObject({ code: "ARRANGEMENTS_CHANGED" });
});

test("a failed consistency check never returns an apparently current approval", async () => {
  failures.event = { code: "08006", message: "PRIVATE connection error" };
  await expect(findOrganiserArrangements(event, () => now)).rejects.toMatchObject({ code: "08006" });
});

test.each(["CANCELLED", "REJECTED", "RELEASED"])("AC5: %s bookings receive no current block or pending-action warning", async (status) => {
  tables.venue[0].status = "UNDER_MAINTENANCE";
  tables.venue_booking = [booking(1, 1, status)];
  tables.resource_incidents = [{ booking_id: 1, status: "OPEN" }];
  calendar.findCalendarEntries.mockResolvedValue([{ type: "BLOCK", status: "ACTIVE", venueId: 1,
    occupiedStart: "2030-02-01T01:40:00Z", occupiedEnd: "2030-02-01T01:50:00Z" }]);
  const { venues } = await findOrganiserArrangements(event, () => now);
  expect(venues.bookings[0].impact).toEqual({ status: "INACTIVE", message: null, nextAction: null });
  tables.resource_incidents = [{ booking_id: 1, status: "RESOLVED", resolution: "RELEASED" }];
  expect((await findOrganiserArrangements(event, () => now)).venues.bookings[0].impact)
    .toMatchObject({ status: "RESOLVED", nextAction: "The affected venue booking has been released." });
});

test("AC4/5: holds expire at response projection after delayed reads, and inactive holds have no pending action", async () => {
  tables.venue[0].status = "UNDER_MAINTENANCE";
  let currentTime = now;
  calendar.findEventHolds.mockResolvedValue(["ACTIVE", "RELEASED", "CONVERTED", "EXPIRED"].map((status) => ({
    id: status, venueId: 1, status, holdExpiresAt: "2030-01-01T00:00:01Z",
    start: "2030-02-01T02:00:00Z", end: "2030-02-01T04:00:00Z",
    occupiedStart: "2030-02-01T01:30:00Z", occupiedEnd: "2030-02-01T04:15:00Z",
  })));
  calendar.findCalendarEntries.mockImplementation(async () => {
    currentTime = new Date("2030-01-01T00:00:02Z");
    return [{ type: "BLOCK", status: "ACTIVE", venueId: 1,
      occupiedStart: "2030-02-01T01:40:00Z", occupiedEnd: "2030-02-01T01:50:00Z" }];
  });
  const { venues } = await findOrganiserArrangements(event, () => currentTime);
  expect(venues.holds.map((hold) => hold.status)).toEqual(["EXPIRED", "RELEASED", "CONVERTED", "EXPIRED"]);
  expect(venues.holds.every((hold) => hold.impact.status === "INACTIVE" && hold.impact.nextAction === null)).toBe(true);
});
