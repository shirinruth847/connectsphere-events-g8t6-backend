const {
  detectImageType,
  validatePhotoUpload,
  validatePhotoEdit,
  parsePhotoId,
  MAX_PHOTO_BYTES,
  MESSAGES,
} = require("../../validators/venuePhotoValidator");

// Smallest headers that identify each type, padded to the 12 bytes the check reads.
const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);

describe("detectImageType (T28)", () => {
  test("[TC-VENUE-181-90] should_read_jpeg_png_and_webp_from_the_file_bytes", () => {
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(WEBP)).toBe("image/webp");
  });

  test("[TC-VENUE-181-91] should_return_null_when_the_bytes_are_not_a_supported_image", () => {
    expect(detectImageType(pad([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF
    expect(detectImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageType("not a buffer")).toBeNull();
  });
});

describe("validatePhotoUpload (T28)", () => {
  test("[TC-VENUE-181-92] should_accept_an_image_with_a_trimmed_caption_and_take_the_type_from_the_bytes", () => {
    expect(validatePhotoUpload(PNG, { caption: "  Main hall  " })).toEqual({
      upload: { contentType: "image/png", data: PNG, size: PNG.length, caption: "Main hall" },
    });
  });

  test("[TC-VENUE-181-93] should_store_a_blank_caption_as_null_when_the_caption_is_whitespace", () => {
    expect(validatePhotoUpload(JPEG, { caption: "   " }).upload.caption).toBeNull();
    expect(validatePhotoUpload(JPEG).upload.caption).toBeNull();
  });

  test("[TC-VENUE-181-94] should_reject_a_missing_body_when_no_image_is_sent", () => {
    expect(validatePhotoUpload(undefined)).toEqual({ fields: { image: MESSAGES.imageMissing } });
    expect(validatePhotoUpload(Buffer.alloc(0))).toEqual({ fields: { image: MESSAGES.imageMissing } });
  });

  test("[TC-VENUE-181-95] should_flag_too_large_when_the_image_is_over_2_mb", () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_PHOTO_BYTES)]);
    expect(validatePhotoUpload(big)).toEqual({ fields: { image: MESSAGES.imageTooLarge }, tooLarge: true });
    const exact = Buffer.concat([JPEG, Buffer.alloc(MAX_PHOTO_BYTES - JPEG.length)]);
    expect(validatePhotoUpload(exact).upload.size).toBe(MAX_PHOTO_BYTES);
  });

  test("[TC-VENUE-181-96] should_flag_unsupported_when_the_bytes_are_not_an_image_whatever_the_header_said", () => {
    expect(validatePhotoUpload(Buffer.from("<html><script>alert(1)</script></html>"))).toEqual({
      fields: { image: MESSAGES.imageType },
      unsupported: true,
    });
  });

  test("[TC-VENUE-181-97] should_reject_a_caption_over_200_characters_or_repeated", () => {
    expect(validatePhotoUpload(JPEG, { caption: "x".repeat(201) }).fields).toEqual({ caption: MESSAGES.captionInvalid });
    expect(validatePhotoUpload(JPEG, { caption: ["a", "b"] }).fields).toEqual({ caption: MESSAGES.captionInvalid });
    expect(validatePhotoUpload(JPEG, { caption: "x".repeat(200) }).upload.caption).toHaveLength(200);
  });
});

describe("validatePhotoEdit (T28)", () => {
  test("[TC-VENUE-181-98] should_accept_a_caption_and_a_position_when_both_are_valid", () => {
    expect(validatePhotoEdit({ caption: " Stage ", position: 0 })).toEqual({ changes: { caption: "Stage", position: 0 } });
    expect(validatePhotoEdit({ caption: null })).toEqual({ changes: { caption: null } });
    expect(validatePhotoEdit({ position: 19 })).toEqual({ changes: { position: 19 } });
  });

  test("[TC-VENUE-181-99] should_reject_positions_outside_0_to_19_or_not_whole_numbers", () => {
    for (const position of [-1, 20, 1.5, "1", null]) {
      expect(validatePhotoEdit({ position }).fields).toEqual({ position: MESSAGES.positionInvalid });
    }
  });

  test("[TC-VENUE-181-100] should_reject_unknown_fields_and_empty_edits", () => {
    expect(validatePhotoEdit({ caption: "a", data: "x", venueId: "2" }).fields).toEqual({
      data: MESSAGES.unknownField,
      venueId: MESSAGES.unknownField,
    });
    expect(validatePhotoEdit({}).fields).toEqual({ body: MESSAGES.nothingToUpdate });
    expect(validatePhotoEdit([]).fields).toHaveProperty("body");
    expect(validatePhotoEdit(undefined).fields).toHaveProperty("body");
  });
});

describe("parsePhotoId (T28)", () => {
  test("[TC-VENUE-181-101] should_accept_only_24_hex_object_ids", () => {
    expect(parsePhotoId("65A1B2C3D4E5F60718293A4B")).toBe("65a1b2c3d4e5f60718293a4b");
    for (const value of ["1", "65a1b2c3d4e5f60718293a4", "zz".repeat(12), { $ne: null }, undefined]) {
      expect(parsePhotoId(value)).toBeNull();
    }
  });
});
