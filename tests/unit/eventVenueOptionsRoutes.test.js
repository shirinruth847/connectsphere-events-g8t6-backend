jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => ({
  ...jest.requireActual("../../model/eventModel"),
  findVisibleEvent: jest.fn(),
}));
jest.mock("../../model/venueModel", () => ({
  getEventVenueOptions: jest.fn(),
  listSelectableVenuePhotos: jest.fn(),
  getSelectableVenuePhotoImage: jest.fn(),
  suggestEventVenue: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");
const venueModel = require("../../model/venueModel");

const COORDINATOR_ID = 20;
const LEAD_ID = 10;
const PHOTO_ID = "6716f0c2a1b2c3d4e5f60718";
const venueError = (code) => Object.assign(new Error(code), { name: "VenueError", code });

const signedInAs = (userId, role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
};
const eventRow = (overrides = {}) => ({
  event_id: 42,
  organiser_id: 5,
  coordinator_id: COORDINATOR_ID,
  status: "UNDER_REVIEW",
  ...overrides,
});
const send = (method, path, body, key = "spm72-suggest-0001") => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  if (key) req = req.set("Idempotency-Key", key);
  return body === undefined ? req : req.send(body);
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs(COORDINATOR_ID, "COORDINATOR");
  eventModel.findVisibleEvent.mockResolvedValue(eventRow());
  venueModel.getEventVenueOptions.mockResolvedValue({ event: { eventId: 42 }, venues: [], detailsAvailable: true, availabilityChecked: true, filtersNotChecked: [] });
});

describe("GET /api/events/:id/venue-options (SPM-72/74)", () => {
  test("[SPM-72-AC1] should_return_401_without_a_session", async () => {
    const response = await request(app).get("/api/events/42/venue-options");
    expect(response.status).toBe(401);
    expect(venueModel.getEventVenueOptions).not.toHaveBeenCalled();
  });

  test("[SPM-72-AC1] should_return_options_and_the_select_permission_to_the_assigned_coordinator", async () => {
    const response = await send("get", "/api/events/42/venue-options?search=Hall&requiredFacilities=Projector,%20Stage&sort=capacity&order=desc");

    expect(response.status).toBe(200);
    expect(response.body.canSuggestVenue).toBe(true);
    const [event, viewer, options] = venueModel.getEventVenueOptions.mock.calls[0];
    expect(event.event_id).toBe(42);
    expect(viewer.user_id).toBe(COORDINATOR_ID);
    expect(options).toEqual({
      filters: { search: "Hall" },
      requiredFacilities: ["Projector", "Stage"],
      sort: "capacity",
      order: "desc",
    });
  });

  test("[SPM-72-AC2] should_return_read_only_options_to_the_supervising_lead", async () => {
    signedInAs(LEAD_ID, "COORDINATOR_LEAD");
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ supervising_lead_id: LEAD_ID }));

    const response = await send("get", "/api/events/42/venue-options");

    expect(response.status).toBe(200);
    expect(response.body.canSuggestVenue).toBe(false);
  });

  test("[SPM-72-AC8] should_not_offer_selection_outside_review_and_planning", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status: "SAFETY_REVIEW" }));

    const response = await send("get", "/api/events/42/venue-options");

    expect(response.status).toBe(200);
    expect(response.body.canSuggestVenue).toBe(false);
  });

  test.each(["ORGANISER", "VENUE_STAFF", "TECH_SUPPORT", "ATTENDEE"])("[SPM-72-AC1] should_return_403_for_%s", async (role) => {
    signedInAs(30, role);

    const response = await send("get", "/api/events/42/venue-options");

    expect(response.status).toBe(403);
    expect(eventModel.findVisibleEvent).not.toHaveBeenCalled();
  });

  test("[SPM-72-AC1] should_answer_not_found_for_an_event_outside_the_viewers_scope", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(null);

    const response = await send("get", "/api/events/42/venue-options");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("EVENT_NOT_FOUND");
    expect(venueModel.getEventVenueOptions).not.toHaveBeenCalled();
  });

  test("[SPM-72-AC1] should_answer_not_found_for_a_coordinator_who_is_not_assigned", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ coordinator_id: 99 }));

    const response = await send("get", "/api/events/42/venue-options");

    expect(response.status).toBe(404);
  });

  test.each([
    ["sort=price", "sort"],
    ["order=up", "order"],
    ["status=ACTIVE", "status"],
    ["minCapacity=0", "minCapacity"],
    [`requiredFacilities=${Array.from({ length: 11 }, (_, i) => `f${i}`).join(",")}`, "requiredFacilities"],
    [`requiredFacilities=${"x".repeat(101)}`, "requiredFacilities"],
  ])("[SPM-72-AC3] should_reject_%p", async (query, field) => {
    const response = await send("get", `/api/events/42/venue-options?${query}`);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_FAILED");
    expect(response.body.fields).toHaveProperty(field);
    expect(venueModel.getEventVenueOptions).not.toHaveBeenCalled();
  });

  test("should_return_a_safe_500_when_the_model_fails", async () => {
    venueModel.getEventVenueOptions.mockRejectedValue(new Error("relation venue does not exist"));

    const response = await send("get", "/api/events/42/venue-options");

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("relation");
  });
});

