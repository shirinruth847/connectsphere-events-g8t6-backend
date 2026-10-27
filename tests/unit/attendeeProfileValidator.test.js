// SPM-270 attendee profile save rules. Pure validation; no database or network.
const { validateProfileSave, MAX_PROFILE_TEXT_LENGTH, MESSAGES } = require("../../validators/attendeeProfileValidator");

const valid = (overrides = {}) => ({ dietaryRestrictions: "Vegetarian", accessibilityRequirements: "Step-free access", version: 1, ...overrides });

describe("validateProfileSave (SPM-270)", () => {
  test("[TC-PROFILE-006] should_accept_both_attendee_fields_and_the_loaded_version_when_input_is_valid", () => {
    expect(validateProfileSave(valid())).toEqual({
      profile: { dietaryRestrictions: "Vegetarian", accessibilityRequirements: "Step-free access", version: 1 },
    });
  });

  test("[TC-PROFILE-004] should_treat_the_save_as_a_first_create_when_version_is_null_or_absent", () => {
    expect(validateProfileSave(valid({ version: null })).profile.version).toBeNull();
    const { version, ...withoutVersion } = valid();
    expect(validateProfileSave(withoutVersion).profile.version).toBeNull();
  });

  test.each([[null], [""], ["   "], ["\t\n "], [" 　"]])(
    "[TC-PROFILE-008] should_store_null_when_a_field_is_blank_%p",
    (blank) => {
      const { profile } = validateProfileSave(valid({ dietaryRestrictions: blank, accessibilityRequirements: blank }));
      expect(profile.dietaryRestrictions).toBeNull();
      expect(profile.accessibilityRequirements).toBeNull();
    }
  );

  test("[TC-PROFILE-006] should_trim_surrounding_whitespace_when_text_is_saved", () => {
    expect(validateProfileSave(valid({ dietaryRestrictions: "  Halal  " })).profile.dietaryRestrictions).toBe("Halal");
  });

  test("[SPM-270-AC5] should_accept_text_at_the_limit_and_refuse_one_more_character_when_length_is_bounded", () => {
    expect(validateProfileSave(valid({ dietaryRestrictions: "x".repeat(MAX_PROFILE_TEXT_LENGTH) })).profile).toBeDefined();
    expect(validateProfileSave(valid({ accessibilityRequirements: "x".repeat(MAX_PROFILE_TEXT_LENGTH + 1) })).fields).toEqual({
      accessibilityRequirements: MESSAGES.textInvalid,
    });
  });

  test("[SPM-270-AC5] should_measure_the_limit_after_trimming_when_text_has_surrounding_spaces", () => {
    const padded = `  ${"x".repeat(MAX_PROFILE_TEXT_LENGTH)}  `;
    expect(validateProfileSave(valid({ dietaryRestrictions: padded })).profile.dietaryRestrictions).toHaveLength(MAX_PROFILE_TEXT_LENGTH);
  });

  // JavaScript counts UTF-16 units; PostgreSQL char_length counts characters, so
  // anything accepted here also fits the database CHECK (never a 500).
  test("[SPM-270-AC5] should_keep_within_the_database_limit_when_text_has_multi_unit_characters", () => {
    expect(validateProfileSave(valid({ dietaryRestrictions: "🌾".repeat(500) })).profile).toBeDefined();
    expect(validateProfileSave(valid({ dietaryRestrictions: "🌾".repeat(501) })).fields).toEqual({ dietaryRestrictions: MESSAGES.textInvalid });
  });

  test.each([[42], [true], [["Vegan"]], [{ text: "Vegan" }]])(
    "[TC-PROFILE-010] should_refuse_the_save_when_a_field_is_not_text_%p",
    (value) => {
      expect(validateProfileSave(valid({ dietaryRestrictions: value })).fields).toEqual({ dietaryRestrictions: MESSAGES.textInvalid });
    }
  );

  test("[TC-PROFILE-008] should_require_both_fields_when_a_save_omits_them_so_omission_never_clears_a_value", () => {
    expect(validateProfileSave({ version: 1 }).fields).toEqual({
      dietaryRestrictions: MESSAGES.textRequired,
      accessibilityRequirements: MESSAGES.textRequired,
    });
  });

  test.each([[0], [-1], [1.5], ["1"], [2147483648], [Number.NaN]])(
    "[TC-PROFILE-005] should_refuse_the_save_when_version_is_%p",
    (version) => {
      expect(validateProfileSave(valid({ version })).fields).toEqual({ version: MESSAGES.versionInvalid });
    }
  );

  test.each(["attendeeId", "userId", "user_id", "attendee_id", "role", "createdAt", "updatedAt", "name", "email", "phone", "notes"])(
    "[TC-PROFILE-009] should_refuse_the_save_when_the_body_sets_%s",
    (key) => {
      expect(validateProfileSave(valid({ [key]: 99 })).fields).toEqual({ [key]: MESSAGES.unknownField });
    }
  );

  test.each([[null], [[]], ["text"], [undefined]])("[TC-PROFILE-010] should_refuse_the_save_when_the_body_is_%p", (body) => {
    expect(validateProfileSave(body).fields).toEqual({ body: MESSAGES.bodyInvalid });
  });

  // PostgreSQL text cannot store U+0000; accepting it would turn bad input into a 500.
  test("[TC-PROFILE-010] should_refuse_the_save_when_text_contains_a_nul_character", () => {
    expect(validateProfileSave(valid({ dietaryRestrictions: "Vegan\u0000" })).fields).toEqual({ dietaryRestrictions: MESSAGES.textInvalid });
  });
});
