// Pure-rule unit tests for the SPM-33 access policy, the model's edit and history
// mapping, and the ordinary-field validator. Supabase is mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require("../../config/supabase");
const eventModel = require("../../model/eventModel");
const activityModel = require("../../model/activityModel");
const { getEventRelationship, getEventAccess } = require("../../middleware/authorize");
const { validateOrdinaryFields, MESSAGES } = require("../../validators/eventValidator");
const { OWNER_DRAFT_FIELDS, COORDINATOR_EDITABLE_STATUSES } = require("../../config/eventConstants");

const ALL_STATUSES = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "AWAITING_CLARIFICATION", "APPROVED", "PLANNING",
  "SAFETY_REVIEW", "PREPARATION", "CONFIRMED", "COMPLETED", "REJECTED", "CANCELLED",
];

const event = (overrides = {}) => ({
  event_id: 42,
  organiser_id: 11,
  organisation_id: 5,
  coordinator_id: 21,
  status: "UNDER_REVIEW",
  ...overrides,
});

const organiser = (userId, organisationIds = []) => ({ user_id: userId, role: "ORGANISER", organisation_ids: organisationIds });
const staff = (role, userId) => ({ user_id: userId, role, organisation_ids: [] });

const queryReturning = (result) => {
  const query = {};
  for (const method of ["select", "eq", "neq", "or", "in", "lt", "order"]) {
    query[method] = jest.fn(() => query);
  }
  query.limit = jest.fn().mockResolvedValue(result);
  query.maybeSingle = jest.fn().mockResolvedValue(result);
  return query;
};

beforeEach(() => jest.clearAllMocks());

describe("getEventRelationship (AC1)", () => {
  test.each(ALL_STATUSES)("[SPM-33-TC-01] should_make_the_organiser_the_owner_when_their_event_is_%s", (status) => {
    expect(getEventRelationship(organiser(11), event({ status }))).toBe("OWNER");
  });

  test("[SPM-33-TC-02] should_hide_a_draft_from_an_organiser_in_the_same_organisation", () => {
    expect(getEventRelationship(organiser(12, [5]), event({ status: "DRAFT" }))).toBeNull();
  });

  test("[SPM-33-TC-03] should_make_a_same_organisation_organiser_a_member_once_the_event_is_submitted", () => {
    expect(getEventRelationship(organiser(12, [5]), event({ status: "SUBMITTED" }))).toBe("ORGANISATION_MEMBER");
  });

  test.each([
    ["another organisation", organiser(12, [6]), event()],
    ["no organisation on the event", organiser(12, [5]), event({ organisation_id: null })],
    ["no memberships", organiser(12), event()],
  ])("[SPM-33-TC-04] should_hide_the_event_from_an_organiser_with_%s", (_label, user, row) => {
    expect(getEventRelationship(user, row)).toBeNull();
  });

  test("[SPM-33-TC-05] should_recognise_the_assigned_coordinator", () => {
    expect(getEventRelationship(staff("COORDINATOR", 21), event())).toBe("ASSIGNED_COORDINATOR");
  });

  test.each([
    ["a coordinator who is not assigned", staff("COORDINATOR", 22), event()],
    ["a coordinator when nobody is assigned", staff("COORDINATOR", 22), event({ coordinator_id: null })],
    ["venue staff", staff("VENUE_STAFF", 21), event()],
    ["technical support", staff("TECH_SUPPORT", 21), event()],
    ["a coordinator lead", staff("COORDINATOR_LEAD", 21), event()],
    ["an attendee", staff("ATTENDEE", 21), event({ status: "CONFIRMED" })],
  ])("[SPM-33-TC-06] should_give_no_viewing_scope_to_%s", (_label, user, row) => {
    expect(getEventRelationship(user, row)).toBeNull();
  });

  test("[SPM-33-AC1] should_judge_each_role_only_by_its_own_relationship", () => {
    // A coordinator who happens to own the row's organiser ID gains nothing from it.
    expect(getEventRelationship(staff("COORDINATOR", 11), event())).toBeNull();
    // An organiser whose ID matches the coordinator column is not the coordinator.
    expect(getEventRelationship(organiser(21), event())).toBeNull();
  });
});

