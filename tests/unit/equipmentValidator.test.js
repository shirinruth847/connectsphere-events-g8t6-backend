// SPM-52 validation rules, no database.
const {
  validateEquipmentCreate,
  validateEquipmentUpdate,
  validateEquipmentStatusChange,
  validateUnavailabilityCreate,
  validateUnavailabilityUpdate,
  validateEquipmentListQuery,
  parseId,
  MESSAGES,
} = require("../../validators/equipmentValidator");

const projector = { name: "Laser Projector", category: "Visual", storageLocation: "Store Room B", totalQuantity: 4 };
const NOW = new Date("2026-11-01T00:00:00Z");
const period = { quantity: 3, reason: "DAMAGED", startsAt: "2026-11-02T09:00:00+08:00", endsAt: "2026-11-02T10:00:00+08:00", note: "Cracked lens" };

describe("SPM-52 create", () => {
  test("[TC-01] should_accept_a_complete_item_when_details_are_optional", () => {
    const { values, fields } = validateEquipmentCreate({ ...projector, specifications: " 4K, 5000 lm " });

    expect(fields).toEqual({});
    expect(values).toEqual({
      name: "Laser Projector",
      category: "Visual",
      storage_location: "Store Room B",
      total_quantity: 4,
      specifications: "4K, 5000 lm",
      technicalNotes: null,
      handlingNotes: null,
    });
  });

  test("[TC-02] should_name_each_missing_required_field_when_name_and_quantity_are_blank", () => {
    const { fields } = validateEquipmentCreate({ ...projector, name: " ", totalQuantity: "" });

    expect(fields).toEqual({ name: MESSAGES.nameRequired, totalQuantity: MESSAGES.totalQuantityRequired });
    expect(MESSAGES.nameRequired).toBe("Name is required");
    expect(MESSAGES.totalQuantityRequired).toBe("Total quantity is required");
  });

  test("[AC2] should_require_category_and_storage_location_when_they_are_missing", () => {
    const { fields } = validateEquipmentCreate({ name: "Mixer", totalQuantity: 1 });

    expect(fields).toEqual({ category: MESSAGES.categoryRequired, storageLocation: MESSAGES.storageLocationRequired });
  });

  test.each([-1, 1.5, "ten", "-1", "1.5"])("[TC-03] should_refuse_total_quantity_%p_when_it_is_not_a_whole_number_of_0_or_more", (value) => {
    const { fields } = validateEquipmentCreate({ ...projector, totalQuantity: value });

    expect(fields.totalQuantity).toBe("Total quantity must be a whole number of 0 or more");
  });

  test.each([0, 1, "0", "1"])("[TC-03] should_accept_total_quantity_%p_when_it_is_a_whole_number_of_0_or_more", (value) => {
    const { values, fields } = validateEquipmentCreate({ ...projector, totalQuantity: value });

    expect(fields).toEqual({});
    expect(values.total_quantity).toBe(Number(value));
  });

  test("[AC2] should_reject_server_controlled_fields_when_they_are_sent", () => {
    const { fields } = validateEquipmentCreate({ ...projector, isActive: true, version: 1, detailsPending: false });

    expect(fields).toEqual({ isActive: MESSAGES.unknownField, version: MESSAGES.unknownField, detailsPending: MESSAGES.unknownField });
  });

  test("[AC2] should_refuse_text_over_the_limits_when_fields_are_too_long", () => {
    const { fields } = validateEquipmentCreate({ ...projector, name: "x".repeat(101), handlingNotes: "y".repeat(2001) });

    expect(fields).toEqual({ name: MESSAGES.nameTooLong, handlingNotes: MESSAGES.detailTooLong });
  });
});

