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
  for (const method of ["select", "eq", "neq", "or", "order", "in", "is", "not", "gt"]) {
    query[method] = jest.fn(() => query);
  }
  query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
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

describe("organiser status note (SPM-33)", () => {
  test("[SPM-33-REVIEW] should_say_a_submitted_request_is_waiting_for_a_coordinator_until_one_is_assigned", () => {
    expect(eventModel.toStatusNote({ status: "SUBMITTED", coordinator_id: null })).toBe("Waiting for a coordinator");
    expect(eventModel.toApi({ event_id: 7, status: "SUBMITTED", coordinator_id: null })).toEqual(
      expect.objectContaining({ statusLabel: "Submitted", statusNote: "Waiting for a coordinator" })
    );
    expect(eventModel.toApi({ event_id: 7, status: "SUBMITTED", coordinator_id: null })).not.toHaveProperty("status");
  });

  test.each([
    ["a submitted request with a coordinator", { status: "SUBMITTED", coordinator_id: 5 }],
    ["a draft", { status: "DRAFT", coordinator_id: null }],
    ["a request under review", { status: "UNDER_REVIEW", coordinator_id: 5 }],
  ])("[SPM-33-REVIEW] should_not_add_a_note_for_%s", (_label, row) => {
    expect(eventModel.toStatusNote(row)).toBeNull();
  });

  test("[SPM-33-REVIEW] should_label_an_assigned_request_under_review", () => {
    expect(eventModel.toApi({ event_id: 7, status: "UNDER_REVIEW", coordinator_id: 5 })).toEqual(
      expect.objectContaining({ statusLabel: "Under Review", statusNote: null })
    );
  });

  // Master section 3.5: eight organiser labels for the stored states.
  test.each([
    ["DRAFT", "Draft", null],
    ["SUBMITTED", "Submitted", null],
    ["UNDER_REVIEW", "Under Review", null],
    ["AWAITING_CLARIFICATION", "Under Review", "Returned – action required"],
    ["PLANNING", "Approved & Planning", null],
    ["SAFETY_REVIEW", "Approved & Planning", null],
    ["CONFIRMED", "Confirmed", null],
    ["PREPARATION", "Confirmed", null],
    ["COMPLETED", "Completed", null],
    ["CANCELLED", "Cancelled", null],
    ["REJECTED", "Rejected", null],
  ])("[SPM-173-AC6] should_show_%s_to_the_organiser_as_%s_without_the_stored_state", (status, statusLabel, statusNote) => {
    expect(eventModel.toApi({ event_id: 7, status, coordinator_id: 5 })).toEqual(
      expect.objectContaining({ statusLabel, statusNote })
    );
    expect(eventModel.toApi({ event_id: 7, status, coordinator_id: 5 })).not.toHaveProperty("status");
  });

  test("[SPM-33-REVIEW] should_fall_back_to_the_stored_code_for_a_status_outside_the_lifecycle", () => {
    expect(eventModel.toApi({ event_id: 7, status: "APPROVED", coordinator_id: 5 })).toEqual(
      expect.objectContaining({ statusLabel: "Unknown status", statusNote: null })
    );
    expect(eventModel.toApi({ event_id: 7, status: "APPROVED", coordinator_id: 5 })).not.toHaveProperty("status");
  });

  test("[SPM-173-AC6] should_keep_the_stored_state_in_staff_event_views", () => {
    const access = {
      relationship: "ASSIGNED_COORDINATOR",
      canEdit: false,
      editableFields: [],
      historyAudiences: [],
    };
    expect(eventModel.toEventView(
      { event_id: 7, status: "SAFETY_REVIEW", coordinator_id: 5 },
      { user_id: 5 },
      access,
    )).toEqual(expect.objectContaining({ status: "SAFETY_REVIEW", statusLabel: "Approved & Planning" }));
    expect(eventModel.toApi({ event_id: 7, status: "UNDER_REVIEW" }, undefined, { includeStoredStatus: true }))
      .toEqual(expect.objectContaining({ status: "UNDER_REVIEW", statusLabel: "Under Review" }));
  });
});