describe("getEventAccess (field edit matrix)", () => {
  test("[SPM-33-TC-07] should_let_the_owner_edit_every_draft_field_only_while_the_event_is_a_draft", () => {
    for (const status of ALL_STATUSES) {
      const access = getEventAccess(organiser(11), event({ status }));
      expect(access.canEdit).toBe(status === "DRAFT");
      expect(access.editableFields).toEqual(status === "DRAFT" ? [...OWNER_DRAFT_FIELDS] : []);
      expect(access.historyAudiences).toEqual(["OWNER_ONLY", "ORGANISER_SAFE"]);
    }
  });

  test("[SPM-33-AC3] should_never_let_a_same_organisation_organiser_edit", () => {
    for (const status of ALL_STATUSES.filter((value) => value !== "DRAFT")) {
      expect(getEventAccess(organiser(12, [5]), event({ status }))).toEqual(
        expect.objectContaining({
          relationship: "ORGANISATION_MEMBER",
          canEdit: false,
          editableFields: [],
          historyAudiences: ["ORGANISER_SAFE"],
        })
      );
    }
  });

  // PROVISIONAL Q6: SAFETY_REVIEW and PREPARATION are part of the editable list.
  test("[Q6][SPM-33-TC-10] should_let_the_assigned_coordinator_edit_ordinary_fields_only_in_the_matrix_statuses", () => {
    expect([...COORDINATOR_EDITABLE_STATUSES]).toEqual([
      "SUBMITTED", "UNDER_REVIEW", "PLANNING", "SAFETY_REVIEW", "PREPARATION", "CONFIRMED",
    ]);
    for (const status of ALL_STATUSES.filter((value) => value !== "DRAFT")) {
      const access = getEventAccess(staff("COORDINATOR", 21), event({ status }));
      const editable = COORDINATOR_EDITABLE_STATUSES.includes(status);
      expect(access.canEdit).toBe(editable);
      expect(access.editableFields).toEqual(editable ? ["title", "purpose", "description"] : []);
      // History from before submission is the owner's alone.
      expect(access.historyAudiences).toEqual(["ORGANISER_SAFE", "STAFF_ONLY"]);
    }
  });

  test("[SPM-33-AC8] should_give_no_history_audience_to_a_user_outside_the_viewing_scope", () => {
    expect(getEventAccess(staff("VENUE_STAFF", 21), event())).toEqual(
      expect.objectContaining({ relationship: null, canEdit: false, historyAudiences: [] })
    );
  });

  test("[SPM-33-AC2] should_keep_the_owner_draft_fields_equal_to_the_draft_api_allowlist", () => {
    const body = Object.fromEntries(OWNER_DRAFT_FIELDS.map((field) => [field, 1]));
    expect(eventModel.getUnsupportedInputFields(body)).toEqual([]);
    expect(Object.keys(eventModel.pickEventInput(body)).sort()).toEqual([...OWNER_DRAFT_FIELDS].sort());
  });
});

describe("validateOrdinaryFields (AC4)", () => {
  test("[SPM-33-TC-10] should_accept_any_subset_of_ordinary_fields", () => {
    expect(validateOrdinaryFields({ description: "Updated." })).toEqual({});
    expect(validateOrdinaryFields({})).toEqual({});
  });

  test.each([[""], ["   "], [null]])("[SPM-33-TC-16] should_require_a_title_when_it_is_sent_as_%p", (title) => {
    expect(validateOrdinaryFields({ title })).toEqual({ title: MESSAGES.titleRequired });
  });

  test("[SPM-33-TC-16] should_report_each_invalid_field", () => {
    expect(validateOrdinaryFields({ title: "x".repeat(201), purpose: 5, description: " " })).toEqual({
      title: MESSAGES.titleTooLong,
      purpose: MESSAGES.textInvalid,
      description: MESSAGES.descriptionRequired,
    });
  });
});