describe("SPM-52 update and status", () => {
  test("[AC6] should_check_only_the_fields_sent_when_editing", () => {
    const { values, fields, version } = validateEquipmentUpdate({ storageLocation: "Store Room C", version: "2" });

    expect(fields).toEqual({});
    expect(values).toEqual({ storage_location: "Store Room C" });
    expect(version).toBe(2);
  });

  test("[AC6] should_require_the_loaded_version_when_editing", () => {
    expect(validateEquipmentUpdate({ name: "Mixer" }).fields).toEqual({ version: MESSAGES.versionRequired });
  });

  test("[AC6] should_refuse_a_blank_required_field_but_allow_clearing_a_detail_field", () => {
    const { values, fields } = validateEquipmentUpdate({ category: "", specifications: "", version: 1 });

    expect(fields).toEqual({ category: MESSAGES.categoryRequired });
    expect(values.specifications).toBeNull();
  });

  test("[AC6] should_ask_for_a_change_when_only_the_version_is_sent", () => {
    expect(validateEquipmentUpdate({ version: 1 }).fields).toEqual({ body: MESSAGES.nothingToUpdate });
  });

  test("[AC9] should_need_a_boolean_active_and_the_version_when_changing_status", () => {
    expect(validateEquipmentStatusChange({ active: false, version: 3 })).toEqual({
      values: { active: false, version: 3, confirmUpcomingRequests: false },
      fields: {},
    });
    expect(validateEquipmentStatusChange({ active: "no", version: 3, confirmUpcomingRequests: "yes" }).fields).toEqual({
      active: MESSAGES.activeInvalid,
      confirmUpcomingRequests: MESSAGES.confirmInvalid,
    });
  });
});

describe("SPM-52 unavailable stock", () => {
  test("[AC8] should_store_instants_in_utc_when_a_period_is_valid", () => {
    const { values, fields } = validateUnavailabilityCreate(period, NOW);

    expect(fields).toEqual({});
    expect(values).toEqual({
      quantity: 3,
      reason: "DAMAGED",
      starts_at: "2026-11-02T01:00:00.000Z",
      ends_at: "2026-11-02T02:00:00.000Z",
      note: "Cracked lens",
    });
  });

  test("[TC-10] should_refuse_an_end_before_the_start", () => {
    const { fields } = validateUnavailabilityCreate({ ...period, endsAt: "2026-11-02T08:00:00+08:00" }, NOW);

    expect(fields).toEqual({ endsAt: MESSAGES.endBeforeStart });
  });

  test("[AC8] should_refuse_a_period_that_has_already_ended", () => {
    const { fields } = validateUnavailabilityCreate({ ...period, startsAt: "2026-10-01T09:00:00Z", endsAt: "2026-10-02T09:00:00Z" }, NOW);

    expect(fields).toEqual({ endsAt: MESSAGES.endInPast });
  });

  test.each([
    [{ quantity: 0 }, "quantity", MESSAGES.quantityInvalid],
    [{ quantity: "" }, "quantity", MESSAGES.quantityRequired],
    [{ reason: "LOST" }, "reason", MESSAGES.reasonInvalid],
    [{ note: " " }, "note", MESSAGES.noteRequired],
    [{ startsAt: "2026-11-02 09:00" }, "startsAt", MESSAGES.instantInvalid],
    [{ endsAt: "2026-11-02T10:00:00" }, "endsAt", MESSAGES.instantInvalid],
  ])("[AC8] should_refuse_%p_with_a_field_message", (change, field, message) => {
    expect(validateUnavailabilityCreate({ ...period, ...change }, NOW).fields).toEqual({ [field]: message });
  });

  test("[AC8] should_check_the_new_end_against_the_stored_start_when_editing_one_end", () => {
    const current = { starts_at: "2026-11-02T01:00:00+00:00", ends_at: "2026-11-02T02:00:00+00:00" };

    expect(validateUnavailabilityUpdate({ endsAt: "2026-11-02T00:30:00Z", version: 1 }, current, NOW).fields).toEqual({
      endsAt: MESSAGES.endBeforeStart,
    });
    expect(validateUnavailabilityUpdate({ note: "Lens replaced", version: 1 }, current, NOW).fields).toEqual({});
  });
});

describe("SPM-52 list query and ids", () => {
  test("[TC-16] should_keep_search_category_and_status_when_they_are_valid", () => {
    expect(validateEquipmentListQuery({ search: " MIC ", category: "Audio", status: "INACTIVE" })).toEqual({
      filters: { search: "MIC", category: "Audio", status: "INACTIVE" },
      fields: {},
    });
  });

  test("[TC-16] should_return_no_filters_when_they_are_cleared", () => {
    expect(validateEquipmentListQuery({ search: "", category: "", status: "" })).toEqual({ filters: {}, fields: {} });
  });

  test("[AC5] should_refuse_an_unknown_status_filter", () => {
    expect(validateEquipmentListQuery({ status: "BROKEN" }).fields).toEqual({ status: MESSAGES.statusInvalid });
  });

  test("[AC5] should_treat_impossible_ids_as_not_found", () => {
    expect(parseId("12")).toBe(12);
    ["0", "-1", "1.5", "abc", "99999999999"].forEach((value) => expect(parseId(value)).toBeNull());
  });
});
