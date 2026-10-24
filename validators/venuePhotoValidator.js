// Venue photo gallery rules (T28, SPM-181). Pure; no database access.

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_PHOTOS_PER_VENUE = 20;
const MAX_CAPTION_LENGTH = 200;
const PHOTO_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
const EDIT_FIELDS = new Set(["caption", "position"]);

const MESSAGES = Object.freeze({
  imageMissing: "Send the image file as the request body.",
  imageTooLarge: "Images must be 2 MB or smaller.",
  imageType: "Upload a JPEG, PNG or WebP image.",
  captionInvalid: `Caption must be text of ${MAX_CAPTION_LENGTH} characters or fewer.`,
  positionInvalid: `Position must be a whole number from 0 to ${MAX_PHOTOS_PER_VENUE - 1}.`,
  unknownField: "This field cannot be set.",
  nothingToUpdate: "Change the caption or the position.",
});

const startsWith = (buffer, bytes, offset = 0) => bytes.every((byte, index) => buffer[offset + index] === byte);

// The type is read from the file's own bytes; the client's Content-Type is not trusted.
const detectImageType = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
};

// Returns { caption } or { fields }. A blank caption is stored as null.
const readCaption = (value, fields) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > MAX_CAPTION_LENGTH) {
    fields.caption = MESSAGES.captionInvalid;
    return null;
  }
  return value.trim() || null;
};

// Upload or replace: the raw body and an optional ?caption= (upload only).
const validatePhotoUpload = (body, query = {}) => {
  const fields = {};
  const caption = readCaption(Array.isArray(query.caption) ? 1 : query.caption, fields);
  if (!Buffer.isBuffer(body) || body.length === 0) return { fields: { image: MESSAGES.imageMissing } };
  if (body.length > MAX_PHOTO_BYTES) return { fields: { image: MESSAGES.imageTooLarge }, tooLarge: true };
  const contentType = detectImageType(body);
  if (!contentType) return { fields: { image: MESSAGES.imageType }, unsupported: true };
  if (Object.keys(fields).length) return { fields };
  return { upload: { contentType, data: body, size: body.length, caption } };
};

// Edit: caption and/or the new position in the gallery (0 is the cover).
const validatePhotoEdit = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { fields: { body: "Send the changes as a JSON object." } };
  const fields = {};
  for (const key of Object.keys(body)) {
    if (!EDIT_FIELDS.has(key)) fields[key] = MESSAGES.unknownField;
  }
  const changes = {};
  if (Object.prototype.hasOwnProperty.call(body, "caption")) changes.caption = readCaption(body.caption, fields);
  if (Object.prototype.hasOwnProperty.call(body, "position")) {
    const position = body.position;
    if (!Number.isInteger(position) || position < 0 || position >= MAX_PHOTOS_PER_VENUE) fields.position = MESSAGES.positionInvalid;
    else changes.position = position;
  }
  if (!Object.keys(changes).length && !Object.keys(fields).length) fields.body = MESSAGES.nothingToUpdate;
  return Object.keys(fields).length ? { fields } : { changes };
};

// MongoDB ObjectId text; anything else cannot exist and is "not found".
const parsePhotoId = (value) => (typeof value === "string" && /^[a-f0-9]{24}$/i.test(value) ? value.toLowerCase() : null);

module.exports = {
  detectImageType,
  validatePhotoUpload,
  validatePhotoEdit,
  parsePhotoId,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS_PER_VENUE,
  MAX_CAPTION_LENGTH,
  PHOTO_TYPES,
  MESSAGES,
};
