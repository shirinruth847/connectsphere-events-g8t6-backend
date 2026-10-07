jest.mock("../../config/supabase", () => ({
  from: jest.fn(),
  rpc: jest.fn(),
}));

const supabase = require("../../config/supabase");
const eventModel = require("../../model/eventModel");
const { MESSAGES } = require("../../validators/eventValidator");

// Timestamps exactly as PostgREST returns timestamptz values.
const POSTGREST_TIMESTAMP = "2026-10-07T07:14:14.406209+00:00";

const queryReturning = (result) => {
  const query = {};
  for (const method of ["select", "eq", "or", "order", "in"]) {
    query[method] = jest.fn(() => query);
  }
  query.limit = jest.fn().mockResolvedValue(result);
  query.maybeSingle = jest.fn().mockResolvedValue(result);
  return query;
};

beforeEach(() => jest.clearAllMocks());

describe("submitEvent / saveDraft", () => {
  test("[SPM-35-AC3] should_send_normalized_fields_and_numeric_requirements_to_the_atomic_rpc", async () => {
    supabase.rpc.mockResolvedValue({
      data: {
        event: { event_id: 7, status: "SUBMITTED" },
        venue_preferences: [2, 1],
        equipment_requirements: [{ equipment_id: 3, quantity: 4 }],
        replayed: false,
      },
      error: null,
    });

    const result = await eventModel.submitEvent({
      organiserId: 9,
      idempotencyKey: "key-12345678",
      input: {
        title: " Conference ",
        expectedAttendance: "150",
        venuePreferences: ["2", "1"],
        equipmentRequirements: [{ equipmentId: "3", quantity: "4" }],
      },
    });

    const args = supabase.rpc.mock.calls[0][1];
    expect(supabase.rpc.mock.calls[0][0]).toBe("submit_event_request");
    expect(args).toEqual(
      expect.objectContaining({
        p_organiser_id: 9,
        p_event_id: null,
        p_event: { title: "Conference", expected_attendance: 150 },
        p_venue_preferences: [2, 1],
        p_equipment_requirements: [{ equipment_id: 3, quantity: 4 }],
        p_idempotency_key: "key-12345678",
      })
    );
    expect(args.p_request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toEqual({
      event: expect.objectContaining({ event_id: 7, venue_preferences: [2, 1] }),
      replayed: false,
    });
  });

  test("[EVT-IDEM-001] should_hash_identical_requests_identically_when_json_key_order_differs", () => {
    const first = eventModel.pickEventInput({ title: "Gala", expectedAttendance: 5 });
    const second = eventModel.pickEventInput({ expectedAttendance: "5", title: "Gala " });
    const hash = (input) => eventModel.hashRequest(eventModel.toRow(input), eventModel.toRequirementPayload(input));

    expect(hash(first)).toBe(hash(second));
    expect(hash({ title: "Other" })).not.toBe(hash(first));
  });

  test("[EVT-IDEM-002] should_report_a_replay_when_the_rpc_returns_a_stored_response", async () => {
    supabase.rpc.mockResolvedValue({ data: { event: { event_id: 7 }, replayed: true }, error: null });

    const result = await eventModel.saveDraft({ organiserId: 9, input: { title: "Gala" }, idempotencyKey: "key-12345678" });

    expect(result.replayed).toBe(true);
  });

  test("[EVT-AUTO-001] should_skip_the_request_hash_when_updating_an_existing_draft", async () => {
    supabase.rpc.mockResolvedValue({ data: { event: { event_id: 7 } }, error: null });

    await eventModel.saveDraft({ organiserId: 9, eventId: 7, input: { title: "Gala" }, isAutoSave: true });

    expect(supabase.rpc.mock.calls[0][1]).toEqual(
      expect.objectContaining({ p_event_id: 7, p_is_auto_save: true, p_idempotency_key: null, p_request_hash: null })
    );
  });
});

describe("toEventRequestError (database failures become client errors)", () => {
  const rpcFails = (error) => supabase.rpc.mockResolvedValue({ data: null, error });
  const saveFails = () => eventModel.saveDraft({ organiserId: 9, eventId: 7, input: { title: "Gala" } });

  test("[SPM-35-AC2] should_return_field_errors_when_the_database_rejects_a_submission", async () => {
    rpcFails({ code: "P0001", message: "INVALID_EVENT_SUBMISSION", details: "startDatetime:LEAD_TIME,expectedAttendance:REQUIRED" });

    await expect(eventModel.submitEvent({ organiserId: 9, eventId: 7, input: {} })).rejects.toMatchObject({
      name: "EventRequestError",
      code: "VALIDATION_FAILED",
      fields: { startDatetime: MESSAGES.leadTime, expectedAttendance: MESSAGES.attendanceRequired },
    });
  });

  test.each([
    ["event_registration_enabled_capacity_check", { registrationCapacity: MESSAGES.registrationCapacityRequired }],
    ["event_datetime_order_check", { endDatetime: MESSAGES.endBeforeStart }],
    ["event_venue_preference_venue_id_fkey", { venuePreferences: MESSAGES.venuePreferencesInvalid }],
  ])("[EVT-ERR-001] should_map_constraint_%s_to_a_field_error", async (constraint, fields) => {
    rpcFails({ code: "23514", message: `new row for relation "event" violates check constraint "${constraint}"` });

    await expect(saveFails()).rejects.toMatchObject({ code: "VALIDATION_FAILED", fields });
  });

  test("[EVT-ERR-002] should_map_numeric_string_venue_rejection_to_a_field_error", async () => {
    rpcFails({ code: "P0001", message: "INVALID_VENUE_PREFERENCES" });

    await expect(saveFails()).rejects.toMatchObject({ fields: { venuePreferences: MESSAGES.venuePreferencesInvalid } });
  });

  test.each(["22001", "22003", "22007"])("[EVT-ERR-003] should_treat_data_exception_%s_as_a_validation_failure", async (code) => {
    rpcFails({ code, message: "bad value" });

    await expect(saveFails()).rejects.toMatchObject({ code: "VALIDATION_FAILED", fields: {} });
  });

  test.each(["EVENT_NOT_DRAFT", "NO_ELIGIBLE_COORDINATOR", "IDEMPOTENCY_KEY_REUSED"])(
    "[EVT-ERR-004] should_keep_domain_code_%s",
    async (message) => {
      rpcFails({ code: "P0001", message });

      await expect(saveFails()).rejects.toMatchObject({ name: "EventRequestError", code: message });
    }
  );

  test("[EVT-ERR-005] should_rethrow_unknown_database_failures_unchanged", async () => {
    const failure = { code: "57014", message: "canceling statement due to statement timeout" };
    rpcFails(failure);

    await expect(saveFails()).rejects.toBe(failure);
  });
});

describe("reads", () => {
  test("[TC-AUTH-013] should_filter_by_event_and_visibility_when_loading_one_request", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await expect(eventModel.findVisibleEvent(42, { user_id: 17, organisation_ids: [] })).resolves.toBeNull();

    expect(query.eq).toHaveBeenCalledWith("event_id", 42);
    expect(query.or).toHaveBeenCalledWith("organiser_id.eq.17");
  });

  test("[TC-AUTH-013] should_filter_by_owner_when_loading_a_request_to_edit", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await eventModel.findOwnEvent(42, 17);

    expect(query.eq).toHaveBeenCalledWith("event_id", 42);
    expect(query.eq).toHaveBeenCalledWith("organiser_id", 17);
  });

  test("[SPM-35-AC5] should_return_status_label_and_request_id_without_internal_fields_when_listing", async () => {
    const query = queryReturning({
      data: [
        {
          event_id: 42,
          title: "Gala",
          status: "SUBMITTED",
          organiser_id: 99,
          updated_at: POSTGREST_TIMESTAMP,
          organisation: { organisation_id: 3, name: "Org" },
        },
      ],
      error: null,
    });
    supabase.from.mockReturnValue(query);

    const { events, nextCursor } = await eventModel.findOrganiserEventRequests(
      { user_id: 17, organisation_ids: [3] },
      { limit: 5 }
    );

    expect(events[0]).toEqual(
      expect.objectContaining({
        eventId: 42,
        requestId: "REQ-000042",
        statusLabel: "Pending Approval",
        isOwner: false,
        organisation: { organisationId: 3, name: "Org" },
      })
    );
    expect(events[0]).not.toHaveProperty("purpose");
    expect(events[0]).not.toHaveProperty("organiser_id");
    expect(nextCursor).toBeNull();
  });

  test("[TC-AUTH-021] should_round_trip_a_cursor_built_from_a_postgrest_timestamp", async () => {
    const rows = [11, 10, 9].map((eventId) => ({ event_id: eventId, status: "DRAFT", updated_at: POSTGREST_TIMESTAMP }));
    const firstPage = queryReturning({ data: rows, error: null });
    supabase.from.mockReturnValue(firstPage);
    const user = { user_id: 17, organisation_ids: [] };

    const { nextCursor } = await eventModel.findOrganiserEventRequests(user, { limit: 2 });
    expect(eventModel.decodeCursor(nextCursor)).toEqual({ updatedAt: POSTGREST_TIMESTAMP, eventId: 10 });

    const secondPage = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(secondPage);
    await eventModel.findOrganiserEventRequests(user, { limit: 2, cursor: nextCursor, status: "DRAFT" });

    expect(secondPage.eq).toHaveBeenCalledWith("status", "DRAFT");
    expect(secondPage.or).toHaveBeenLastCalledWith(
      `updated_at.lt."${POSTGREST_TIMESTAMP}",and(updated_at.eq."${POSTGREST_TIMESTAMP}",event_id.lt.10)`
    );
    expect(secondPage.order).toHaveBeenNthCalledWith(1, "updated_at", { ascending: false });
    expect(secondPage.order).toHaveBeenNthCalledWith(2, "event_id", { ascending: false });
    expect(secondPage.limit).toHaveBeenCalledWith(3);
  });

  test.each([
    ["not base64 json", "not-a-cursor"],
    ["filter injection", Buffer.from(JSON.stringify({ updatedAt: "x,id.gt.0", eventId: 1 })).toString("base64url")],
    ["bad event id", Buffer.from(JSON.stringify({ updatedAt: POSTGREST_TIMESTAMP, eventId: "1" })).toString("base64url")],
  ])("[TC-AUTH-021] should_reject_the_cursor_when_it_is_%s", (_label, cursor) => {
    expect(() => eventModel.decodeCursor(cursor)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });

  test("[EVT-PERF-001] should_look_up_only_the_mentioned_layout_venues_and_equipment", async () => {
    const queries = {
      room: queryReturning({ data: [{ layout_type: "THEATRE" }], error: null }),
      venue: { select: jest.fn(() => ({ in: jest.fn().mockResolvedValue({ data: [{ venue_id: 2 }], error: null }) })) },
    };
    supabase.from.mockImplementation((table) => queries[table]);

    const context = await eventModel.findValidationContext({ preferredLayoutType: "THEATRE", venuePreferences: ["2", 2] });

    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(queries.room.eq).toHaveBeenCalledWith("layout_type", "THEATRE");
    expect(context).toEqual({ allowedLayouts: ["NO_PREFERENCE", "THEATRE"], venueIds: [2], equipmentIds: [] });
  });

  test("[EVT-PERF-001] should_not_query_the_database_when_no_catalogue_fields_are_sent", async () => {
    const context = await eventModel.findValidationContext({ title: "Gala" });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(context.allowedLayouts).toEqual(["NO_PREFERENCE"]);
  });
});
