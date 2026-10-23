const {
  validateVenueCreate,
  validateVenueUpdate,
  validateVenueStatusChange,
  validateVenueListQuery,
  MESSAGES,
} = require("../../validators/venueValidator");
const { MAX_VENUE_CAPACITY } = require("../../config/venueConstants");

// SPM-73 TC-1 test data.
const marina = {
  name: "Marina Conference Hall",
  address: "10 Bayfront Avenue",
  maxCapacity: 500,
  contactPerson: "Alex Tan",
  contactEmail: "alex.tan@example.com",
  contactNumber: "+65 6123 4567",
  status: "ACTIVE",
};

describe("validateVenueCreate", () => {
  test("[SPM-73-TC1] should_accept_the_marina_conference_hall_and_return_column_values", () => {
    const { values, fields } = validateVenueCreate({ ...marina, name: "  Marina Conference Hall  ", contactEmail: "Alex.Tan@Example.com" });

    expect(fields).toEqual({});
    expect(values).toEqual({
      name: "Marina Conference Hall",
      address: "10 Bayfront Avenue",
      max_capacity: 500,
      contact_person: "Alex Tan",
      contact_email: "alex.tan@example.com",
      contact_number: "+65 6123 4567",
      status: "ACTIVE",
      status_reason: null,
    });
  });

  test("[SPM-73-AC6] should_save_a_new_venue_as_active_when_no_status_is_sent", () => {
    const { status, ...withoutStatus } = marina;
    expect(validateVenueCreate(withoutStatus).values.status).toBe("ACTIVE");
  });

  test("[SPM-73-TC2] should_require_venue_name_and_capacity_with_the_test_case_messages", () => {
    const { fields } = validateVenueCreate({ ...marina, name: "", maxCapacity: "" });

    expect(fields).toEqual({ name: "Venue name is required", maxCapacity: "Capacity is required" });
  });

  test("[SPM-73-AC3] should_require_every_mandatory_field", () => {
    const { fields } = validateVenueCreate({});

    expect(fields).toEqual({
      name: MESSAGES.nameRequired,
      address: MESSAGES.addressRequired,
      maxCapacity: MESSAGES.capacityRequired,
      contactPerson: MESSAGES.contactPersonRequired,
      contactNumber: MESSAGES.contactRequired,
    });
  });

  test.each([0, -10, 10.5, "10.5", "abc", "-10", true, [500]])(
    "[SPM-73-TC3] should_reject_capacity_%p_as_not_a_positive_whole_number",
    (maxCapacity) => {
      expect(validateVenueCreate({ ...marina, maxCapacity }).fields).toEqual({
        maxCapacity: "Capacity must be a positive whole number",
      });
    }
  );

  test.each([1, "1", MAX_VENUE_CAPACITY, String(MAX_VENUE_CAPACITY)])(
    "[SPM-73-TC4] should_accept_boundary_capacity_%p",
    (maxCapacity) => {
      const { values, fields } = validateVenueCreate({ ...marina, maxCapacity });
      expect(fields).toEqual({});
      expect(values.max_capacity).toBe(Number(maxCapacity));
    }
  );

  test("[SPM-73-TC4] should_reject_capacity_above_the_configured_maximum", () => {
    expect(validateVenueCreate({ ...marina, maxCapacity: MAX_VENUE_CAPACITY + 1 }).fields).toEqual({
      maxCapacity: `Capacity must be ${MAX_VENUE_CAPACITY.toLocaleString("en-US")} or fewer`,
    });
  });

  test("[SPM-73-AC3] should_accept_either_contact_method_alone", () => {
    expect(validateVenueCreate({ ...marina, contactEmail: undefined }).fields).toEqual({});
    expect(validateVenueCreate({ ...marina, contactNumber: "" }).fields).toEqual({});
  });

  test.each(["alex.tan", "alex@", "@example.com", "alex tan@example.com", "alex@example"])(
    "[SPM-73-AC11] should_reject_email_%p",
    (contactEmail) => {
      expect(validateVenueCreate({ ...marina, contactEmail }).fields).toEqual({ contactEmail: MESSAGES.emailInvalid });
    }
  );

  test.each(["12345", "phone", "+65 6123 4567 ext 2", "+1234567890123456", "65-6123-45x7"])(
    "[SPM-73-AC11] should_reject_contact_number_%p",
    (contactNumber) => {
      expect(validateVenueCreate({ ...marina, contactNumber }).fields).toEqual({ contactNumber: MESSAGES.numberInvalid });
    }
  );

  test.each(["+65 6123 4567", "6123 4567", "(65) 6123-4567", "+6561234567"])(
    "[SPM-73-AC11] should_accept_contact_number_%p",
    (contactNumber) => {
      expect(validateVenueCreate({ ...marina, contactNumber }).fields).toEqual({});
    }
  );

  test("[SPM-73-AC12] should_reject_text_longer_than_the_columns", () => {
    const { fields } = validateVenueCreate({ ...marina, name: "x".repeat(151), address: "x".repeat(256), contactPerson: "x".repeat(101) });

    expect(fields).toEqual({
      name: MESSAGES.nameTooLong,
      address: MESSAGES.addressTooLong,
      contactPerson: MESSAGES.contactPersonTooLong,
    });
  });

  test("should_reject_server_controlled_and_unknown_fields_instead_of_saving_them", () => {
    const { fields } = validateVenueCreate({ ...marina, created_by: 1, version: 9, is_active: false, venue_id: 7 });

    expect(fields).toEqual({
      created_by: MESSAGES.unknownField,
      version: MESSAGES.unknownField,
      is_active: MESSAGES.unknownField,
      venue_id: MESSAGES.unknownField,
    });
  });

  test.each([null, [], "text", 5])("should_reject_a_body_of_%p", (body) => {
    expect(validateVenueCreate(body).fields).toEqual({ body: MESSAGES.bodyInvalid });
  });

  test("[SPM-73-AC17] should_require_a_reason_for_creating_a_venue_under_maintenance", () => {
    expect(validateVenueCreate({ ...marina, status: "UNDER_MAINTENANCE" }).fields).toEqual({ statusReason: MESSAGES.reasonRequired });
    expect(validateVenueCreate({ ...marina, status: "Active" }).fields).toEqual({ status: MESSAGES.statusInvalid });
  });
});