describe("reads", () => {
  test("[TC-AUTH-013] should_filter_by_event_and_visibility_when_loading_one_request", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await expect(eventModel.findVisibleEvent(42, { user_id: 17, role: "ORGANISER", organisation_ids: [] })).resolves.toBeNull();

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
        statusLabel: "Submitted",
        statusNote: "Waiting for a coordinator",
        isOwner: false,
        organisation: { organisationId: 3, name: "Org" },
      })
    );
    expect(events[0]).not.toHaveProperty("purpose");
    expect(events[0]).not.toHaveProperty("status");
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
      venue: queryReturning({ data: [{ venue_id: 2 }], error: null }),
    };
    supabase.from.mockImplementation((table) => queries[table]);

    const context = await eventModel.findValidationContext({ preferredLayoutType: "THEATRE", venuePreferences: ["2", 2] });

    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(queries.room.eq).toHaveBeenCalledWith("layout_type", "THEATRE");
    expect(queries.venue.in).toHaveBeenCalledWith("venue_id", [2]);
    expect(context).toEqual({ allowedLayouts: ["NO_PREFERENCE", "THEATRE"], venueIds: [2], equipmentIds: [] });
  });

  test("[SPM-73] should_accept_only_available_venues_as_preferences", async () => {
    const venue = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(venue);

    const context = await eventModel.findValidationContext({ venuePreferences: [5] });

    expect(venue.eq).toHaveBeenCalledWith("is_active", true);
    expect(venue.eq).toHaveBeenCalledWith("status", "ACTIVE");
    expect(context.venueIds).toEqual([]);
  });

  test("[SPM-73] should_offer_only_available_venues_in_request_options", async () => {
    const queries = {
      venue: queryReturning({ data: [{ venue_id: 1, name: "Hall" }], error: null }),
      room: queryReturning({ data: [{ layout_type: "THEATRE" }], error: null }),
      equipment: queryReturning({ data: [{ equipment_id: 7, name: "Projector", total_quantity: 20 }], error: null }),
    };
    supabase.from.mockImplementation((table) => queries[table]);

    const options = await eventModel.findRequestOptions();

    expect(queries.venue.eq).toHaveBeenCalledWith("is_active", true);
    expect(queries.venue.eq).toHaveBeenCalledWith("status", "ACTIVE");
    expect(options.venues).toEqual([{ venueId: 1, name: "Hall" }]);
    expect(options.equipment).toEqual([{ equipmentId: 7, name: "Projector" }]);
    expect(queries.equipment.select).toHaveBeenCalledWith("equipment_id,name");
  });

  test("[EVT-PERF-001] should_not_query_the_database_when_no_catalogue_fields_are_sent", async () => {
    const context = await eventModel.findValidationContext({ title: "Gala" });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(context.allowedLayouts).toEqual(["NO_PREFERENCE"]);
  });

  test("[SPM-180-AC3] should_scope_coordinator_event_reads_to_the_current_assignee", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await eventModel.findVisibleEvent(42, { user_id: 21, role: "COORDINATOR" });

    expect(query.eq).toHaveBeenCalledWith("event_id", 42);
    expect(query.eq).toHaveBeenCalledWith("coordinator_id", 21);
    expect(query.neq).toHaveBeenCalledWith("status", "DRAFT");
    expect(query.or).not.toHaveBeenCalled();
  });

  test("[SPM-180-AC3/AC4] should_list_only_events_assigned_to_the_requested_coordinator", async () => {
    const query = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(query);

    await eventModel.findCoordinatorEvents(21);

    expect(query.eq).toHaveBeenCalledWith("coordinator_id", 21);
    expect(query.neq).toHaveBeenCalledWith("status", "DRAFT");
    expect(query.order).toHaveBeenCalledWith("start_datetime", { ascending: true });
  });
});

