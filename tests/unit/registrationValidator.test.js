// SPM-134 registration answers. Pure validation; no database or network.
const { validateRegistration, MESSAGES } = require("../../validators/registrationValidator");

const valid = (overrides = {}) => ({ dietaryRestrictions: "Vegetarian, no peanuts", accessibilityRequirements: null, ...overrides });

describe("validateRegistration (SPM-134)", () => {
  test("[SPM-134] should_accept_both_answers_when_they_are_valid_text_or_null", () => {
    expect(validateRegistration(valid())).toEqual({
      answers: { dietaryRestrictions: "Vegetarian, no peanuts", accessibilityRequirements: null },
    });
  });

  test.each([[""], ["   "], [" 　"], [null]])("[SPM-134] should_store_null_when_an_answer_is_blank_%p", (blank) => {
    expect(validateRegistration(valid({ dietaryRestrictions: blank, accessibilityRequirements: blank })).answers).toEqual({
      dietaryRestrictions: null,
      accessibilityRequirements: null,
    });
  });

  test("[SPM-134] should_keep_unicode_text_and_trim_it_when_answers_are_saved", () => {
    expect(validateRegistration(valid({ dietaryRestrictions: "  素食 🌾, café  " })).answers.dietaryRestrictions).toBe("素食 🌾, café");
  });

  test("[SPM-134] should_accept_the_length_limit_and_refuse_one_more_character", () => {
    expect(validateRegistration(valid({ accessibilityRequirements: "x".repeat(1000) })).answers).toBeDefined();
    expect(validateRegistration(valid({ accessibilityRequirements: "x".repeat(1001) })).fields).toEqual({
      accessibilityRequirements: MESSAGES.textInvalid,
    });
  });

  test.each([["Vegan\u0000"], [42], [true], [["Vegan"]], [{ text: "Vegan" }]])(
    "[SPM-134] should_refuse_an_answer_that_cannot_be_stored_%p",
    (value) => {
      expect(validateRegistration(valid({ dietaryRestrictions: value })).fields).toEqual({ dietaryRestrictions: MESSAGES.textInvalid });
    }
  );

  test("[SPM-134] should_require_both_answers_when_the_body_omits_them", () => {
    expect(validateRegistration({}).fields).toEqual({
      dietaryRestrictions: MESSAGES.textRequired,
      accessibilityRequirements: MESSAGES.textRequired,
    });
  });

  test.each([
    "userId", "attendeeId", "attendee_id", "role", "email", "name", "phone", "status", "registrationStatus",
    "confirmationNumber", "registrationId", "capacity", "registrationCapacity", "registrationCloseAt", "eventId",
    "registeredAt", "responses",
  ])("[SPM-134] should_refuse_the_registration_when_the_body_sets_%s", (key) => {
    expect(validateRegistration(valid({ [key]: "x" })).fields).toEqual({ [key]: MESSAGES.unknownField });
  });

  test.each([[null], [[]], ["text"], [undefined]])("[SPM-134] should_refuse_the_registration_when_the_body_is_%p", (body) => {
    expect(validateRegistration(body).fields).toEqual({ body: MESSAGES.bodyInvalid });
  });
});
