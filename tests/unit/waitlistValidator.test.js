// SPM-163 / SPM-147 request bodies: allowlisted fields only; the backend
// decides the attendee, position, offer state and deadline.
const { validateWaitlistJoin, validateOfferResponse, validateNoFields, MESSAGES } = require("../../validators/waitlistValidator");

describe("validateWaitlistJoin", () => {
  test("[SPM-163 AC1] keeps both answers, trimmed, with blanks stored as null", () => {
    expect(validateWaitlistJoin({ dietaryRestrictions: "  Vegetarian ", accessibilityRequirements: "   " })).toEqual({
      answers: { dietaryRestrictions: "Vegetarian", accessibilityRequirements: null },
    });
    expect(validateWaitlistJoin({ dietaryRestrictions: null, accessibilityRequirements: null })).toEqual({
      answers: { dietaryRestrictions: null, accessibilityRequirements: null },
    });
  });

  test("[SPM-163] requires both answers and refuses oversized, NUL or non-text values", () => {
    expect(validateWaitlistJoin({}).fields).toEqual({
      dietaryRestrictions: MESSAGES.textRequired,
      accessibilityRequirements: MESSAGES.textRequired,
    });
    expect(
      validateWaitlistJoin({ dietaryRestrictions: "x".repeat(1001), accessibilityRequirements: "a\u0000b" }).fields
    ).toEqual({ dietaryRestrictions: MESSAGES.textInvalid, accessibilityRequirements: MESSAGES.textInvalid });
    expect(validateWaitlistJoin({ dietaryRestrictions: 5, accessibilityRequirements: null }).fields).toEqual({
      dietaryRestrictions: MESSAGES.textInvalid,
    });
  });

  test("[SPM-163] refuses server-controlled fields and non-object bodies", () => {
    const { fields } = validateWaitlistJoin({
      dietaryRestrictions: null,
      accessibilityRequirements: null,
      attendeeId: 9,
      registrationStatus: "REGISTERED",
      queueOrder: 1,
    });
    expect(fields).toEqual({ attendeeId: MESSAGES.unknownField, registrationStatus: MESSAGES.unknownField, queueOrder: MESSAGES.unknownField });
    expect(validateWaitlistJoin(undefined).fields).toEqual({ body: MESSAGES.bodyInvalid });
    expect(validateWaitlistJoin([]).fields).toEqual({ body: MESSAGES.bodyInvalid });
  });
});

describe("validateOfferResponse", () => {
  test("[SPM-163 AC6/AC7] needs the positive whole offer ID", () => {
    expect(validateOfferResponse({ offerId: 12 })).toEqual({ offerId: 12 });
    for (const offerId of [0, -1, 1.5, "12", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateOfferResponse({ offerId }).fields).toEqual({ offerId: MESSAGES.offerIdInvalid });
    }
  });

  test("[SPM-163] refuses other fields and non-object bodies", () => {
    expect(validateOfferResponse({ offerId: 3, state: "ACCEPTED" }).fields).toEqual({ state: MESSAGES.unknownField });
    expect(validateOfferResponse("3").fields).toEqual({ body: MESSAGES.bodyInvalid });
  });
});

describe("validateNoFields", () => {
  test("[SPM-163 AC4][SPM-147 AC3] accepts no body or an empty object only", () => {
    expect(validateNoFields(undefined)).toEqual({});
    expect(validateNoFields({})).toEqual({});
    expect(validateNoFields({ reason: "busy" }).fields).toEqual({ reason: MESSAGES.unknownField });
    expect(validateNoFields(null).fields).toEqual({ body: MESSAGES.bodyInvalid });
  });
});