describe("Attendee discovery and registration availability", () => {
  test("[SPM-126] should_exclude_past_events_from_attendee_detail_lookup", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await eventModel.findPublishedAttendeeEvent(42);

    expect(query.gt).toHaveBeenCalledWith("end_datetime", expect.any(String));
  });

  test("[SPM-126] should_count_only_registered_attendees_when_computing_capacity", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await eventModel.findPublishedAttendeeEvent(42);

    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("registration(count)"));
    expect(query.eq).toHaveBeenCalledWith("event_id", 42);
    expect(query.eq).toHaveBeenCalledWith("registration.registration_status", "REGISTERED");
  });

  const discoveryRow = (overrides = {}) => ({
    event_id: 7,
    title: "Gala",
    description: "Public description",
    start_datetime: POSTGREST_TIMESTAMP,
    end_datetime: "2026-10-07T09:14:14.406209+00:00",
    status: "CONFIRMED",
    is_registration_enabled: true,
    registration_capacity: 2,
    registration_open_at: null,
    registration_close_at: null,
    organisation: { organisation_id: 1, name: "Org" },
    registration: [{ count: 2 }],
    ...overrides,
  });

  test("[SPM-44] should_query_only_published_confirmed_events_in_list_and_detail", async () => {
    const row = discoveryRow({ status: "CONFIRMED", registration: [{ count: 0 }] });
    const list = queryReturning({ data: [row], error: null });
    const detail = queryReturning({ data: row, error: null });
    supabase.from.mockReturnValueOnce(list).mockReturnValueOnce(detail);

    expect((await eventModel.findPublishedAttendeeEvents({ limit: 10 })).events[0].registrationAvailability).toBe("OPEN");
    expect((await eventModel.findPublishedAttendeeEvent(7)).registrationAvailability).toBe("OPEN");
    for (const query of [list, detail]) {
      expect(query.eq).toHaveBeenCalledWith("is_published", true);
      expect(query.eq).toHaveBeenCalledWith("status", "CONFIRMED");
      expect(query.eq).not.toHaveBeenCalledWith("status", "PREPARATION");
      expect(query.in).not.toHaveBeenCalledWith("status", expect.arrayContaining(["PREPARATION"]));
    }
  });

  const booking = (status, id = 1, name = "Public Hall") => ({
    status, room: { venue: { venue_id: id, name, address: "1 Test Road" } },
  });

  test.each([
    ["approved venue", [booking("PENDING", 2, "Private venue"), booking("APPROVED")], "Public Hall, 1 Test Road"],
    ["duplicate bookings at the same venue", [booking("APPROVED"), booking("APPROVED")], "Public Hall, 1 Test Road"],
    ["no bookings", [], null],
    ["pending or rejected bookings", [booking("PENDING"), booking("REJECTED"), booking("CANCELLED")], null],
    ["missing venue relationship", [{ status: "APPROVED", room: null }], null],
    ["ambiguous approved venues", [booking("APPROVED"), booking("APPROVED", 2, "Other Hall")], null],
  ])("[SPM-34-AC1/AC5] should_publish_only_a_safe_location_for_%s", async (_label, venue_booking, location) => {
    const row = discoveryRow({ venue_booking, purpose: "Private purpose" });
    supabase.from.mockReturnValueOnce(queryReturning({ data: [row], error: null }))
      .mockReturnValueOnce(queryReturning({ data: row, error: null }));

    const list = (await eventModel.findPublishedAttendeeEvents({ limit: 10 })).events[0];
    const detail = await eventModel.findPublishedAttendeeEvent(7);
    for (const item of [list, detail]) {
      expect(item.location).toBe(location);
      expect(item).not.toHaveProperty("venue_booking");
      expect(item).not.toHaveProperty("purpose");
      expect(JSON.stringify(item)).not.toContain("Private venue");
    }
  });

  test.each(["2026-02-31", "2026-02-29", "2026-04-31", "0000-01-01"])("should_reject_invalid_calendar_date_%s_before_querying", async (date) => {
    const cursor = (key) => Buffer.from(JSON.stringify({ [key]: `${date}T09:00:00.123456Z`, eventId: 1 })).toString("base64url");
    expect(() => eventModel.decodeDiscoveryCursor(cursor("startDatetime"))).toThrow("INVALID_CURSOR");
    expect(() => eventModel.decodeCursor(cursor("updatedAt"))).toThrow("INVALID_CURSOR");
    await expect(eventModel.findPublishedAttendeeEvents({ limit: 10, cursor: cursor("startDatetime") }))
      .rejects.toMatchObject({ code: "INVALID_CURSOR" });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("should_preserve_a_valid_leap_day_and_microseconds_in_both_cursors", () => {
    const timestamp = "2028-02-29T09:00:00.123456+08:00";
    expect(eventModel.decodeDiscoveryCursor(Buffer.from(JSON.stringify({ startDatetime: timestamp, eventId: 1 })).toString("base64url")))
      .toEqual({ startDatetime: timestamp, eventId: 1 });
    expect(eventModel.decodeCursor(eventModel.encodeCursor({ updated_at: timestamp, event_id: 1 })))
      .toEqual({ updatedAt: timestamp, eventId: 1 });
  });

  test("[SPM-34-AC3] should_report_the_same_availability_in_the_list_and_the_detail", async () => {
    const row = discoveryRow();
    const listQuery = queryReturning({ data: [row], error: null });
    const detailQuery = queryReturning({ data: row, error: null });
    supabase.from.mockReturnValueOnce(listQuery).mockReturnValueOnce(detailQuery);

    const { events } = await eventModel.findPublishedAttendeeEvents({ limit: 10 });
    const detail = await eventModel.findPublishedAttendeeEvent(7);

    expect(events[0].registrationAvailability).toBe("FULL_WAITLIST");
    expect(detail.registrationAvailability).toBe("FULL_WAITLIST");
    expect(listQuery.select).toHaveBeenCalledWith(expect.stringContaining("registration(count)"));
    expect(listQuery.eq).toHaveBeenCalledWith("registration.registration_status", "REGISTERED");
    expect(Object.keys(events[0])).not.toContain("registration");
    expect(Object.keys(detail)).not.toContain("registration");
  });

  test("[SPM-34-AC1] should_list_soonest_start_first_with_event_id_as_the_tie_breaker", async () => {
    const query = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(query);

    const result = await eventModel.findPublishedAttendeeEvents({ limit: 10 });

    expect(query.order.mock.calls).toEqual([
      ["start_datetime", { ascending: true }],
      ["event_id", { ascending: true }],
    ]);
    expect(query.limit).toHaveBeenCalledWith(11);
    expect(query.or).not.toHaveBeenCalled();
    expect(result).toEqual({ events: [], nextCursor: null });
  });

  test("[SPM-34-AC1] should_page_after_the_last_start_time_and_event_id", async () => {
    const rows = [discoveryRow({ event_id: 3 }), discoveryRow({ event_id: 9 }), discoveryRow({ event_id: 12 })];
    supabase.from.mockReturnValue(queryReturning({ data: rows, error: null }));

    const { events, nextCursor } = await eventModel.findPublishedAttendeeEvents({ limit: 2 });
    expect(events.map(({ eventId }) => eventId)).toEqual([3, 9]);
    expect(eventModel.decodeDiscoveryCursor(nextCursor)).toEqual({ startDatetime: POSTGREST_TIMESTAMP, eventId: 9 });

    const next = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(next);
    await eventModel.findPublishedAttendeeEvents({ limit: 2, cursor: nextCursor });

    expect(next.or).toHaveBeenCalledWith(
      `start_datetime.gt."${POSTGREST_TIMESTAMP}",and(start_datetime.eq."${POSTGREST_TIMESTAMP}",event_id.gt.9)`
    );
  });

  test("[SPM-34-AC1] should_list_an_event_that_has_started_but_not_ended", async () => {
    const inProgress = discoveryRow({
      start_datetime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      end_datetime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      registration: [{ count: 0 }],
    });
    const query = queryReturning({ data: [inProgress], error: null });
    supabase.from.mockReturnValue(query);

    const { events } = await eventModel.findPublishedAttendeeEvents({ limit: 10 });

    expect(query.gt.mock.calls).toEqual([["end_datetime", expect.any(String)]]);
    expect(events).toEqual([expect.objectContaining({ eventId: 7, registrationAvailability: "OPEN" })]);
  });

  test("[SPM-34-AC1] should_reject_a_cursor_that_does_not_carry_a_start_time", async () => {
    const organiserCursor = eventModel.encodeCursor({ updated_at: POSTGREST_TIMESTAMP, event_id: 9 });

    await expect(
      eventModel.findPublishedAttendeeEvents({ limit: 2, cursor: organiserCursor })
    ).rejects.toEqual(expect.objectContaining({ code: "INVALID_CURSOR" }));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("[SPM-34-AC3] should_report_not_enabled_when_registration_is_disabled", () => {
    expect(eventModel.computeRegistrationAvailability({
      status: "CONFIRMED",
      is_registration_enabled: false,
      registration_capacity: 10,
      registration_open_at: null,
      registration_close_at: null,
      registeredCount: 10,
    })).toBe("NOT_ENABLED");
  });

  test("[SPM-34-AC3] should_treat_null_capacity_and_window_values_as_open_and_unlimited_when_registration_is_enabled", () => {
    expect(eventModel.computeRegistrationAvailability({
      status: "CONFIRMED",
      is_registration_enabled: true,
      registration_capacity: null,
      registration_open_at: null,
      registration_close_at: null,
      registeredCount: 0,
    })).toBe("OPEN");
  });

  test("[SPM-34-AC3] should_return_closed_when_registration_window_is_outside_the_open_range", () => {
    const now = new Date().toISOString();
    expect(eventModel.computeRegistrationAvailability({
      status: "CONFIRMED",
      is_registration_enabled: true,
      registration_capacity: 20,
      registration_open_at: new Date(Date.now() + 60_000).toISOString(),
      registration_close_at: new Date(Date.now() + 120_000).toISOString(),
      registeredCount: 0,
      now,
    })).toBe("CLOSED");
    expect(eventModel.computeRegistrationAvailability({
      status: "CONFIRMED",
      is_registration_enabled: true,
      registration_capacity: 20,
      registration_open_at: new Date(Date.now() - 120_000).toISOString(),
      registration_close_at: new Date(Date.now() - 60_000).toISOString(),
      registeredCount: 0,
      now,
    })).toBe("CLOSED");
  });

  test("[SPM-34-AC3] should_open_registration_at_the_open_instant_and_close_it_at_the_close_instant", () => {
    const openAt = "2026-10-20T09:00:00.000Z";
    const closeAt = "2026-10-21T09:00:00.000Z";
    const availabilityAt = (now) => eventModel.computeRegistrationAvailability({
      status: "CONFIRMED",
      is_registration_enabled: true,
      registration_capacity: 20,
      registration_open_at: openAt,
      registration_close_at: closeAt,
      registeredCount: 0,
      now,
    });
    const millisecondBefore = (instant) => new Date(Date.parse(instant) - 1).toISOString();

    expect(availabilityAt(millisecondBefore(openAt))).toBe("CLOSED");
    expect(availabilityAt(openAt)).toBe("OPEN");
    expect(availabilityAt(millisecondBefore(closeAt))).toBe("OPEN");
    expect(availabilityAt(closeAt)).toBe("CLOSED");
  });

  test("[SPM-34-AC3] should_return_full_waitlist_only_when_the_confirmed_event_reaches_capacity", () => {
    expect(eventModel.computeRegistrationAvailability({
      status: "CONFIRMED",
      is_registration_enabled: true,
      registration_capacity: 3,
      registration_open_at: null,
      registration_close_at: null,
      registeredCount: 3,
    })).toBe("FULL_WAITLIST");
    expect(eventModel.computeRegistrationAvailability({
      status: "CONFIRMED",
      is_registration_enabled: true,
      registration_capacity: 3,
      registration_open_at: null,
      registration_close_at: null,
      registeredCount: 2,
    })).toBe("OPEN");
  });

  test("[SPM-34-AC3] should_allow_registration_during_preparation_when_enabled_and_window_is_open", () => {
    expect(eventModel.computeRegistrationAvailability({
      status: "PREPARATION",
      is_registration_enabled: true,
      registration_capacity: 10,
      registration_open_at: null,
      registration_close_at: null,
      registeredCount: 0,
    })).toBe("OPEN");
  });
});

describe("Lead assignment reads", () => {
  test("should_list_only_submitted_unassigned_events_in_queue_order", async () => {
    const query = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(query);

    await eventModel.findUnassignedSubmittedEvents();

    expect(query.eq).toHaveBeenCalledWith("status", "SUBMITTED");
    expect(query.is).toHaveBeenCalledWith("coordinator_id", null);
    expect(query.order).toHaveBeenNthCalledWith(1, "submitted_at", { ascending: true, nullsFirst: false });
    expect(query.order).toHaveBeenNthCalledWith(2, "created_at", { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(3, "event_id", { ascending: true });
  });

  test("should_scope_active_assignments_to_the_verified_lead_in_the_database", async () => {
    const assignments = [{ eventId: 42, coordinatorId: 20, coordinatorName: "Coordinator Two", hasScheduleConflict: true }];
    supabase.rpc.mockResolvedValue({ data: assignments, error: null });
    await expect(eventModel.findLeadAssignments(10)).resolves.toEqual(assignments);
    expect(supabase.rpc).toHaveBeenCalledWith("list_lead_event_assignments", { p_lead_id: 10 });
  });

  test("should_return_only_active_coordinators_and_their_active_event_schedules", async () => {
    const userRows = [{ user_id: 20, name: "Coordinator Two" }];
    const eventRows = [{
      event_id: 42, coordinator_id: 20, status: "PLANNING", title: "Conference",
      start_datetime: "2026-11-01T09:00:00.000Z", end_datetime: "2026-11-01T10:00:00.000Z",
      expected_attendance: 100,
    }];
    const userQuery = queryReturning({ data: userRows, error: null });
    const eventQuery = queryReturning({ data: eventRows, error: null });
    supabase.from.mockImplementation((table) => table === "user" ? userQuery : eventQuery);

    await expect(eventModel.findCoordinatorAvailability()).resolves.toEqual([
      expect.objectContaining({ coordinatorId: 20, name: "Coordinator Two", events: [expect.objectContaining({ eventId: 42 })] }),
    ]);
    expect(userQuery.eq).toHaveBeenNthCalledWith(1, "role", "COORDINATOR");
    expect(userQuery.eq).toHaveBeenNthCalledWith(2, "is_active", true);
  });
});

describe("SPM-180 reassignment RPC", () => {
  test("[SPM-180-AC1/AC2] should_call_the_atomic_rpc_and_return_the_new_current_coordinator", async () => {
    supabase.rpc.mockResolvedValue({
      data: {
        event: { event_id: 42, title: "Conference", status: "SUBMITTED", coordinator_id: 29 },
        coordinator: { user_id: 29, name: "Coordinator Two" },
      },
      error: null,
    });

    const result = await eventModel.reassignCoordinator({ eventId: 42, coordinatorId: 29, expectedCoordinatorId: 21, leadId: 10 });

    expect(supabase.rpc).toHaveBeenCalledWith("reassign_event_coordinator", {
      p_event_id: 42,
      p_coordinator_id: 29,
      p_expected_coordinator_id: 21,
      p_lead_id: 10,
    });
    expect(result).toEqual({
      event: { eventId: 42, requestId: "REQ-000042", title: "Conference", status: "SUBMITTED", coordinatorId: 29 },
      coordinator: { coordinatorId: 29, name: "Coordinator Two" },
    });
  });

  test.each(["EVENT_NOT_REASSIGNABLE", "INVALID_COORDINATOR", "COORDINATOR_CONFLICT", "COORDINATOR_UNCHANGED", "ASSIGNMENT_CHANGED"])(
    "[SPM-180] should_preserve_domain_error_%s_from_the_atomic_rpc",
    async (code) => {
      supabase.rpc.mockResolvedValue({ data: null, error: { message: code, code: "P0001" } });

      await expect(eventModel.reassignCoordinator({ eventId: 42, coordinatorId: 29, expectedCoordinatorId: 21, leadId: 10 })).rejects.toMatchObject({
        name: "EventRequestError",
        code,
      });
    }
  );
});


describe("SPM-36 submission metadata", () => {
  test("[BE-03] submission time is independent of last update and Coordinator name is safe to display", () => {
    const event = eventModel.toApi({ event_id: 42, status: "UNDER_REVIEW", coordinator_id: 20,
      coordinator: { name: "Coordinator One" }, submitted_at: "2026-10-19T10:00:00Z", updated_at: "2026-10-20T11:00:00Z" });
    expect(event.submittedAt).toBe("2026-10-19T10:00:00Z");
    expect(event.updatedAt).toBe("2026-10-20T11:00:00Z");
    expect(event.coordinatorName).toBe("Coordinator One");
    expect(event.coordinatorId).toBeUndefined();
  });
  test("[BE-03] legacy events never invent a submission time", () => {
    expect(eventModel.toApi({ event_id: 42, status: "SUBMITTED", created_at: POSTGREST_TIMESTAMP, updated_at: POSTGREST_TIMESTAMP }).submittedAt).toBeNull();
  });
});


describe("[SPM-177 AC2] coordinator point of contact", () => {
  test("fresh scoped reads fetch only the coordinator's display name", async () => {
    const row = { event_id: 42, organiser_id: 11, coordinator_id: 20, status: "UNDER_REVIEW", coordinator: { name: "Alex Coordinator" } };
    const query = queryReturning({ data: row, error: null });
    supabase.from.mockReturnValue(query);
    const result = await eventModel.findVisibleEvent(42, { user_id: 11, role: "ORGANISER", organisation_ids: [] });
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("coordinator:user!event_coordinator_id_fkey(name)"));
    expect(eventModel.toApi(result, 11).coordinatorName).toBe("Alex Coordinator");
    expect(eventModel.toApi(result, 11)).not.toHaveProperty("coordinator.email");
  });
  test("unassigned or unavailable coordinator names are null", () => {
    expect(eventModel.toApi({ event_id: 42, status: "SUBMITTED", coordinator_id: null }).coordinatorName).toBeNull();
    expect(eventModel.toApi({ event_id: 42, status: "UNDER_REVIEW", coordinator_id: 20 }).coordinatorName).toBeNull();
  });
  test("a revoked Lead permission is returned as a domain denial", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: "FORBIDDEN" } });
    await expect(eventModel.assignCoordinator({ eventId: 42, coordinatorId: 20, leadId: 11 })).rejects.toMatchObject({ code: "FORBIDDEN", name: "EventRequestError" });
  });
});