describe("GET /api/venues/options/:venueId/photos (SPM-72 AC4)", () => {
  test.each([["COORDINATOR", COORDINATOR_ID], ["COORDINATOR_LEAD", LEAD_ID]])("[SPM-72-AC4] should_list_photos_of_an_available_venue_to_%s", async (role, userId) => {
    signedInAs(userId, role);
    venueModel.listSelectableVenuePhotos.mockResolvedValue({ photos: [{ photoId: PHOTO_ID, position: 0 }] });

    const response = await send("get", "/api/venues/options/7/photos");

    expect(response.status).toBe(200);
    expect(venueModel.listSelectableVenuePhotos).toHaveBeenCalledWith(7);
  });

  test("[SPM-72-AC4] should_serve_the_image_with_nosniff", async () => {
    venueModel.getSelectableVenuePhotoImage.mockResolvedValue({ contentType: "image/png", data: Buffer.from([137, 80, 78, 71]) });

    const response = await send("get", `/api/venues/options/7/photos/${PHOTO_ID}`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  test.each([
    ["/api/venues/options/abc/photos", "VENUE_NOT_FOUND"],
    ["/api/venues/options/7/photos/not-an-id", "PHOTO_NOT_FOUND"],
  ])("[SPM-72-AC4] should_return_404_for_%s", async (path, code) => {
    const response = await send("get", path);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe(code);
  });

  test("[SPM-72-AC4] should_return_404_for_a_venue_that_cannot_be_chosen", async () => {
    venueModel.listSelectableVenuePhotos.mockRejectedValue(venueError("VENUE_NOT_FOUND"));

    const response = await send("get", "/api/venues/options/7/photos");

    expect(response.status).toBe(404);
  });

  test.each(["ORGANISER", "VENUE_STAFF", "TECH_SUPPORT", "ATTENDEE"])("[SPM-72-AC1] should_refuse_photos_to_%s", async (role) => {
    signedInAs(30, role);

    const response = await send("get", "/api/venues/options/7/photos");

    expect(response.status).toBe(403);
    expect(venueModel.listSelectableVenuePhotos).not.toHaveBeenCalled();
  });
});

describe("PUT /api/events/:id/venue-suggestion (SPM-72 AC8)", () => {
  const suggestion = { venueId: 7, name: "Grand Hall", address: "1 Road", maxCapacity: 300, suggestedAt: "2026-10-23T04:00:00Z", suggestedBy: { userId: COORDINATOR_ID, name: "C" }, version: 1 };

  test("[SPM-72-AC8] should_suggest_the_venue_as_the_signed_in_coordinator", async () => {
    venueModel.suggestEventVenue.mockResolvedValue(suggestion);

    const response = await send("put", "/api/events/42/venue-suggestion", { venueId: 7, version: 0 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Grand Hall was suggested to the organiser.", suggestion });
    expect(venueModel.suggestEventVenue).toHaveBeenCalledWith({
      actorId: COORDINATOR_ID,
      eventId: 42,
      venueId: 7,
      expectedVersion: 0,
      idempotencyKey: "spm72-suggest-0001",
    });
  });

  test("[SPM-72-AC2] should_refuse_the_supervising_lead", async () => {
    signedInAs(LEAD_ID, "COORDINATOR_LEAD");

    const response = await send("put", "/api/events/42/venue-suggestion", { venueId: 7, version: 0 });

    expect(response.status).toBe(403);
    expect(venueModel.suggestEventVenue).not.toHaveBeenCalled();
  });

  test.each([
    [{ venueId: 7, version: 0, actorId: 1 }, "actorId"],
    [{ venueId: 7, version: 0, status: "PLANNING" }, "status"],
    [{ venueId: "7", version: 0 }, "venueId"],
    [{ venueId: 0, version: 0 }, "venueId"],
    [{ venueId: 7 }, "version"],
    [{ venueId: 7, version: -1 }, "version"],
  ])("[SPM-72-AC8] should_reject_%p", async (body, field) => {
    const response = await send("put", "/api/events/42/venue-suggestion", body);

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty(field);
    expect(venueModel.suggestEventVenue).not.toHaveBeenCalled();
  });

  test("[SPM-72-AC10] should_require_an_idempotency_key", async () => {
    const response = await send("put", "/api/events/42/venue-suggestion", { venueId: 7, version: 0 }, null);

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty("idempotencyKey");
  });

  test.each([
    ["EVENT_NOT_FOUND", 404],
    ["VENUE_SUGGESTION_NOT_ALLOWED_IN_STATUS", 409],
    ["VENUE_NOT_SELECTABLE", 409],
    ["VENUE_CAPACITY_TOO_SMALL", 409],
    ["VENUE_SUGGESTION_VERSION_CONFLICT", 409],
    ["IDEMPOTENCY_KEY_REUSED", 409],
  ])("[SPM-72-AC10] should_map_%s_to_%i", async (code, status) => {
    venueModel.suggestEventVenue.mockRejectedValue(venueError(code));

    const response = await send("put", "/api/events/42/venue-suggestion", { venueId: 7, version: 0 });

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
  });
});
