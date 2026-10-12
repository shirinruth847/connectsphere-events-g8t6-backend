// Route-level unit tests for SPM-33: real Express app, routes, middleware, controller,
// access policy and validators. Only the model functions that reach Supabase are mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/activityModel");
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return {
    ...actual,
    saveDraft: jest.fn(),
    updateEventDetails: jest.fn(),
    findEventForViewer: jest.fn(),
    findValidationContext: jest.fn(),
  };
});

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");
const activityModel = require("../../model/activityModel");
const { MESSAGES } = require("../../validators/eventValidator");

const ORGANISER_ID = 11;
const COLLEAGUE_ID = 12;
const COORDINATOR_ID = 21;
const ORGANISATION_ID = 5;
const KEY = "0b6f3c1e-5d0e-4bb4-9d7c-3f1a8e2b6c90";

const eventRow = (overrides = {}) => ({
  event_id: 42,
  organiser_id: ORGANISER_ID,
  organisation_id: ORGANISATION_ID,
  coordinator_id: COORDINATOR_ID,
  status: "UNDER_REVIEW",
  title: "SMU Alumni Gala 2026",
  purpose: "Reunion",
  description: "An evening for alumni.",
  expected_attendance: 50,
  version: 3,
  updated_at: "2026-10-07T07:14:14.406209+00:00",
  ...overrides,
});

const draftRow = (overrides = {}) => eventRow({ status: "DRAFT", coordinator_id: null, ...overrides });

const domainError = (code, fields) => Object.assign(new Error(code), { name: "EventRequestError", code, fields });

const signedInAs = (role, userId, organisationIds = []) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: organisationIds });
};
const asOwner = () => signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
const asColleague = () => signedInAs("ORGANISER", COLLEAGUE_ID, [ORGANISATION_ID]);
const asCoordinator = () => signedInAs("COORDINATOR", COORDINATOR_ID);

const send = (method, path, body, headers = { "Idempotency-Key": KEY }) => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};

const expectNothingSaved = () => {
  expect(eventModel.saveDraft).not.toHaveBeenCalled();
  expect(eventModel.updateEventDetails).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  asCoordinator();
  eventModel.findValidationContext.mockResolvedValue({ allowedLayouts: ["NO_PREFERENCE"], venueIds: [], equipmentIds: [] });
});

describe("GET /api/events/:id (AC1)", () => {
  test("[SPM-33-TC-01] should_return_the_full_draft_with_edit_permissions_when_the_owner_opens_it", async () => {
    asOwner();
    eventModel.findEventForViewer.mockResolvedValue(draftRow());

    const res = await send("get", "/api/events/42");

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual(
      expect.objectContaining({ eventId: 42, version: 3, isOwner: true, viewerRelationship: "OWNER" })
    );
    expect(res.body.event.permissions).toEqual(
      expect.objectContaining({ canEdit: true, canViewDraftHistory: true, canViewStaffHistory: false })
    );
    expect(res.body.event.permissions.editableFields).toEqual(expect.arrayContaining(["title", "expectedAttendance"]));
  });

  test("[SPM-33-TC-03] should_return_a_read_only_view_without_staff_fields_when_a_colleague_opens_a_submitted_event", async () => {
    asColleague();
    eventModel.findEventForViewer.mockResolvedValue(eventRow({ status: "SUBMITTED" }));

    const res = await send("get", "/api/events/42");

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual(
      expect.objectContaining({ isOwner: false, viewerRelationship: "ORGANISATION_MEMBER" })
    );
    expect(res.body.event.permissions).toEqual({
      canEdit: false,
      editableFields: [],
      canViewDraftHistory: false,
      canViewStaffHistory: false,
    });
    expect(res.body.event).not.toHaveProperty("coordinatorId");
    expect(res.body.event).not.toHaveProperty("organiser");
  });

  test("[SPM-33-TC-05] should_return_the_coordination_view_when_the_assigned_coordinator_opens_the_event", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow({ organiser: { user_id: ORGANISER_ID, name: "Organiser A" } }));

    const res = await send("get", "/api/events/42");

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual(
      expect.objectContaining({
        viewerRelationship: "ASSIGNED_COORDINATOR",
        coordinatorId: COORDINATOR_ID,
        organiser: { userId: ORGANISER_ID, name: "Organiser A" },
        permissions: {
          canEdit: true,
          editableFields: ["title", "purpose", "description"],
          canViewDraftHistory: false,
          canViewStaffHistory: true,
        },
      })
    );
  });

  test.each(["COORDINATOR", "VENUE_STAFF", "TECH_SUPPORT", "ATTENDEE", "COORDINATOR_LEAD"])(
    "[SPM-33-TC-06] should_return_404_when_%s_has_no_viewing_scope_for_the_event",
    async (role) => {
      signedInAs(role, 99);
      eventModel.findEventForViewer.mockResolvedValue(null);

      const res = await send("get", "/api/events/42");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Event request not found.", code: "EVENT_NOT_FOUND" });
    }
  );

  test("[SPM-33-TC-06] should_return_404_when_a_row_is_returned_for_a_coordinator_who_is_not_assigned", async () => {
    signedInAs("COORDINATOR", 99);
    eventModel.findEventForViewer.mockResolvedValue(eventRow());

    const res = await send("get", "/api/events/42");

    expect(res.status).toBe(404);
  });
});