describe("An attendee's own registered event (SPM-155 AC4, AC5)", () => {
  const eventRow = (overrides = {}) => ({
    event_id: 7,
    title: "Gala",
    description: "Public description",
    start_datetime: POSTGREST_TIMESTAMP,
    end_datetime: "2026-10-07T09:14:14.406209+00:00",
    status: "CONFIRMED",
    is_published: true,
    is_registration_enabled: true,
    registration_capacity: 100,
    registration_open_at: null,
    registration_close_at: null,
    organisation: { organisation_id: 1, name: "Org" },
    registration: [{ count: 2 }],
    venue_booking: [{ status: "APPROVED", room: { venue: { venue_id: 3, name: "Hall", address: "1 Road" } } }],
    ...overrides,
  });
  const registered = { registration_status: "REGISTERED", registration_datetime: "2026-10-01T00:00:00+00:00" };
  // The shape SPM-173's _event_attendee_snapshot stores.
  const snapshotRow = (overrides = {}) => ({
    confirmed_at: "2026-09-20T02:00:00+00:00",
    snapshot: {
      title: "Gala (as confirmed)",
      description: "Confirmed description",
      start_datetime: "2026-11-01T01:00:00+00:00",
      end_datetime: "2026-11-01T03:00:00+00:00",
      is_published: true,
      is_registration_enabled: true,
      registration_capacity: 80,
      registration_open_at: "2026-10-01T00:00:00+00:00",
      registration_close_at: "2026-10-31T00:00:00+00:00",
      primary_venue: { venue_id: 99, name: "Confirmed Hall", address: "2 Road" },
      ...overrides,
    },
  });
  const withheld = (attendeeStatus) => ({
    eventId: 7,
    title: "Gala",
    description: null,
    startDatetime: null,
    endDatetime: null,
    organisationName: null,
    location: null,
    registrationAvailability: "CLOSED",
    registrationOpenAt: null,
    registrationCloseAt: null,
    attendeeStatus,
    detailsWithheld: true,
    lastConfirmedAt: null,
  });

  // The registration, the event and the latest snapshot are separate queries.
  const tables = ({ registrations = [], event = null, snapshots = [] }) => {
    const registrationQuery = queryReturning({ data: registrations, error: null });
    const eventQuery = queryReturning({ data: event, error: null });
    const snapshotQuery = queryReturning({ data: snapshots, error: null });
    supabase.from.mockImplementation((table) => {
      if (table === "registration") return registrationQuery;
      if (table === "event_confirmation_snapshots") return snapshotQuery;
      return eventQuery;
    });
    return { registrationQuery, eventQuery, snapshotQuery };
  };

  test("[SPM-155 AC6] should_look_up_only_this_attendee's_active_registration", async () => {
    const { registrationQuery } = tables({});
    await eventModel.findRegisteredAttendeeEvent(7, 21);
    expect(registrationQuery.eq).toHaveBeenCalledWith("event_id", 7);
    expect(registrationQuery.eq).toHaveBeenCalledWith("attendee_id", 21);
    expect(registrationQuery.in).toHaveBeenCalledWith("registration_status", ["REGISTERED", "WAITLISTED"]);
  });

  test.each([
    ["CONFIRMED", "CONFIRMED"],
    ["PREPARATION", "CONFIRMED"],
    ["COMPLETED", "COMPLETED"],
  ])("[SPM-155 AC5] should_return_the_current_details_and_my_registration_for_a_%s_event", async (status, attendeeStatus) => {
    const { eventQuery, snapshotQuery } = tables({ registrations: [registered], event: eventRow({ status }), snapshots: [snapshotRow()] });
    const found = await eventModel.findRegisteredAttendeeEvent(7, 21);
    expect(Object.keys(found).sort()).toEqual(["event", "myRegistration"]);
    expect(found.event).toEqual({
      eventId: 7,
      title: "Gala",
      description: "Public description",
      startDatetime: POSTGREST_TIMESTAMP,
      endDatetime: "2026-10-07T09:14:14.406209+00:00",
      organisationName: "Org",
      location: "Hall, 1 Road",
      registrationAvailability: expect.any(String),
      registrationOpenAt: null,
      registrationCloseAt: null,
      attendeeStatus,
      detailsWithheld: false,
      lastConfirmedAt: null,
    });
    expect(found.myRegistration).toEqual({ status: "REGISTERED", registeredAt: "2026-10-01T00:00:00+00:00" });
    // A past event the attendee is registered for still opens.
    expect(eventQuery.gt).not.toHaveBeenCalled();
    // The current values are the confirmed ones, so no snapshot is read.
    expect(snapshotQuery.select).not.toHaveBeenCalled();
  });

  test.each([
    ["PLANNING", "PENDING_CONFIRMATION"],
    ["SAFETY_REVIEW", "PENDING_CONFIRMATION"],
    ["CANCELLED", "CANCELLED"],
  ])("[SPM-155 AC5 / Master 5.7] should_show_the_last_confirmation_snapshot_for_a_%s_event", async (status, attendeeStatus) => {
    const { snapshotQuery } = tables({
      registrations: [{ ...registered, registration_status: "WAITLISTED" }],
      event: eventRow({ status, title: "Gala (renamed, unconfirmed)", start_datetime: "2027-01-01T00:00:00+00:00" }),
      snapshots: [snapshotRow()],
    });
    const found = await eventModel.findRegisteredAttendeeEvent(7, 21);
    expect(found.event).toEqual({
      eventId: 7,
      title: "Gala (as confirmed)",
      description: "Confirmed description",
      startDatetime: "2026-11-01T01:00:00+00:00",
      endDatetime: "2026-11-01T03:00:00+00:00",
      organisationName: "Org",
      location: "Confirmed Hall, 2 Road",
      registrationAvailability: "CLOSED",
      registrationOpenAt: "2026-10-01T00:00:00+00:00",
      registrationCloseAt: "2026-10-31T00:00:00+00:00",
      attendeeStatus,
      detailsWithheld: false,
      lastConfirmedAt: "2026-09-20T02:00:00+00:00",
    });
    // The latest snapshot of this event, and nothing internal from it.
    expect(snapshotQuery.eq).toHaveBeenCalledWith("event_id", 7);
    expect(snapshotQuery.order).toHaveBeenCalledWith("snapshot_id", { ascending: false });
    expect(snapshotQuery.limit).toHaveBeenCalledWith(1);
    expect(JSON.stringify(found)).not.toMatch(/venue_id|capacity|is_published|is_registration_enabled|confirmed_by/);
    expect(found.myRegistration.status).toBe("WAITLISTED");
  });

  test.each(["PLANNING", "SAFETY_REVIEW", "CANCELLED"])("[SPM-155 AC5] should_withhold_a_%s_event_that_has_no_snapshot", async (status) => {
    tables({ registrations: [registered], event: eventRow({ status }) });
    const { event } = await eventModel.findRegisteredAttendeeEvent(7, 21);
    expect(event).toEqual(withheld(status === "CANCELLED" ? "CANCELLED" : "PENDING_CONFIRMATION"));
  });

  test("[SPM-155] should_withhold_when_the_snapshot_was_taken_while_unpublished", async () => {
    tables({ registrations: [registered], event: eventRow({ status: "PLANNING" }), snapshots: [snapshotRow({ is_published: false })] });
    const { event } = await eventModel.findRegisteredAttendeeEvent(7, 21);
    expect(event).toEqual(withheld("PENDING_CONFIRMATION"));
  });

  test("[SPM-155] should_show_a_snapshot_without_a_venue_with_no_location", async () => {
    tables({ registrations: [registered], event: eventRow({ status: "CANCELLED" }), snapshots: [snapshotRow({ primary_venue: null })] });
    const { event } = await eventModel.findRegisteredAttendeeEvent(7, 21);
    expect(event).toMatchObject({ location: null, detailsWithheld: false, lastConfirmedAt: "2026-09-20T02:00:00+00:00" });
  });

  test.each(["UNDER_REVIEW", "AWAITING_CLARIFICATION", "SUBMITTED"])("[SPM-155] should_withhold_a_%s_event_without_reading_snapshots", async (status) => {
    const { snapshotQuery } = tables({ registrations: [registered], event: eventRow({ status }), snapshots: [snapshotRow()] });
    const { event } = await eventModel.findRegisteredAttendeeEvent(7, 21);
    expect(event.detailsWithheld).toBe(true);
    expect(snapshotQuery.select).not.toHaveBeenCalled();
  });

  test("[SPM-155] should_withhold_details_of_an_unpublished_confirmed_event", async () => {
    tables({ registrations: [registered], event: eventRow({ is_published: false }), snapshots: [snapshotRow()] });
    const { event } = await eventModel.findRegisteredAttendeeEvent(7, 21);
    expect(event.detailsWithheld).toBe(true);
    expect(event.startDatetime).toBeNull();
  });

  test("[SPM-155] should_throw_when_the_snapshot_read_fails", async () => {
    const { snapshotQuery } = tables({ registrations: [registered], event: eventRow({ status: "PLANNING" }) });
    snapshotQuery.limit.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(eventModel.findRegisteredAttendeeEvent(7, 21)).rejects.toThrow("permission denied");
  });

  test("[SPM-155 AC6] should_return_null_without_querying_the_event_when_the_attendee_holds_no_place", async () => {
    const { eventQuery } = tables({ event: eventRow() });
    await expect(eventModel.findRegisteredAttendeeEvent(7, 21)).resolves.toBeNull();
    expect(eventQuery.select).not.toHaveBeenCalled();
  });

  test("[SPM-155] should_return_null_when_the_event_row_is_gone", async () => {
    tables({ registrations: [registered], event: null });
    await expect(eventModel.findRegisteredAttendeeEvent(7, 21)).resolves.toBeNull();
  });
});