describe("eventModel edits", () => {
  const rpcReturns = (event) => supabase.rpc.mockResolvedValue({ data: { event, replayed: false }, error: null });

  test("[SPM-33-TC-10] should_send_only_trimmed_ordinary_fields_with_the_version_and_statuses", async () => {
    rpcReturns({ event_id: 42, version: 4 });

    await eventModel.updateEventDetails({
      actorId: 21,
      eventId: 42,
      input: { title: " Renamed ", description: "Updated.", startDatetime: "2027-01-01T09:00:00+08:00" },
      expectedVersion: 3,
      idempotencyKey: "key-12345678",
    });

    expect(supabase.rpc.mock.calls[0][0]).toBe("update_event_details");
    const args = supabase.rpc.mock.calls[0][1];
    expect(args).toEqual({
      p_actor_id: 21,
      p_event_id: 42,
      p_changes: { title: "Renamed", description: "Updated." },
      p_expected_version: 3,
      p_editable_statuses: [...COORDINATOR_EDITABLE_STATUSES],
      p_idempotency_key: "key-12345678",
      p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("[SPM-33-TC-18] should_hash_the_event_and_version_so_a_key_cannot_replay_another_edit", () => {
    const changes = { title: "Renamed" };
    const hash = (scope) => eventModel.hashRequest(changes, {}, scope);

    expect(hash([42, 3])).toBe(hash([42, 3]));
    expect(hash([42, 4])).not.toBe(hash([42, 3]));
    expect(hash([43, 3])).not.toBe(hash([42, 3]));
  });

  test("[SPM-33-TC-21] should_map_database_value_failures_to_field_errors", async () => {
    supabase.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "INVALID_EVENT_DETAILS", details: "title:REQUIRED,description:TOO_LONG" },
    });

    await expect(
      eventModel.updateEventDetails({ actorId: 21, eventId: 42, input: { title: "" }, expectedVersion: 3, idempotencyKey: "key-12345678" })
    ).rejects.toMatchObject({
      name: "EventRequestError",
      code: "VALIDATION_FAILED",
      fields: { title: MESSAGES.titleRequired, description: MESSAGES.descriptionTooLong },
    });
  });

  test.each(["EVENT_VERSION_CONFLICT", "EVENT_NOT_EDITABLE_IN_STATUS", "FIELD_NOT_EDITABLE", "EVENT_NOT_FOUND"])(
    "[SPM-33-AC6] should_keep_domain_code_%s",
    async (message) => {
      supabase.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message } });

      await expect(
        eventModel.updateEventDetails({ actorId: 21, eventId: 42, input: { title: "x" }, expectedVersion: 3, idempotencyKey: "key-12345678" })
      ).rejects.toMatchObject({ name: "EventRequestError", code: message });
    }
  );

  test("[SPM-33-AC7] should_send_the_expected_version_and_a_scoped_hash_when_a_draft_save_has_them", async () => {
    rpcReturns({ event_id: 42, version: 4 });

    await eventModel.saveDraft({ organiserId: 11, eventId: 42, input: { title: "Gala" }, idempotencyKey: "key-12345678", expectedVersion: 3 });

    expect(supabase.rpc.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        p_event_id: 42,
        p_expected_version: 3,
        p_idempotency_key: "key-12345678",
        p_request_hash: eventModel.hashRequest({ title: "Gala" }, {}, [42, 3]),
      })
    );
  });

  test("[SPM-33-AC7] should_leave_the_expected_version_out_when_a_draft_save_has_none", async () => {
    rpcReturns({ event_id: 42 });

    await eventModel.saveDraft({ organiserId: 11, eventId: 42, input: { title: "Gala" }, isAutoSave: true });

    expect(supabase.rpc.mock.calls[0][1]).not.toHaveProperty("p_expected_version");
  });
});

describe("eventModel.findEventForViewer (AC1)", () => {
  test.each(["VENUE_STAFF", "TECH_SUPPORT", "ATTENDEE", "COORDINATOR_LEAD"])(
    "[SPM-33-TC-14] should_return_null_without_querying_when_the_user_is_%s",
    async (role) => {
      await expect(eventModel.findEventForViewer(42, staff(role, 21))).resolves.toBeNull();

      expect(supabase.from).not.toHaveBeenCalled();
    }
  );

  test("[SPM-33-TC-06] should_filter_by_the_assigned_coordinator_and_exclude_drafts", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await expect(eventModel.findEventForViewer(42, staff("COORDINATOR", 21))).resolves.toBeNull();

    expect(supabase.from).toHaveBeenCalledWith("event");
    expect(query.eq).toHaveBeenCalledWith("event_id", 42);
    expect(query.eq).toHaveBeenCalledWith("coordinator_id", 21);
    expect(query.neq).toHaveBeenCalledWith("status", "DRAFT");
  });

  test("[SPM-33-TC-02] should_apply_the_organiser_visibility_filter", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await eventModel.findEventForViewer(42, organiser(12, [5]));

    expect(query.or).toHaveBeenCalledWith("organiser_id.eq.12,and(organisation_id.in.(5),status.neq.DRAFT)");
  });
});

