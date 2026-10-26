// SPM-246 (SPM-243 AC2): the Safety Officer's event scope, edit refusal,
// projection and review-relevant history.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require("../../config/supabase");
const eventModel = require("../../model/eventModel");
const activityModel = require("../../model/activityModel");
const { isRoundInOfficerScope, officerScopeFilter } = eventModel;
const { getEventRelationship, getEventAccess, getEditDenial } = require("../../middleware/authorize");

const OFFICER = { user_id: 31, role: "SAFETY_OFFICER", organisation_ids: [] };

const round = (overrides = {}) => ({ review_id: 7, status: "OPEN", claimed_by: null, decided_by: null, ...overrides });
const eventRow = (rounds, overrides = {}) => ({
  event_id: 42,
  organiser_id: 11,
  coordinator_id: 21,
  status: "SAFETY_REVIEW",
  title: "Open day",
  arrangement_version: 3,
  registration: [{ count: 3 }],
  organiser: { user_id: 11, name: "Owner" },
  safety_reviews: rounds,
  ...overrides,
});

describe("isRoundInOfficerScope (AC2)", () => {
  test.each([
    ["an open unclaimed round", round(), true],
    ["an open round they hold", round({ claimed_by: 31 }), true],
    ["an open round another officer holds", round({ claimed_by: 32 }), false],
    ["a round they decided", round({ status: "APPROVED", decided_by: 31 }), true],
    ["a round another officer decided", round({ status: "REJECTED", decided_by: 32 }), false],
    ["a superseded round they held", round({ status: "SUPERSEDED", claimed_by: 31 }), false],
  ])("[SPM-243-TC-03] should_judge_%s", (_label, value, expected) => {
    expect(isRoundInOfficerScope(value, 31)).toBe(expected);
  });

  test("should_build_the_same_rule_as_a_query_filter_and_refuse_a_non_numeric_id", () => {
    expect(officerScopeFilter(31)).toBe("and(status.eq.OPEN,claimed_by.is.null),and(status.eq.OPEN,claimed_by.eq.31),decided_by.eq.31");
    expect(() => officerScopeFilter("31,decided_by.is.null")).toThrow("Invalid officer ID.");
  });
});

describe("Safety Officer relationship and access (AC2)", () => {
  test("[SPM-243-TC-03] should_give_a_relationship_only_through_a_round_in_scope", () => {
    expect(getEventRelationship(OFFICER, eventRow([round()]))).toBe("SAFETY_OFFICER");
    expect(getEventRelationship(OFFICER, eventRow([round({ claimed_by: 32 })]))).toBeNull();
    expect(getEventRelationship(OFFICER, eventRow([]))).toBeNull();
    expect(getEventRelationship(OFFICER, eventRow(undefined))).toBeNull();
  });

  test("[SPM-243-TC-07] should_keep_the_view_of_a_handed_back_round_like_any_other_officer", () => {
    expect(getEventRelationship(OFFICER, eventRow([round({ claimed_by: null })]))).toBe("SAFETY_OFFICER");
  });

  test("[SPM-243-TC-04] should_never_let_a_safety_officer_edit_and_answer_forbidden", () => {
    const row = eventRow([round({ claimed_by: 31 })]);
    const access = getEventAccess(OFFICER, row);
    expect(access).toEqual(expect.objectContaining({
      relationship: "SAFETY_OFFICER",
      canEdit: false,
      editableFields: [],
      historyAudiences: ["ORGANISER_SAFE", "STAFF_ONLY"],
    }));
    expect(access.historyFields).toEqual(expect.arrayContaining(["expectedAttendance", "venuePreferences", "accessibilityNeeds", "equipmentRequirements"]));
    expect(getEditDenial(access, row)).toBe("FORBIDDEN");
  });

  test("[SPM-243-TC-03] should_show_attendance_counts_but_no_organiser_or_participant_details", () => {
    const row = eventRow([round({ claimed_by: 31 })]);
    const view = eventModel.toEventView(row, OFFICER, getEventAccess(OFFICER, row));
    expect(view).toEqual(expect.objectContaining({ viewerRelationship: "SAFETY_OFFICER", status: "SAFETY_REVIEW", registeredCount: 3, arrangementVersion: 3, safetyReviewId: 7 }));
    expect(view).not.toHaveProperty("organiser");
    expect(view).not.toHaveProperty("coordinatorId");
    expect(view).not.toHaveProperty("safety_reviews");
    expect(view.permissions).toEqual(expect.objectContaining({ canEdit: false, canViewDraftHistory: false, canViewStaffHistory: true }));
  });

  test.each([
    ["the open round over one they decided", [round({ review_id: 5, status: "APPROVED", decided_by: 31 }), round({ review_id: 6 })], 6],
    ["their latest decided round", [round({ review_id: 5, status: "CHANGES_REQUESTED", decided_by: 31 }), round({ review_id: 8, status: "REJECTED", decided_by: 31 })], 8],
    ["none outside their scope", [round({ review_id: 9, claimed_by: 32 })], null],
  ])("[SPM-243-AC3] should_name_%s_as_the_review_to_open", (_label, rounds, expected) => {
    const row = eventRow(rounds);
    expect(eventModel.toEventView(row, OFFICER, { ...getEventAccess(OFFICER, eventRow([round()])) }).safetyReviewId).toBe(expected);
  });
});

describe("findVisibleEvent for a Safety Officer", () => {
  test("[SPM-243-TC-03] should_join_the_rounds_in_scope_and_count_only_registered_seats", async () => {
    const calls = [];
    const chain = new Proxy({}, {
      get: (_target, method) => method === "maybeSingle"
        ? async () => ({ data: null, error: null })
        : (...args) => { calls.push([method, ...args]); return chain; },
    });
    supabase.from.mockReturnValue(chain);

    await expect(eventModel.findVisibleEvent(42, OFFICER)).resolves.toBeNull();
    const select = calls.find(([method]) => method === "select")[1];
    expect(select).toContain("safety_reviews!inner(review_id,status,claimed_by,decided_by)");
    expect(select).toContain("registration(count)");
    expect(calls).toEqual(expect.arrayContaining([
      ["or", officerScopeFilter(31), { referencedTable: "safety_reviews" }],
      ["eq", "registration.registration_status", "REGISTERED"],
      ["neq", "status", "DRAFT"],
    ]));
  });
});

describe("findEventHistory narrowed to the review (AC2)", () => {
  test("should_keep_safety_entries_and_entries_that_changed_a_relevant_field", async () => {
    const calls = [];
    const chain = new Proxy({}, {
      get: (_target, method) => method === "limit"
        ? async () => ({ data: [], error: null })
        : (...args) => { calls.push([method, ...args]); return chain; },
    });
    supabase.from.mockReturnValue(chain);

    await activityModel.findEventHistory(42, { limit: 20, audiences: ["ORGANISER_SAFE"], fields: ["expectedAttendance", "venuePreferences"] });
    expect(calls).toEqual(expect.arrayContaining([
      ["or", "action.like.SAFETY_*,changes->expectedAttendance.not.is.null,changes->venuePreferences.not.is.null"],
    ]));
  });

  test("should_not_narrow_the_history_of_other_readers", async () => {
    const calls = [];
    const chain = new Proxy({}, {
      get: (_target, method) => method === "limit"
        ? async () => ({ data: [], error: null })
        : (...args) => { calls.push([method, ...args]); return chain; },
    });
    supabase.from.mockReturnValue(chain);

    await activityModel.findEventHistory(42, { limit: 20, audiences: ["ORGANISER_SAFE"] });
    expect(calls.some(([method]) => method === "or")).toBe(false);
  });
});