describe("PUT /api/events/:id as an organiser (AC2, AC3)", () => {
  test("[SPM-33-TC-07] should_save_the_draft_with_the_loaded_version_when_the_owner_saves_manually", async () => {
    asOwner();
    eventModel.findEventForViewer.mockResolvedValue(draftRow());
    eventModel.saveDraft.mockResolvedValue({ event: draftRow({ expected_attendance: 200, version: 4 }), replayed: false });

    const res = await send("put", "/api/events/42", { expectedAttendance: 200, version: 3 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Draft saved successfully.");
    expect(res.body.event).toEqual(expect.objectContaining({ status: "DRAFT", expectedAttendance: 200, version: 4 }));
    expect(eventModel.saveDraft).toHaveBeenCalledWith({
      organiserId: ORGANISER_ID,
      eventId: 42,
      input: { expectedAttendance: 200 },
      isAutoSave: false,
      idempotencyKey: KEY,
      expectedVersion: 3,
    });
  });

  test("[SPM-33-TC-09] should_return_403_pointing_to_a_change_request_when_the_owner_edits_a_submitted_event", async () => {
    asOwner();
    eventModel.findEventForViewer.mockResolvedValue(eventRow({ status: "SUBMITTED" }));

    const res = await send("put", "/api/events/42", { title: "New title", version: 3 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EDIT_REQUIRES_CHANGE_REQUEST");
    expect(res.body.error).toMatch(/Request a change/);
    expectNothingSaved();
  });

  test("[SPM-33-AC3] should_return_403_when_a_same_organisation_organiser_edits_a_submitted_event", async () => {
    asColleague();
    eventModel.findEventForViewer.mockResolvedValue(eventRow({ status: "SUBMITTED" }));

    const res = await send("put", "/api/events/42", { title: "Taken over", version: 3 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EVENT_READ_ONLY");
    expectNothingSaved();
  });

  test.each(["COMPLETED", "REJECTED", "CANCELLED"])(
    "[SPM-33-AC6] should_return_403_without_offering_a_change_request_when_the_owner_edits_a_%s_event",
    async (status) => {
      asOwner();
      eventModel.findEventForViewer.mockResolvedValue(eventRow({ status }));

      const res = await send("put", "/api/events/42", { title: "New title", version: 3 });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("EVENT_NOT_EDITABLE_IN_STATUS");
    }
  );

  test("[SPM-33-AC6] should_return_403_when_the_owner_sends_a_system_field_with_a_draft_save", async () => {
    asOwner();
    eventModel.findEventForViewer.mockResolvedValue(draftRow());

    const res = await send("put", "/api/events/42", { title: "Gala", status: "CONFIRMED", version: 3 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FIELD_NOT_EDITABLE");
    expect(res.body.fields).toEqual({ status: "This field is set by the system." });
    expectNothingSaved();
  });

  test("[SPM-33-AC3] should_return_403_when_the_draft_is_submitted_between_the_read_and_the_write", async () => {
    asOwner();
    eventModel.findEventForViewer.mockResolvedValue(draftRow());
    eventModel.saveDraft.mockRejectedValue(domainError("EVENT_NOT_DRAFT"));

    const res = await send("put", "/api/events/42", { title: "Gala", version: 3 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EDIT_REQUIRES_CHANGE_REQUEST");
  });

  test("[SPM-33-AC3] should_return_403_on_the_draft_route_when_a_colleague_edits_a_submitted_event", async () => {
    asColleague();
    eventModel.findEventForViewer.mockResolvedValue(eventRow({ status: "SUBMITTED" }));

    const res = await send("put", "/api/events/42/draft", { title: "Taken over" }, {});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EVENT_READ_ONLY");
    expectNothingSaved();
  });

  test("[SPM-33-AC7] should_pass_an_optional_version_and_key_on_the_draft_route", async () => {
    asOwner();
    eventModel.findEventForViewer.mockResolvedValue(draftRow());
    eventModel.saveDraft.mockResolvedValue({ event: draftRow({ version: 4 }), replayed: true });

    const res = await send("put", "/api/events/42/draft", { purpose: "Reunion", version: "3" });

    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(eventModel.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 3, idempotencyKey: KEY, isAutoSave: false })
    );
  });

  test("[SPM-33-AC7] should_return_400_when_the_draft_route_gets_a_malformed_idempotency_key", async () => {
    asOwner();
    eventModel.findEventForViewer.mockResolvedValue(draftRow());

    const res = await send("put", "/api/events/42/draft", { purpose: "Reunion" }, { "Idempotency-Key": "short" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("idempotencyKey");
    expectNothingSaved();
  });
});

describe("PUT /api/events/:id as the assigned coordinator (AC4, AC6, AC7)", () => {
  test("[SPM-33-TC-10] should_save_ordinary_fields_when_the_event_is_under_review", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());
    eventModel.updateEventDetails.mockResolvedValue({
      event: eventRow({ description: "Updated description.", version: 4 }),
      replayed: false,
    });

    const res = await send("put", "/api/events/42", { description: "Updated description.", version: 3 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Event details updated.");
    expect(res.body.event).toEqual(
      expect.objectContaining({ description: "Updated description.", version: 4, viewerRelationship: "ASSIGNED_COORDINATOR" })
    );
    expect(res.body).not.toHaveProperty("savedAt");
    expect(eventModel.updateEventDetails).toHaveBeenCalledWith({
      actorId: COORDINATOR_ID,
      eventId: 42,
      input: { description: "Updated description." },
      expectedVersion: 3,
      idempotencyKey: KEY,
    });
    expect(eventModel.saveDraft).not.toHaveBeenCalled();
  });

  // PROVISIONAL Q6: SAFETY_REVIEW and PREPARATION are editable statuses.
  test.each(["SUBMITTED", "UNDER_REVIEW", "PLANNING", "SAFETY_REVIEW", "PREPARATION", "CONFIRMED"])(
    "[Q6][SPM-33-AC4] should_allow_the_edit_when_the_event_is_%s",
    async (status) => {
      eventModel.findEventForViewer.mockResolvedValue(eventRow({ status }));
      eventModel.updateEventDetails.mockResolvedValue({ event: eventRow({ status, version: 4 }), replayed: false });

      const res = await send("put", "/api/events/42", { title: "Renamed", version: 3 });

      expect(res.status).toBe(200);
    }
  );

  test.each(["AWAITING_CLARIFICATION", "COMPLETED", "REJECTED", "CANCELLED", "APPROVED"])(
    "[SPM-33-TC-12] should_return_403_without_saving_when_the_event_is_%s",
    async (status) => {
      eventModel.findEventForViewer.mockResolvedValue(eventRow({ status }));

      const res = await send("put", "/api/events/42", { description: "Updated description.", version: 3 });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("EVENT_NOT_EDITABLE_IN_STATUS");
      expectNothingSaved();
    }
  );

  test("[SPM-33-TC-11] should_reject_the_whole_request_when_a_significant_field_is_sent_with_an_ordinary_one", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());

    const res = await send("put", "/api/events/42", {
      title: "Renamed",
      startDatetime: "2027-01-01T09:00:00+08:00",
      version: 3,
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FIELD_NOT_EDITABLE");
    expect(res.body.fields).toEqual({ startDatetime: "This field can only be changed through a change request." });
    expectNothingSaved();
  });

  test.each([
    ["registrationCapacity", 10, "This field can only be changed through a change request."],
    ["registrationCloseAt", "2027-01-01T09:00:00+08:00", "This field can only be changed through a change request."],
    ["status", "CONFIRMED", "This field is set by the system."],
    ["coordinatorId", 99, "This field is set by the system."],
    ["isPublished", true, "This field is set by the system."],
  ])("[SPM-33-AC4] should_return_403_when_the_coordinator_sends_%s", async (field, value, message) => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());

    const res = await send("put", "/api/events/42", { title: "Renamed", [field]: value, version: 3 });

    expect(res.status).toBe(403);
    expect(res.body.fields).toEqual({ [field]: message });
    expectNothingSaved();
  });

  test("[SPM-33-TC-16] should_return_the_title_error_without_saving_when_the_title_is_blank", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());

    const res = await send("put", "/api/events/42", { title: "  ", version: 3 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Please correct the highlighted fields.",
      code: "VALIDATION_FAILED",
      fields: { title: MESSAGES.titleRequired },
    });
    expectNothingSaved();
  });

  test("[SPM-33-AC6] should_answer_403_before_400_when_the_status_blocks_an_invalid_edit", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow({ status: "AWAITING_CLARIFICATION" }));

    const res = await send("put", "/api/events/42", { title: "" }, {});

    expect(res.status).toBe(403);
  });

  test.each([
    ["no version", { title: "Renamed" }, { "Idempotency-Key": KEY }, "version"],
    ["a zero version", { title: "Renamed", version: 0 }, { "Idempotency-Key": KEY }, "version"],
    ["a text version", { title: "Renamed", version: "latest" }, { "Idempotency-Key": KEY }, "version"],
    ["no idempotency key", { title: "Renamed", version: 3 }, {}, "idempotencyKey"],
    ["an unknown field", { title: "Renamed", nickname: "x", version: 3 }, { "Idempotency-Key": KEY }, "nickname"],
    ["the auto-save flag", { title: "Renamed", isAutoSave: true, version: 3 }, { "Idempotency-Key": KEY }, "isAutoSave"],
    ["no field to change", { version: 3 }, { "Idempotency-Key": KEY }, "body"],
  ])("[SPM-33-AC6] should_return_400_without_saving_when_the_request_has_%s", async (_label, body, headers, field) => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());

    const res = await send("put", "/api/events/42", body, headers);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.fields).toHaveProperty(field);
    expectNothingSaved();
  });

  test("[SPM-33-AC6] should_return_400_when_the_body_is_not_an_object", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());

    const res = await send("put", "/api/events/42", ["title"]);

    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("body");
  });

  test("[SPM-33-TC-17] should_return_409_with_the_current_values_when_the_event_changed_since_it_was_loaded", async () => {
    eventModel.findEventForViewer
      .mockResolvedValueOnce(eventRow())
      .mockResolvedValueOnce(eventRow({ description: "Saved from the other tab.", version: 4 }));
    eventModel.updateEventDetails.mockRejectedValue(domainError("EVENT_VERSION_CONFLICT"));

    const res = await send("put", "/api/events/42", { title: "Renamed", version: 3 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_VERSION_CONFLICT");
    expect(res.body.event).toEqual(
      expect.objectContaining({ title: "SMU Alumni Gala 2026", description: "Saved from the other tab.", version: 4 })
    );
  });

  test("[SPM-33-TC-13] should_return_404_when_the_coordinator_is_reassigned_between_the_read_and_the_write", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());
    eventModel.updateEventDetails.mockRejectedValue(domainError("EVENT_NOT_FOUND"));

    const res = await send("put", "/api/events/42", { title: "Renamed", version: 3 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
  });

  test("[SPM-33-TC-13] should_return_404_without_event_details_when_a_version_conflict_follows_a_reassignment", async () => {
    eventModel.findEventForViewer.mockResolvedValueOnce(eventRow()).mockResolvedValueOnce(null);
    eventModel.updateEventDetails.mockRejectedValue(domainError("EVENT_VERSION_CONFLICT"));

    const res = await send("put", "/api/events/42", { title: "Renamed", version: 3 });

    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("event");
  });

  test("[SPM-33-TC-18] should_mark_the_response_when_the_same_request_is_retried_with_the_same_key", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow({ version: 4 }));
    eventModel.updateEventDetails.mockResolvedValue({ event: eventRow({ version: 4 }), replayed: true });

    const res = await send("put", "/api/events/42", { description: "Updated description.", version: 3 });

    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });

  // A replay is only reached while the event is still editable, so the permissions in
  // a replayed response can never be staler than the status check that precedes it.
  test("[SPM-33-TC-18] should_answer_403_rather_than_replay_when_a_retry_arrives_after_the_event_stopped_being_editable", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow({ status: "COMPLETED", version: 6 }));

    const res = await send("put", "/api/events/42", { description: "Updated description.", version: 3 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EVENT_NOT_EDITABLE_IN_STATUS");
    expect(eventModel.updateEventDetails).not.toHaveBeenCalled();
  });

  test.each([
    ["EVENT_NOT_EDITABLE_IN_STATUS", 403],
    ["FIELD_NOT_EDITABLE", 403],
    ["IDEMPOTENCY_KEY_REUSED", 409],
  ])("[SPM-33-AC6] should_return_%s_when_the_database_refuses_the_edit", async (code, status) => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());
    eventModel.updateEventDetails.mockRejectedValue(domainError(code));

    const res = await send("put", "/api/events/42", { title: "Renamed", version: 3 });

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: expect.any(String), code });
  });

  test("[SPM-33-TC-21] should_return_field_errors_when_the_database_rejects_the_values", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());
    eventModel.updateEventDetails.mockRejectedValue(domainError("VALIDATION_FAILED", { title: MESSAGES.titleTooLong }));

    const res = await send("put", "/api/events/42", { title: "Renamed", version: 3 });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ title: MESSAGES.titleTooLong });
  });
});

