// Route-level unit tests for SPM-35/SPM-37: real Express app, routes, middleware,
// controller and validator. Only the model functions that reach Supabase are mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return {
    ...actual,
    saveDraft: jest.fn(),
    submitEvent: jest.fn(),
    findVisibleEvent: jest.fn(),
    findOwnEvent: jest.fn(),
    findOrganiserEventRequests: jest.fn(),
    findValidationContext: jest.fn(),
    findUnassignedSubmittedEvents: jest.fn(),
    findCoordinatorAvailability: jest.fn(),
    assignCoordinator: jest.fn(),
  };
});

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");
const { MESSAGES } = require("../../validators/eventValidator");

const ORGANISER_ID = 11;
const KEY = "0b6f3c1e-5d0e-4bb4-9d7c-3f1a8e2b6c90";
const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const validRequest = () => ({
  title: "Tech Conference 2026",
  purpose: "Annual industry conference",
  description: "Talks and networking for tech professionals.",
  startDatetime: inDays(7),
  endDatetime: inDays(7.3),
  expectedAttendance: 150,
  preferredLayoutType: "THEATRE",
  accessibilityNeeds: ["Wheelchair access"],
  isRegistrationEnabled: true,
  registrationCapacity: 150,
});

const eventRow = (overrides = {}) => ({
  event_id: 42,
  organiser_id: ORGANISER_ID,
  status: "DRAFT",
  title: "SMU Alumni Gala 2026",
  updated_at: "2026-10-07T07:14:14.406209+00:00",
  ...overrides,
});

const domainError = (code, fields) => Object.assign(new Error(code), { name: "EventRequestError", code, fields });

const signedInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: ORGANISER_ID, role, organisation_ids: [] });
};

const send = (method, path, body, headers = {}) => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs("ORGANISER");
  eventModel.findValidationContext.mockResolvedValue({
    allowedLayouts: ["NO_PREFERENCE", "THEATRE"],
    venueIds: [1, 2],
    equipmentIds: [3],
  });
});

const ROUTES = [
  ["post", "/api/events"],
  ["post", "/api/events/drafts"],
  ["get", "/api/events/mine"],
  ["get", "/api/events/42"],
  ["put", "/api/events/42/draft"],
  ["put", "/api/events/42/submit"],
];

describe("authentication and role checks", () => {
  test.each(ROUTES)("[SPM-35-TC-004] should_return_401_when_%s_%s_has_no_session", async (method, path) => {
    const res = await request(app)[method](path);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  describe("[SPM-174] coordinator lead assignment routes", () => {
    test.each(["get", "patch"])(
      "should_allow_a_regular_coordinator_to_call_the_%s_route",
      async (method) => {
        signedInAs("COORDINATOR");
        const path = method === "get" ? "/api/events/unassigned" : "/api/events/42/coordinator";
        if (method === "get") {
          eventModel.findUnassignedSubmittedEvents.mockResolvedValue([]);
        } else {
          eventModel.assignCoordinator.mockResolvedValue(eventRow({ status: "SUBMITTED", coordinator_id: 7 }));
        }
        const res = await send(method, path, method === "patch" ? { coordinatorId: 7 } : undefined);

        expect(res.status).toBe(200);
      }
    );

    test("should_list_unassigned_requests_for_a_coordinator_lead", async () => {
      signedInAs("COORDINATOR_LEAD");
      eventModel.findUnassignedSubmittedEvents.mockResolvedValue([
        eventRow({
          event_id: 42,
          status: "SUBMITTED",
          coordinator_id: null,
          start_datetime: "2026-11-01T09:00:00.000Z",
          end_datetime: "2026-11-01T10:00:00.000Z",
        }),
      ]);

      const res = await send("get", "/api/events/unassigned");

      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([
        expect.objectContaining({ eventId: 42, requestId: "REQ-000042", status: "SUBMITTED" }),
      ]);
    });

    test("should_assign_a_request_for_a_coordinator_lead", async () => {
      signedInAs("COORDINATOR_LEAD");
      eventModel.assignCoordinator.mockResolvedValue(
        eventRow({ event_id: 42, status: "SUBMITTED", coordinator_id: 7 })
      );

      const res = await send("patch", "/api/events/42/coordinator", { coordinatorId: 7 });

      expect(res.status).toBe(200);
      expect(res.body.event).toEqual(
        expect.objectContaining({ eventId: 42, status: "SUBMITTED" })
      );
      expect(eventModel.assignCoordinator).toHaveBeenCalledWith({ eventId: 42, coordinatorId: 7 });
    });

    test("should_reject_an_invalid_coordinator_id_before_assignment", async () => {
      signedInAs("COORDINATOR_LEAD");

      const res = await send("patch", "/api/events/42/coordinator", { coordinatorId: "7" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: "Select an active Event Coordinator.",
        code: "INVALID_COORDINATOR",
      });
      expect(eventModel.assignCoordinator).not.toHaveBeenCalled();
    });

    test("should_return_a_conflict_when_assignment_finds_an_overlap", async () => {
      signedInAs("COORDINATOR_LEAD");
      eventModel.assignCoordinator.mockRejectedValue(
        domainError("COORDINATOR_CONFLICT", { coordinatorName: "Alice Coordinator" })
      );

      const res = await send("patch", "/api/events/42/coordinator", { coordinatorId: 7 });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: "The selected coordinator is unavailable during this event.",
        code: "COORDINATOR_CONFLICT",
        fields: { coordinatorName: "Alice Coordinator" },
      });
    });
  });

  test.each(["COORDINATOR", "VENUE_STAFF", "TECH_SUPPORT", "ATTENDEE"])(
    "[TC-AUTH-020] should_return_403_without_writing_when_%s_creates_an_event_request",
    async (role) => {
      signedInAs(role);

      const res = await send("post", "/api/events", validRequest(), { "Idempotency-Key": KEY });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(eventModel.submitEvent).not.toHaveBeenCalled();
    }
  );
});

