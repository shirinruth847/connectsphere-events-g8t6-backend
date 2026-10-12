// Unit tests for the SPM-33 access policy in middleware/authorize.js: who may see an
// event, which fields they may edit and which history audiences they may read.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn() }));

const eventModel = require("../../model/eventModel");
const { getEventRelationship, getEventAccess } = require("../../middleware/authorize");
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