describe("PUT /api/events/:id as other roles (AC5)", () => {
  test.each(["VENUE_STAFF", "TECH_SUPPORT", "ATTENDEE", "COORDINATOR_LEAD"])(
    "[SPM-33-TC-14] should_return_404_without_saving_when_%s_sends_a_direct_update",
    async (role) => {
      signedInAs(role, 99);
      eventModel.findEventForViewer.mockResolvedValue(null);

      const res = await send("put", "/api/events/42", {
        title: "Renamed",
        startDatetime: "2027-01-01T09:00:00+08:00",
        expectedAttendance: 500,
        version: 3,
      });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Event request not found.", code: "EVENT_NOT_FOUND" });
      expectNothingSaved();
    }
  );

  test.each(["VENUE_STAFF", "TECH_SUPPORT", "COORDINATOR"])(
    "[SPM-33-TC-14] should_return_403_without_saving_when_%s_uses_the_draft_route",
    async (role) => {
      signedInAs(role, 99);

      const res = await send("put", "/api/events/42/draft", { title: "Renamed" });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(eventModel.findEventForViewer).not.toHaveBeenCalled();
      expectNothingSaved();
    }
  );

  test("[SPM-33-TC-15] should_return_401_without_reading_the_event_when_there_is_no_session", async () => {
    const res = await request(app).put("/api/events/42").send({ title: "Renamed", version: 3 });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
    expect(eventModel.findEventForViewer).not.toHaveBeenCalled();
  });
});