describe("POST /api/events (SPM-35)", () => {
  test("[SPM-35-TC-001] should_return_201_with_request_id_and_pending_approval_when_request_is_valid", async () => {
    eventModel.submitEvent.mockResolvedValue({ event: eventRow({ status: "SUBMITTED", title: "Tech Conference 2026" }), replayed: false });

    const res = await send("post", "/api/events", validRequest(), { "Idempotency-Key": KEY });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Your event request has been submitted successfully.");
    expect(res.body.event).toEqual(
      expect.objectContaining({ eventId: 42, requestId: "REQ-000042", status: "SUBMITTED", statusLabel: "Pending Approval" })
    );
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(eventModel.submitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ organiserId: ORGANISER_ID, idempotencyKey: KEY })
    );
  });

  test("[SPM-35-TC-002] should_return_the_title_error_without_writing_when_title_is_blank", async () => {
    const res = await send("post", "/api/events", { ...validRequest(), title: "" }, { "Idempotency-Key": KEY });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Please correct the highlighted fields.",
      code: "VALIDATION_FAILED",
      fields: { title: "Event Title is required." },
    });
    expect(eventModel.submitEvent).not.toHaveBeenCalled();
  });

  test("[SPM-35-TC-003] should_return_the_lead_time_error_when_start_is_24_hours_ahead", async () => {
    const res = await send(
      "post",
      "/api/events",
      { ...validRequest(), startDatetime: inDays(1), endDatetime: inDays(1.1) },
      { "Idempotency-Key": KEY }
    );

    expect(res.status).toBe(400);
    expect(res.body.fields.startDatetime).toBe("Event date must be at least 48 hours in advance.");
  });

  test.each([["status"], ["organiserId"], ["requestId"], ["__proto__"]])(
    "[SPM-35-AC3] should_reject_server_controlled_field_%s_without_writing",
    async (field) => {
      const body = JSON.parse(`{"title":"Gala","${field}":"x"}`);

      const res = await send("post", "/api/events", body, { "Idempotency-Key": KEY });

      expect(res.status).toBe(400);
      expect(Object.prototype.hasOwnProperty.call(res.body.fields, field)).toBe(true);
      expect(eventModel.findValidationContext).not.toHaveBeenCalled();
      expect(eventModel.submitEvent).not.toHaveBeenCalled();
    }
  );

  test.each([[undefined], ["short"], ["has space in key"]])(
    "[EVT-IDEM-003] should_return_400_without_writing_when_idempotency_key_is_%p",
    async (key) => {
      const res = await send("post", "/api/events", validRequest(), key ? { "Idempotency-Key": key } : {});

      expect(res.status).toBe(400);
      expect(res.body.fields).toHaveProperty("idempotencyKey");
      expect(eventModel.submitEvent).not.toHaveBeenCalled();
    }
  );

  test("[EVT-IDEM-002] should_mark_the_response_when_the_request_is_a_replay", async () => {
    eventModel.submitEvent.mockResolvedValue({ event: eventRow({ status: "SUBMITTED" }), replayed: true });

    const res = await send("post", "/api/events", validRequest(), { "Idempotency-Key": KEY });

    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });

  test.each([
    ["NO_ELIGIBLE_COORDINATOR", 409],
    ["IDEMPOTENCY_KEY_REUSED", 409],
  ])("[EVT-ERR-004] should_return_%s_in_the_shared_error_shape", async (code, status) => {
    eventModel.submitEvent.mockRejectedValue(domainError(code));

    const res = await send("post", "/api/events", validRequest(), { "Idempotency-Key": KEY });

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: expect.any(String), code });
  });

  test("[SPM-35-AC2] should_return_field_errors_when_the_database_rejects_the_submission", async () => {
    eventModel.submitEvent.mockRejectedValue(domainError("VALIDATION_FAILED", { startDatetime: MESSAGES.leadTime }));

    const res = await send("post", "/api/events", validRequest(), { "Idempotency-Key": KEY });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Please correct the highlighted fields.",
      code: "VALIDATION_FAILED",
      fields: { startDatetime: MESSAGES.leadTime },
    });
  });

  test("[TC-AUTH-018] should_return_a_generic_500_when_an_unexpected_database_error_occurs", async () => {
    eventModel.submitEvent.mockRejectedValue({ code: "57014", message: "statement timeout" });

    const res = await send("post", "/api/events", validRequest(), { "Idempotency-Key": KEY });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("POST /api/events/drafts (SPM-37)", () => {
  test("[SPM-37-S1] should_save_a_title_only_draft_and_return_saved_at", async () => {
    eventModel.saveDraft.mockResolvedValue({ event: eventRow(), replayed: false });

    const res = await send("post", "/api/events/drafts", { title: "SMU Alumni Gala 2026" }, { "Idempotency-Key": KEY });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        message: "Draft saved successfully.",
        savedAt: "2026-10-07T07:14:14.406209+00:00",
        event: expect.objectContaining({ status: "DRAFT", statusLabel: "Draft" }),
      })
    );
  });

  test("[SPM-37-S3] should_save_a_draft_when_registration_is_enabled_before_capacity_is_entered", async () => {
    eventModel.saveDraft.mockResolvedValue({ event: eventRow({ is_registration_enabled: true }), replayed: false });

    const res = await send("post", "/api/events/drafts", { title: "Gala", isRegistrationEnabled: true }, { "Idempotency-Key": KEY });

    expect(res.status).toBe(201);
  });

  test("[SPM-37-S1] should_return_400_without_writing_when_the_draft_has_no_title", async () => {
    const res = await send("post", "/api/events/drafts", { purpose: "Notes" }, { "Idempotency-Key": KEY });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ title: MESSAGES.titleRequired });
    expect(eventModel.saveDraft).not.toHaveBeenCalled();
  });
});

