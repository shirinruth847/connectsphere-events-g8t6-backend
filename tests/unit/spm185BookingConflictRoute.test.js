// Exercise the real POST controller/model path; only Auth and database I/O are mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => ({ ...jest.requireActual("../../model/eventModel"), findVisibleEvent: jest.fn() }));
jest.mock("../../config/venueLockDatabase", () => ({ getVenueLockPool: jest.fn() }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));
jest.mock("../../model/venueCalendarModel", () => ({ findCalendarEntries: jest.fn() }));
const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");
const { getVenueLockPool } = require("../../config/venueLockDatabase");
const detailModel = require("../../model/venueDetailModel");
const calendarModel = require("../../model/venueCalendarModel");
const at = time => `2030-03-10T${time}:00.000Z`;
const message = "Venue's turnaround period (12:00pm–12:45pm) overlaps with your requested booking, including its 30-minute setup from 12:00pm.";
let client;
let saveError;
beforeEach(() => {
  jest.clearAllMocks();
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: 20, role: "COORDINATOR", organisation_ids: [] });
  eventModel.findVisibleEvent.mockResolvedValue({ event_id: 42, organiser_id: 5, coordinator_id: 20, status: "PLANNING" });
  detailModel.getVenueDetailsByIds.mockResolvedValue(new Map([["7", { setupMinutes: 30, turnaroundMinutes: 45 }]]));
  calendarModel.findCalendarEntries.mockResolvedValue([]);
  saveError = Object.assign(new Error("BOOKING_CONFLICT"), { code: "P0001", detail: JSON.stringify({ index: 0, venueId: 7,
    conflicts: [{ type: "BOOKING", start: at("02:00"), end: at("04:00"), occupiedStart: at("01:30"), occupiedEnd: at("04:45") }] }) });
  client = { on: jest.fn(), removeListener: jest.fn(), release: jest.fn(), query: jest.fn(async sql => {
    if (sql.includes("begin_venue_booking_request")) return { rows: [{ result: { venues: [{ venueId: 7, isActive: true, status: "ACTIVE", name: "Hall", maxCapacity: 200 }] } }] };
    if (sql.includes("request_venue_bookings")) throw saveError;
    return { rows: [] };
  }) };
  getVenueLockPool.mockReturnValue({ connect: jest.fn().mockResolvedValue(client) });
});
const post = (start = "04:30") => request(app).post("/api/events/42/venue-bookings")
  .set("Authorization", "Bearer synthetic").set("Idempotency-Key", "spm185-post-conflict")
  .send({ bookings: [{ venueId: 7, label: "Hall", start: at(start), end: at("06:00"), expectedAttendance: 50, layout: "Theatre" }] });

test("AC2: POST returns the exact SGT explanation in root, inline and conflict messages", async () => {
  const response = await post();
  expect(response.status).toBe(409);
  expect(response.body.error).toBe(message);
  expect(response.body.fields["bookings.0.start"]).toBe(message);
  expect(response.body.conflicts[0].message).toBe(message);
  expect(client.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
});

test("AC7: exclusion violation returns conflict 409, never server error or retryable lock timeout", async () => {
  saveError = Object.assign(new Error("private constraint detail"), { code: "23P01", constraint: "venue_booking_no_overlap" });
  const response = await post();
  expect(response.status).toBe(409);
  expect(response.body.code).toBe("BOOKING_CONFLICT");
  expect(JSON.stringify(response.body)).not.toContain("private constraint");
  expect(client.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
});

test("active hold conflicts use the same SGT explanation before attempting the SQL write", async () => {
  calendarModel.findCalendarEntries.mockResolvedValue([{ venueId: 7, type: "HOLD", status: "ACTIVE", holdExpiresAt: at("01:00"),
    start: at("02:00"), end: at("04:00"), occupiedStart: at("01:30"), occupiedEnd: at("04:45") }]);
  const response = await post();
  expect(response.status).toBe(409);
  expect(response.body.error).toBe(message);
  expect(client.query.mock.calls.some(([sql]) => sql.includes("SELECT public.request_venue_bookings"))).toBe(false);
});

test("old database conflict details retain a safe generic 409 during rollout", async () => {
  const detail = JSON.parse(saveError.detail);
  delete detail.conflicts[0].start; delete detail.conflicts[0].end;
  saveError.detail = JSON.stringify(detail);
  const response = await post();
  expect(response.status).toBe(409);
  expect(response.body.error).toMatch(/including setup and turnaround/);
  expect(response.body.conflicts[0].message).toBeUndefined();
});