describe("GET /api/events/:id/history (AC8)", () => {
  const page = { history: [{ historyId: 9, action: "EVENT_DETAILS_UPDATED" }], nextCursor: null };

  test("[SPM-33-TC-19] should_ask_for_draft_and_organiser_safe_entries_but_no_staff_entries_when_the_owner_opens_history", async () => {
    asOwner();
    eventModel.findEventForViewer.mockResolvedValue(eventRow());
    activityModel.findEventHistory.mockResolvedValue(page);

    const res = await send("get", "/api/events/42/history?limit=20");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(page);
    expect(activityModel.findEventHistory).toHaveBeenCalledWith(42, {
      limit: 20,
      cursor: null,
      audiences: ["OWNER_ONLY", "ORGANISER_SAFE"],
    });
  });

  test("[SPM-33-TC-03] should_ask_for_organiser_safe_entries_only_when_a_colleague_opens_history", async () => {
    asColleague();
    eventModel.findEventForViewer.mockResolvedValue(eventRow({ status: "SUBMITTED" }));
    activityModel.findEventHistory.mockResolvedValue(page);

    await send("get", "/api/events/42/history");

    expect(activityModel.findEventHistory).toHaveBeenCalledWith(42, expect.objectContaining({ audiences: ["ORGANISER_SAFE"] }));
  });

  test("[SPM-33-TC-05] should_ask_for_history_since_submission_including_staff_entries_when_the_assigned_coordinator_opens_it", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());
    activityModel.findEventHistory.mockResolvedValue(page);

    await send("get", "/api/events/42/history");

    expect(activityModel.findEventHistory).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ audiences: ["ORGANISER_SAFE", "STAFF_ONLY"] })
    );
  });

  test("[SPM-33-TC-06] should_return_404_without_reading_history_when_the_event_is_not_visible", async () => {
    eventModel.findEventForViewer.mockResolvedValue(null);

    const res = await send("get", "/api/events/42/history");

    expect(res.status).toBe(404);
    expect(activityModel.findEventHistory).not.toHaveBeenCalled();
  });

  test("[SPM-33-AC8] should_return_400_when_the_history_cursor_cannot_be_decoded", async () => {
    eventModel.findEventForViewer.mockResolvedValue(eventRow());
    activityModel.findEventHistory.mockRejectedValue(domainError("INVALID_CURSOR"));

    const res = await send("get", "/api/events/42/history?cursor=abc");

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ cursor: "Invalid page cursor." });
  });

  test.each([
    ["put", "/api/events/42/history/9"],
    ["patch", "/api/events/42/history/9"],
    ["delete", "/api/events/42/history/9"],
    ["post", "/api/events/42/history"],
    ["delete", "/api/events/42/history"],
  ])("[SPM-33-TC-20] should_offer_no_route_to_%s_%s", async (method, path) => {
    const res = await send(method, path, method === "delete" ? undefined : { action: "EDITED" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(activityModel.findEventHistory).not.toHaveBeenCalled();
  });
});