describe("PUT /api/events/:id/draft (SPM-37)", () => {
  test("[SPM-37-S3] should_auto_save_with_the_auto_save_flag_and_message", async () => {
    eventModel.findOwnEvent.mockResolvedValue(eventRow());
    eventModel.saveDraft.mockResolvedValue({ event: eventRow({ expected_attendance: 200 }), replayed: false });

    const res = await send("put", "/api/events/42/draft", { expectedAttendance: 200, isAutoSave: true });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Draft auto-saved.");
    expect(eventModel.findOwnEvent).toHaveBeenCalledWith(42, ORGANISER_ID);
    expect(eventModel.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 42, isAutoSave: true, input: { expectedAttendance: 200 } })
    );
  });

  test.each([["abc"], ["0"], ["1e3"], ["99999999999"]])(
    "[TC-AUTH-013] should_return_404_without_querying_when_event_id_is_%s",
    async (id) => {
      const res = await send("put", `/api/events/${id}/draft`, { title: "Gala" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("EVENT_NOT_FOUND");
      expect(eventModel.findOwnEvent).not.toHaveBeenCalled();
    }
  );

  test("[TC-AUTH-013] should_return_404_when_the_draft_belongs_to_another_organiser", async () => {
    eventModel.findOwnEvent.mockResolvedValue(null);

    const res = await send("put", "/api/events/42/draft", { title: "Gala" });

    expect(res.status).toBe(404);
    expect(eventModel.saveDraft).not.toHaveBeenCalled();
  });

  test("[SPM-37-S2] should_return_409_when_the_request_is_no_longer_a_draft", async () => {
    eventModel.findOwnEvent.mockResolvedValue(eventRow({ status: "SUBMITTED" }));

    const res = await send("put", "/api/events/42/draft", { title: "Gala" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Only draft requests can be changed or submitted.", code: "EVENT_NOT_DRAFT" });
  });

  test("[SPM-37-S3] should_return_400_when_the_auto_save_flag_is_not_boolean", async () => {
    const res = await send("put", "/api/events/42/draft", { title: "Gala", isAutoSave: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.fields.isAutoSave).toBeDefined();
  });

  test("[SPM-37-S1] should_validate_the_merged_draft_when_a_change_conflicts_with_saved_values", async () => {
    eventModel.findOwnEvent.mockResolvedValue(
      eventRow({ start_datetime: "2026-11-01T09:00:00+00:00", end_datetime: "2026-11-01T17:00:00+00:00" })
    );

    const res = await send("put", "/api/events/42/draft", { startDatetime: "2026-11-01T18:00:00+00:00" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ endDatetime: MESSAGES.endBeforeStart });
  });
});

describe("PUT /api/events/:id/submit (SPM-37)", () => {
  test("[SPM-37-TC-NEG-INCOMPLETE] should_keep_the_draft_when_expected_attendance_is_missing", async () => {
    const body = validRequest();
    delete body.expectedAttendance;
    eventModel.findOwnEvent.mockResolvedValue(eventRow());

    const res = await send("put", "/api/events/42/submit", body);

    expect(res.status).toBe(400);
    expect(res.body.fields.expectedAttendance).toBe("Expected Attendance is required for submission");
    expect(eventModel.submitEvent).not.toHaveBeenCalled();
  });

  test("[SPM-37-S4] should_submit_a_completed_draft", async () => {
    eventModel.findOwnEvent.mockResolvedValue(eventRow());
    eventModel.submitEvent.mockResolvedValue({ event: eventRow({ status: "SUBMITTED" }), replayed: false });

    const res = await send("put", "/api/events/42/submit", validRequest());

    expect(res.status).toBe(200);
    expect(res.body.event.statusLabel).toBe("Pending Approval");
    expect(eventModel.submitEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 42, organiserId: ORGANISER_ID }));
  });
});

describe("GET /api/events/:id and /mine", () => {
  test("[SPM-37-S4] should_return_the_draft_with_ownership_when_prefilling_edit_draft", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ organisation: null }));

    const res = await send("get", "/api/events/42");

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual(expect.objectContaining({ eventId: 42, isOwner: true, organisation: null }));
  });

  test("[TC-AUTH-013] should_return_404_when_the_request_is_not_visible", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(null);

    const res = await send("get", "/api/events/42");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event request not found.", code: "EVENT_NOT_FOUND" });
  });

  test("[SPM-35-AC5] should_return_events_and_next_cursor_when_listing_drafts", async () => {
    eventModel.findOrganiserEventRequests.mockResolvedValue({ events: [{ eventId: 42 }], nextCursor: "abc" });

    const res = await send("get", "/api/events/mine?status=DRAFT&limit=10&cursor=eyJh");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [{ eventId: 42 }], nextCursor: "abc" });
    expect(eventModel.findOrganiserEventRequests).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: ORGANISER_ID }),
      { limit: 10, cursor: "eyJh", status: "DRAFT" }
    );
  });

  test.each([["APPROVED"], ["drafts"]])("[SPM-35-AC5] should_return_400_when_status_filter_is_%s", async (status) => {
    const res = await send("get", `/api/events/mine?status=${status}`);

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ status: "Unknown status filter." });
  });

  test("[TC-AUTH-021] should_return_400_when_the_cursor_cannot_be_decoded", async () => {
    eventModel.findOrganiserEventRequests.mockRejectedValue(domainError("INVALID_CURSOR"));

    const res = await send("get", "/api/events/mine?cursor=abc");

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ cursor: "Invalid page cursor." });
  });
});
