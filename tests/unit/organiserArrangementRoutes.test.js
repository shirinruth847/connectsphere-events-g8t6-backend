jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/organiserArrangementModel", () => ({ findOrganiserArrangements: jest.fn(), findTechnicalArrangements: jest.fn() }));
jest.mock("../../model/eventModel", () => ({
  ...jest.requireActual("../../model/eventModel"), findVisibleEvent: jest.fn(),
}));
const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");
const arrangements = require("../../model/organiserArrangementModel");
const row = { event_id: 42, organiser_id: 11, coordinator_id: 21, organisation_id: 5, status: "PLANNING" };
const signIn = (role = "ORGANISER", id = 11, organisations = []) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-id");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: id, role, organisation_ids: organisations });
};
const get = (id = "42") => request(app).get(`/api/events/${id}/arrangements`).set("Authorization", "Bearer token");

beforeEach(() => {
  jest.clearAllMocks(); signIn();
  eventModel.findVisibleEvent.mockResolvedValue({ ...row });
  arrangements.findOrganiserArrangements.mockResolvedValue({ venues: { status: "READY", bookings: [], holds: [] } });
});

test("AC1/9: owner can read arrangements and responses cannot be cached", async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(arrangements.findOrganiserArrangements).toHaveBeenCalledWith(row);
});

test("AC9: unauthenticated requests cannot load events or linked arrangements", async () => {
  expect((await request(app).get("/api/events/42/arrangements")).status).toBe(401);
  expect(eventModel.findVisibleEvent).not.toHaveBeenCalled();
  expect(arrangements.findOrganiserArrangements).not.toHaveBeenCalled();
});

test.each([
  ["unrelated organiser", "ORGANISER", 99, []],
  ["other coordinator", "COORDINATOR", 22, []],
  ["attendee", "ATTENDEE", 11, []],
  ["venue staff", "VENUE_STAFF", 11, []],
  ["technical staff", "TECH_SUPPORT", 11, []],
  ["safety officer", "SAFETY_OFFICER", 11, []],
])("AC9: %s cannot read this organiser projection", async (_, role, id, organisations) => {
  signIn(role, id, organisations);
  const res = await get();
  expect(res.status).toBe(404);
  expect(res.body).toEqual({ code: "EVENT_NOT_FOUND", error: "Event request not found." });
  expect(arrangements.findOrganiserArrangements).not.toHaveBeenCalled();
});

test("[SPM-286-AC5] the assigned coordinator reads the technical section only", async () => {
  signIn("COORDINATOR", 21);
  const technical = { status: "READY", supportStatus: "READY", requirements: [], requests: [{ requestId: 6, status: "APPROVED", equipment: [] }] };
  arrangements.findTechnicalArrangements.mockResolvedValue({ technical });
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.body).toEqual({ arrangements: { technical } });
  expect(arrangements.findTechnicalArrangements).toHaveBeenCalledWith(row);
  expect(arrangements.findOrganiserArrangements).not.toHaveBeenCalled();
});

test("preserves permitted same-organisation reads, but never shares colleagues' drafts", async () => {
  signIn("ORGANISER", 12, [5]);
  expect((await get()).status).toBe(200);
  arrangements.findOrganiserArrangements.mockClear();
  eventModel.findVisibleEvent.mockResolvedValue({ ...row, status: "DRAFT" });
  expect((await get()).status).toBe(404);
  expect(arrangements.findOrganiserArrangements).not.toHaveBeenCalled();
});

test.each(["missing", "0", "-1", "42.5"])("invalid event ID %s never loads arrangements", async (id) => {
  expect((await get(id)).status).toBe(404);
  expect(arrangements.findOrganiserArrangements).not.toHaveBeenCalled();
});

test("deleted or inaccessible events never load linked resources", async () => {
  eventModel.findVisibleEvent.mockResolvedValue(null);
  expect((await get()).status).toBe(404);
  expect(arrangements.findOrganiserArrangements).not.toHaveBeenCalled();
});


test("a concurrent arrangement change returns a safe, uncached 409 without stale sections", async () => {
  arrangements.findOrganiserArrangements.mockRejectedValueOnce(Object.assign(new Error("PRIVATE details"), { code: "ARRANGEMENTS_CHANGED" }));
  const res = await get();
  expect(res.status).toBe(409);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.body).toEqual({ code: "ARRANGEMENTS_CHANGED", error: "Arrangements changed while loading. Refresh to load the latest arrangements." });
});