describe("activityModel (AC8)", () => {
  const historyRow = (overrides = {}) => ({
    log_id: 9,
    user_id: 21,
    action: "EVENT_DETAILS_UPDATED",
    details: "Event details updated.",
    timestamp: "2026-10-12T08:00:00+00:00",
    actor_role: "COORDINATOR",
    audience: "ORGANISER_SAFE",
    changes: { description: { before: "Old", after: "New" } },
    actor: { name: "Coordinator C" },
    ...overrides,
  });

  test("[SPM-33-TC-19] should_filter_to_the_readers_audiences_in_the_query", async () => {
    const query = queryReturning({ data: [historyRow()], error: null });
    supabase.from.mockReturnValue(query);

    const { history, nextCursor } = await activityModel.findEventHistory(42, { limit: 20, audiences: ["ORGANISER_SAFE"] });

    expect(supabase.from).toHaveBeenCalledWith("activity_log");
    expect(query.eq).toHaveBeenCalledWith("entity_name", "event");
    expect(query.eq).toHaveBeenCalledWith("entity_id", 42);
    expect(query.in).toHaveBeenCalledWith("audience", ["ORGANISER_SAFE"]);
    expect(history).toEqual([
      {
        historyId: 9,
        action: "EVENT_DETAILS_UPDATED",
        actor: { userId: 21, name: "Coordinator C", role: "COORDINATOR" },
        occurredAt: "2026-10-12T08:00:00+00:00",
        summary: "Event details updated.",
        changes: [{ field: "description", before: "Old", after: "New" }],
        audience: "ORGANISER_SAFE",
      },
    ]);
    expect(nextCursor).toBeNull();
  });

  test("[SPM-33-TC-05] should_ask_for_exactly_the_audiences_it_is_given", async () => {
    const query = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(query);

    await activityModel.findEventHistory(42, { limit: 20, audiences: ["ORGANISER_SAFE", "STAFF_ONLY"] });

    expect(query.in).toHaveBeenCalledWith("audience", ["ORGANISER_SAFE", "STAFF_ONLY"]);
  });

  test("[SPM-33-AC8] should_return_nothing_without_querying_when_the_reader_has_no_audience", async () => {
    await expect(activityModel.findEventHistory(42, { limit: 20 })).resolves.toEqual({ history: [], nextCursor: null });
    await expect(activityModel.findEventHistory(42, { limit: 20, audiences: [] })).resolves.toEqual({ history: [], nextCursor: null });

    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("[SPM-33-AC8] should_page_newest_first_with_a_cursor_on_the_entry_id", async () => {
    const firstPage = queryReturning({ data: [historyRow({ log_id: 9 }), historyRow({ log_id: 8 }), historyRow({ log_id: 7 })], error: null });
    supabase.from.mockReturnValue(firstPage);

    const { history, nextCursor } = await activityModel.findEventHistory(42, { limit: 2, audiences: ["ORGANISER_SAFE", "STAFF_ONLY"] });

    expect(history.map(({ historyId }) => historyId)).toEqual([9, 8]);
    expect(firstPage.order).toHaveBeenCalledWith("log_id", { ascending: false });
    expect(firstPage.limit).toHaveBeenCalledWith(3);
    expect(activityModel.decodeHistoryCursor(nextCursor)).toBe(8);

    const secondPage = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(secondPage);
    await activityModel.findEventHistory(42, { limit: 2, cursor: nextCursor, audiences: ["ORGANISER_SAFE", "STAFF_ONLY"] });

    expect(secondPage.lt).toHaveBeenCalledWith("log_id", 8);
  });

  test.each([
    ["not base64 json", "not-a-cursor"],
    ["a text id", Buffer.from(JSON.stringify({ logId: "8" })).toString("base64url")],
    ["a filter injection", Buffer.from(JSON.stringify({ logId: "1,audience.eq.STAFF_ONLY" })).toString("base64url")],
  ])("[SPM-33-AC8] should_reject_the_cursor_when_it_is_%s", (_label, cursor) => {
    expect(() => activityModel.decodeHistoryCursor(cursor)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });

  test("[SPM-33-TC-07] should_show_changed_values_in_api_shapes_and_a_stable_order", () => {
    const changes = activityModel.toChangeList({
      equipmentRequirements: { before: [], after: [{ equipment_id: 3, quantity: 2 }] },
      accessibilityNeeds: { before: null, after: '["Wheelchair access"]' },
      expectedAttendance: { before: 50, after: 200 },
    });

    expect(changes).toEqual([
      { field: "expectedAttendance", before: 50, after: 200 },
      { field: "accessibilityNeeds", before: null, after: ["Wheelchair access"] },
      { field: "equipmentRequirements", before: [], after: [{ equipmentId: 3, quantity: 2 }] },
    ]);
  });

  test("[SPM-33-AC8] should_return_no_changes_for_entries_recorded_without_them", () => {
    expect(activityModel.toHistoryEntry(historyRow({ changes: null, actor: null, actor_role: null }))).toEqual(
      expect.objectContaining({ changes: [], actor: { userId: 21, name: null, role: null } })
    );
  });
});