describe("validateVenueUpdate", () => {
  const current = { contact_email: "alex.tan@example.com", contact_number: null };

  test("[SPM-73-TC6] should_return_only_the_changed_details_and_the_loaded_version", () => {
    const { values, fields, version } = validateVenueUpdate({ maxCapacity: "650", contactNumber: "+65 6000 0000", version: 3 }, current);

    expect(fields).toEqual({});
    expect(values).toEqual({ max_capacity: 650, contact_number: "+65 6000 0000" });
    expect(version).toBe(3);
  });

  test("should_require_the_loaded_version_and_at_least_one_detail", () => {
    expect(validateVenueUpdate({ maxCapacity: 10 }, current).fields).toEqual({ version: MESSAGES.versionRequired });
    expect(validateVenueUpdate({ version: 1 }, current).fields).toEqual({ body: MESSAGES.nothingToUpdate });
  });

  test("[SPM-73-AC8] should_apply_the_same_rules_to_edited_fields", () => {
    const { fields } = validateVenueUpdate({ name: " ", maxCapacity: 0, contactEmail: "nope", version: 1 }, current);

    expect(fields).toEqual({
      name: MESSAGES.nameRequired,
      maxCapacity: MESSAGES.capacityInvalid,
      contactEmail: MESSAGES.emailInvalid,
    });
  });

  test("[SPM-73-AC3] should_refuse_to_remove_the_last_contact_method", () => {
    expect(validateVenueUpdate({ contactEmail: "", version: 1 }, current).fields).toEqual({ contactNumber: MESSAGES.contactRequired });
    expect(validateVenueUpdate({ contactEmail: "", contactNumber: "6123 4567", version: 1 }, current).fields).toEqual({});
  });

  test("should_not_demand_contacts_for_an_older_venue_when_contacts_are_not_edited", () => {
    expect(validateVenueUpdate({ maxCapacity: 80, version: 1 }, { contact_email: null, contact_number: null }).fields).toEqual({});
  });

  test("should_send_status_changes_to_the_status_action", () => {
    expect(validateVenueUpdate({ status: "INACTIVE", version: 1 }, current).fields).toEqual({ status: MESSAGES.statusNotEditable });
  });
});

describe("validateVenueStatusChange", () => {
  test("[SPM-73-TC7] should_require_a_reason_for_under_maintenance", () => {
    expect(validateVenueStatusChange({ status: "UNDER_MAINTENANCE", version: 2 }).fields).toEqual({ reason: MESSAGES.reasonRequired });

    const { values, fields } = validateVenueStatusChange({ status: "UNDER_MAINTENANCE", reason: " Roof repair ", version: 2 });
    expect(fields).toEqual({});
    expect(values).toEqual({ status: "UNDER_MAINTENANCE", reason: "Roof repair", version: 2, confirmUpcomingBookings: false });
  });

  test("[SPM-73-TC8] should_pass_the_upcoming_booking_confirmation_through", () => {
    const { values, fields } = validateVenueStatusChange({ status: "INACTIVE", version: 2, confirmUpcomingBookings: true });

    expect(fields).toEqual({});
    expect(values).toEqual({ status: "INACTIVE", reason: null, version: 2, confirmUpcomingBookings: true });
  });

  test("[SPM-73-AC17] should_accept_only_the_three_statuses", () => {
    expect(validateVenueStatusChange({ status: "DELETED", version: 1 }).fields).toEqual({ status: MESSAGES.statusInvalid });
    expect(validateVenueStatusChange({ version: 1 }).fields).toEqual({ status: MESSAGES.statusRequired });
  });

  test("should_drop_the_reason_when_reactivating", () => {
    expect(validateVenueStatusChange({ status: "ACTIVE", reason: "Fixed", version: 4 }).values.reason).toBeNull();
  });

  test("should_reject_a_non_boolean_confirmation_and_unknown_fields", () => {
    expect(validateVenueStatusChange({ status: "INACTIVE", version: 1, confirmUpcomingBookings: "yes", force: true }).fields).toEqual({
      confirmUpcomingBookings: MESSAGES.confirmInvalid,
      force: MESSAGES.unknownField,
    });
  });
});

describe("validateVenueListQuery", () => {
  test("[SPM-73-TC11] should_pass_trimmed_search_location_and_status_filters", () => {
    expect(validateVenueListQuery({ search: " marina ", location: "Bayfront", status: "INACTIVE" })).toEqual({
      filters: { search: "marina", location: "Bayfront", status: "INACTIVE" },
      fields: {},
    });
  });

  test("[SPM-73-TC11] should_return_no_filters_when_they_are_cleared", () => {
    expect(validateVenueListQuery({ search: "", location: "  ", status: "" })).toEqual({ filters: {}, fields: {} });
  });

  test("should_reject_an_unknown_status_and_repeated_parameters", () => {
    expect(validateVenueListQuery({ status: "Gone", search: ["a", "b"] }).fields).toEqual({
      status: MESSAGES.statusInvalid,
      search: MESSAGES.textInvalid,
    });
  });
});
