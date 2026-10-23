// Route-level unit tests for GET /api/registrations/mine/:eventId (SPM-155 AC4,
// AC5): real Express app, routes, middleware and controller. Only the model
// call that reaches Supabase is mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return { ...actual, findRegisteredAttendeeEvent: jest.fn(), findPublishedAttendeeEvent: jest.fn() };
});

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");

const ATTENDEE_ID = 21;
const NOT_FOUND = { error: "Event request not found.", code: "EVENT_NOT_FOUND" };
const FORBIDDEN = { error: "You do not have permission to access this resource.", code: "FORBIDDEN" };

const signedInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: ATTENDEE_ID, role, organisation_ids: [] });
};

const get = (path) => request(app).get(path).set("Authorization", "Bearer token");

const found = {
  event: {
    eventId: 42,
    title: "Gala",
    description: null,
    startDatetime: null,
    endDatetime: null,
    organisationName: null,
    location: null,
    registrationAvailability: "CLOSED",
    registrationOpenAt: null,
    registrationCloseAt: null,
    attendeeStatus: "CANCELLED",
    detailsWithheld: true,
  },
  myRegistration: { status: "WAITLISTED", registeredAt: "2026-10-01T00:00:00+00:00" },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs("ATTENDEE");
});

describe("GET /api/registrations/mine/:eventId", () => {
  test("[SPM-155 AC4/AC5] returns the event and the attendee's own place", async () => {
    eventModel.findRegisteredAttendeeEvent.mockResolvedValue(found);
    const res = await get("/api/registrations/mine/42");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(found);
    expect(eventModel.findRegisteredAttendeeEvent).toHaveBeenCalledWith(42, ATTENDEE_ID);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("[SPM-155 AC6] an event the attendee holds no place on is not found", async () => {
    eventModel.findRegisteredAttendeeEvent.mockResolvedValue(null);
    const res = await get("/api/registrations/mine/42");
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  });

  test.each(["0", "abc", "1.5", "99999999999"])("[SPM-155] ID %s is not found without a database call", async (id) => {
    const res = await get(`/api/registrations/mine/${id}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
    expect(eventModel.findRegisteredAttendeeEvent).not.toHaveBeenCalled();
  });

  test("[SPM-155-TC-12] signed-out requests are refused", async () => {
    const res = await request(app).get("/api/registrations/mine/42");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
    expect(eventModel.findRegisteredAttendeeEvent).not.toHaveBeenCalled();
  });

  test.each(["ORGANISER", "COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "TECH_SUPPORT", "SAFETY_OFFICER"])(
    "[SPM-155] %s is forbidden without a database call",
    async (role) => {
      signedInAs(role);
      const res = await get("/api/registrations/mine/42");
      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN);
      expect(eventModel.findRegisteredAttendeeEvent).not.toHaveBeenCalled();
    }
  );

  test("[SPM-155] a database failure is a safe 500", async () => {
    eventModel.findRegisteredAttendeeEvent.mockRejectedValue(new Error("[Supabase Error] connection reset"));
    const res = await get("/api/registrations/mine/42");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("GET /api/events/discovery/:id stays as on main (SPM-34)", () => {
  test("[SPM-155] the discovery detail never adds the attendee's registration", async () => {
    const detail = { eventId: 42, title: "Gala", registrationAvailability: "OPEN" };
    eventModel.findPublishedAttendeeEvent.mockResolvedValue(detail);
    const res = await get("/api/events/discovery/42");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event: detail });
    expect(eventModel.findPublishedAttendeeEvent).toHaveBeenCalledWith(42);
    expect(eventModel.findRegisteredAttendeeEvent).not.toHaveBeenCalled();
  });
});
