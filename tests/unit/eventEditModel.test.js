// Unit tests for the SPM-33 parts of the event model and validator: the coordinator
// edit, the optional version on draft saves and the role-scoped read. Supabase is mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require("../../config/supabase");
const eventModel = require("../../model/eventModel");
const { validateOrdinaryFields, MESSAGES } = require("../../validators/eventValidator");
const { COORDINATOR_EDITABLE_STATUSES } = require("../../config/eventConstants");

const organiser = (userId, organisationIds = []) => ({ user_id: userId, role: "ORGANISER", organisation_ids: organisationIds });
const staff = (role, userId) => ({ user_id: userId, role, organisation_ids: [] });

const queryReturning = (result) => {
  const query = {};
  for (const method of ["select", "eq", "neq", "or"]) {
    query[method] = jest.fn(() => query);
  }
  query.limit = jest.fn().mockResolvedValue(result);
  query.maybeSingle = jest.fn().mockResolvedValue(result);
  return query;
};

beforeEach(() => jest.clearAllMocks());

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

describe("eventModel.findVisibleEvent (AC1)", () => {
  test.each(["VENUE_STAFF", "TECH_SUPPORT", "ATTENDEE", "COORDINATOR_LEAD"])(
    "[SPM-33-TC-14] should_return_null_without_running_a_query_when_the_user_is_%s",
    async (role) => {
      const query = queryReturning({ data: { event_id: 42 }, error: null });
      supabase.from.mockReturnValue(query);

      await expect(eventModel.findVisibleEvent(42, staff(role, 21))).resolves.toBeNull();

      expect(query.maybeSingle).not.toHaveBeenCalled();
    }
  );

  test("[SPM-33-TC-06] should_filter_by_the_assigned_coordinator_and_exclude_drafts", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await expect(eventModel.findVisibleEvent(42, staff("COORDINATOR", 21))).resolves.toBeNull();

    expect(supabase.from).toHaveBeenCalledWith("event");
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("organiser:user!event_organiser_id_fkey(user_id,name)"));
    expect(query.eq).toHaveBeenCalledWith("event_id", 42);
    expect(query.eq).toHaveBeenCalledWith("coordinator_id", 21);
    expect(query.neq).toHaveBeenCalledWith("status", "DRAFT");
  });

  test("[SPM-33-TC-02] should_apply_the_organiser_visibility_filter", async () => {
    const query = queryReturning({ data: null, error: null });
    supabase.from.mockReturnValue(query);

    await eventModel.findVisibleEvent(42, organiser(12, [5]));

    expect(query.or).toHaveBeenCalledWith("organiser_id.eq.12,and(organisation_id.in.(5),status.neq.DRAFT)");
  });
});
