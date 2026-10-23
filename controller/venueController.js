const venueModel = require("../model/venueModel");
const { parseBookingFilters, parseId } = require("../validators/venueBookingValidator");
const { validateAvailabilityQuery } = require("../validators/venueAvailabilityValidator");
const {
  validateVenueCreate,
  validateVenueUpdate,
  validateVenueStatusChange,
  validateVenueListQuery,
  validateVenueDetails,
  validateCatalogueQuery,
  validateVenueOptionsQuery,
  validateRequestVenueOptionsQuery,
  hasErrors,
  MESSAGES,
} = require("../validators/venueValidator");
const { MAX_INTEGER } = require("../validators/eventValidator");
const { readIdempotencyKey, IDEMPOTENCY_KEY_MESSAGE } = require("../middleware/validate");
const { validatePhotoUpload, validatePhotoEdit, parsePhotoId, PHOTO_TYPES } = require("../validators/venuePhotoValidator");

const BOOKING_NOT_FOUND = { error: "Venue booking not found.", code: "BOOKING_NOT_FOUND" };
const EVENT_NOT_FOUND = { error: "Event not found.", code: "EVENT_NOT_FOUND" };

const DOMAIN_ERRORS = Object.freeze({
  // Same response as requireRole: the database re-checks the role in the write.
  FORBIDDEN: [403, "You do not have permission to access this resource."],
  VENUE_NOT_FOUND: [404, "Venue not found."],
  VENUE_VERSION_CONFLICT: [409, "This venue was changed after you loaded it. Reload it, then try again."],
  VENUE_DETAILS_VERSION_CONFLICT: [409, "These venue details were changed after you loaded them. Reload them, then try again."],
  VENUE_DETAILS_UNAVAILABLE: [503, "Venue details cannot be read or saved right now. Try again shortly."],
  VENUE_PHOTOS_UNAVAILABLE: [503, "Venue photos cannot be loaded or saved right now. Try again shortly."],
  PHOTO_NOT_FOUND: [404, "Photo not found."],
  PHOTO_LIMIT_REACHED: [409, "This venue already has 20 photos. Delete one before adding another."],
  // Venue suggestion (SPM-72/74).
  EVENT_NOT_FOUND: [404, "Event request not found."],
  VENUE_SUGGESTION_NOT_ALLOWED_IN_STATUS: [409, "A venue can be suggested only while the event is under review or in planning."],
  VENUE_NOT_SELECTABLE: [409, "This venue is no longer available for new requests. Reload the venue list."],
  VENUE_CAPACITY_TOO_SMALL: [409, "This venue cannot hold the event's expected attendance."],
  VENUE_SUGGESTION_VERSION_CONFLICT: [409, "The suggested venue was changed after you loaded it. Reload the event, then try again."],
  IDEMPOTENCY_KEY_REUSED: [409, "This Idempotency-Key was already used for a different request."],
  // Never answer with partial availability (SPM-74 TC13, Master 7.4 step 5).
  AVAILABILITY_UNAVAILABLE: [503, "Venue availability cannot be loaded right now, so no venue is shown as available. Try again shortly."],
});

const BUFFER_LOCKED_MESSAGES = Object.freeze({
  setupMinutes: "Setup time has already been set and cannot be changed.",
  turnaroundMinutes: "Turnaround time has already been set and cannot be changed.",
});

const sendError = (res, status, code, error, extra) => res.status(status).json({ error, code, ...extra });

const validationFailed = (res, fields) =>
  sendError(res, 400, "VALIDATION_FAILED", "Please correct the highlighted fields.", { fields });

const upcomingBookingsWarning = (count) =>
  `This venue has ${count ?? "one or more"} upcoming booking${count === 1 ? "" : "s"}. `
  + "Confirm to continue; existing bookings are kept.";

const handleError = (error, res, next) => {
  if (error.name !== "VenueError") return next(error);
  if (error.code === "VALIDATION_FAILED") return validationFailed(res, error.fields || {});
  if (error.code === "VENUE_NAME_TAKEN") {
    return sendError(res, 409, error.code, MESSAGES.nameTaken, { fields: { name: MESSAGES.nameTaken } });
  }
  if (error.code === "VENUE_HAS_UPCOMING_BOOKINGS") {
    return sendError(res, 409, error.code, upcomingBookingsWarning(error.upcomingBookings), {
      upcomingBookings: error.upcomingBookings,
      firstStart: error.firstStart,
    });
  }
  if (error.code === "VENUE_BUFFERS_LOCKED") {
    const fields = Object.fromEntries(error.fields.map((field) => [field, BUFFER_LOCKED_MESSAGES[field]]));
    return sendError(res, 409, error.code, "Setup and turnaround times can be set only once and cannot be changed.", { fields });
  }
  const [status, message] = DOMAIN_ERRORS[error.code] || [];
  return status ? sendError(res, status, error.code, message) : next(error);
};

// IDs that cannot exist are "not found", like deleted venues.
const parseVenueId = (value) =>
  /^[1-9]\d{0,9}$/.test(value) && Number(value) <= MAX_INTEGER ? Number(value) : null;

const venueNotFound = (res) => sendError(res, 404, "VENUE_NOT_FOUND", DOMAIN_ERRORS.VENUE_NOT_FOUND[1]);

// ---------- catalogue (SPM-72) ----------

const getVenueCatalogue = async (req, res, next) => {
  const { filters, fields } = validateCatalogueQuery(req.query);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    return res.status(200).json(await venueModel.getVenueCatalogue(filters));
  } catch (err) {
    return next(err);
  }
};

// ---------- availability calendar (SPM-74, Coordinators and Venue Staff) ----------

const getVenueAvailability = async (req, res, next) => {
  const { query, fields } = validateAvailabilityQuery(req.query);
  if (fields) return validationFailed(res, fields);
  try {
    return res.status(200).json(await venueModel.getVenueAvailability(query, req.user));
  } catch (err) {
    return handleError(err, res, next);
  }
};

// ---------- booking review (SPM-181, Venue Staff) ----------

const listVenueBookings = async (req, res, next) => {
  try {
    const { filters, fields } = parseBookingFilters(req.query);
    if (fields) {
      return res.status(400).json({ error: "Please correct the highlighted filters.", code: "VALIDATION_FAILED", fields });
    }
    const result = await venueModel.findVenueBookings(filters);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};

// IDs that cannot exist are "not found", like IDs that do not.
const getVenueBooking = async (req, res, next) => {
  try {
    const bookingId = parseId(req.params.bookingId);
    const result = bookingId ? await venueModel.findVenueBooking(bookingId) : null;
    if (!result) return res.status(404).json(BOOKING_NOT_FOUND);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};

const getEventVenueBookings = async (req, res, next) => {
  try {
    const eventId = parseId(req.params.eventId);
    const result = eventId ? await venueModel.findEventBookings(eventId) : null;
    if (!result) return res.status(404).json(EVENT_NOT_FOUND);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};

// ---------- maintenance (SPM-73, Venue Staff) ----------

const listVenueOptions = async (req, res, next) => {
  try {
    return res.status(200).json(await venueModel.listVenueOptions());
  } catch (err) {
    return next(err);
  }
};

const listManagedVenues = async (req, res, next) => {
  const { filters, fields } = validateVenueListQuery(req.query);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    return res.status(200).json(await venueModel.listManagedVenues(filters, req.pagination));
  } catch (err) {
    return handleError(err, res, next);
  }
};

const getManagedVenue = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  try {
    const venue = await venueModel.getManagedVenue(venueId);
    // MongoDB details are added when readable; detailStatus says which (Master M4).
    const { details, detailStatus } = await venueModel.getManagedVenueDetails(venueId);
    return res.status(200).json({ venue, details, detailStatus });
  } catch (err) {
    return handleError(err, res, next);
  }
};

const updateVenueDetails = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  const { values, fields, version } = validateVenueDetails(req.body);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    const { details, changed } = await venueModel.updateVenueDetails(req.user.user_id, venueId, version, values);
    return res.status(200).json({ message: changed ? "Venue details updated." : "No changes to save.", details, changed });
  } catch (err) {
    return handleError(err, res, next);
  }
};

const createVenue = async (req, res, next) => {
  const { values, fields } = validateVenueCreate(req.body);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    const { venue } = await venueModel.createVenue(req.user.user_id, values);
    return res.status(201).json({ message: "Venue created.", venue });
  } catch (err) {
    return handleError(err, res, next);
  }
};

const updateVenue = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  try {
    // The current contact details decide whether a contact method remains.
    const current = await venueModel.findManagedVenueRow(venueId);
    if (!current) return venueNotFound(res);
    const { values, fields, version } = validateVenueUpdate(req.body, current);
    if (hasErrors(fields)) return validationFailed(res, fields);

    const { venue, changed } = await venueModel.updateVenue(req.user.user_id, venueId, version, values);
    return res.status(200).json({ message: changed ? "Venue updated." : "No changes to save.", venue, changed });
  } catch (err) {
    return handleError(err, res, next);
  }
};

const changeVenueStatus = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  const { values, fields } = validateVenueStatusChange(req.body);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    const { venue, changed, upcomingBookings } = await venueModel.setVenueStatus(req.user.user_id, venueId, values);
    return res.status(200).json({
      message: changed ? "Venue status updated." : "No changes to save.",
      venue,
      changed,
      upcomingBookings,
    });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// ---------- photo gallery (T28, SPM-181, Venue Staff) ----------

const photoNotFound = (res) => sendError(res, 404, "PHOTO_NOT_FOUND", DOMAIN_ERRORS.PHOTO_NOT_FOUND[1]);

// Upload and replace take the image as the raw body; anything else is refused
// before the bytes are read.
const readUpload = (req, res, query) => {
  if (!req.is(PHOTO_TYPES)) {
    sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "Upload a JPEG, PNG or WebP image.");
    return null;
  }
  const { upload, fields, tooLarge, unsupported } = validatePhotoUpload(req.body, query);
  if (tooLarge) sendError(res, 413, "PAYLOAD_TOO_LARGE", fields.image, { fields });
  else if (unsupported) sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", fields.image, { fields });
  else if (fields) validationFailed(res, fields);
  return upload || null;
};

const listVenuePhotos = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  try {
    return res.status(200).json(await venueModel.listVenuePhotos(venueId));
  } catch (err) {
    return handleError(err, res, next);
  }
};

const getVenuePhotoImage = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  const photoId = parsePhotoId(req.params.photoId);
  if (!photoId) return photoNotFound(res);
  try {
    const { contentType, data } = await venueModel.getVenuePhotoImage(venueId, photoId);
    res.set({ "Content-Type": contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-cache" });
    return res.status(200).send(data);
  } catch (err) {
    return handleError(err, res, next);
  }
};

const addVenuePhoto = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  const upload = readUpload(req, res, req.query);
  if (!upload) return undefined;
  try {
    const photo = await venueModel.addVenuePhoto(req.user.user_id, venueId, upload);
    return res.status(201).json({ message: "Photo added.", photo });
  } catch (err) {
    return handleError(err, res, next);
  }
};

const updateVenuePhoto = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  const photoId = parsePhotoId(req.params.photoId);
  if (!photoId) return photoNotFound(res);
  const { changes, fields } = validatePhotoEdit(req.body);
  if (fields) return validationFailed(res, fields);
  try {
    const photo = await venueModel.updateVenuePhoto(req.user.user_id, venueId, photoId, changes);
    return res.status(200).json({ message: "Photo updated.", photo });
  } catch (err) {
    return handleError(err, res, next);
  }
};

const replaceVenuePhotoImage = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  const photoId = parsePhotoId(req.params.photoId);
  if (!photoId) return photoNotFound(res);
  // A replacement keeps the caption, so ?caption= is ignored here.
  const upload = readUpload(req, res, {});
  if (!upload) return undefined;
  try {
    const photo = await venueModel.replaceVenuePhotoImage(req.user.user_id, venueId, photoId, upload);
    return res.status(200).json({ message: "Photo replaced.", photo });
  } catch (err) {
    return handleError(err, res, next);
  }
};

const deleteVenuePhoto = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  const photoId = parsePhotoId(req.params.photoId);
  if (!photoId) return photoNotFound(res);
  try {
    await venueModel.deleteVenuePhoto(req.user.user_id, venueId, photoId);
    return res.status(200).json({ message: "Photo deleted." });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// ---------- event venue options and suggestion (SPM-72/74) ----------
// requireVisibleEvent has already limited these to the assigned coordinator or
// the supervising Lead; anyone else was answered "not found".

const getEventVenueOptions = async (req, res, next) => {
  const { options, fields } = validateVenueOptionsQuery(req.query);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    const { event, access } = req.visibleEvent;
    const result = await venueModel.getEventVenueOptions(event, req.user, options);
    return res.status(200).json({ ...result, canSuggestVenue: access.canSuggestVenue });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// GET /api/venues/options (SPM-76): the organiser's form values come in the query.
const getRequestVenueOptions = async (req, res, next) => {
  const { need, options, fields } = validateRequestVenueOptionsQuery(req.query);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    return res.status(200).json(await venueModel.getRequestVenueOptions(need, req.user, options));
  } catch (err) {
    return handleError(err, res, next);
  }
};

const listSelectableVenuePhotos = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  try {
    return res.status(200).json(await venueModel.listSelectableVenuePhotos(venueId));
  } catch (err) {
    return handleError(err, res, next);
  }
};

const getSelectableVenuePhotoImage = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  const photoId = parsePhotoId(req.params.photoId);
  if (!photoId) return photoNotFound(res);
  try {
    const { contentType, data } = await venueModel.getSelectableVenuePhotoImage(venueId, photoId);
    res.set({ "Content-Type": contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-cache" });
    return res.status(200).send(data);
  } catch (err) {
    return handleError(err, res, next);
  }
};

const SUGGESTION_FIELDS = new Set(["venueId", "version"]);

// PUT /api/events/:id/venue-suggestion — body { venueId, version }, where version
// is the suggestion version the coordinator loaded (0 when there was none).
const suggestEventVenue = async (req, res, next) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  const fields = {};
  if (!body) {
    return validationFailed(res, { body: "Send a JSON object with venueId and version." });
  }
  for (const key of Object.keys(body)) {
    if (!SUGGESTION_FIELDS.has(key)) fields[key.slice(0, 60)] = "This field cannot be set.";
  }
  const venueId = Number.isInteger(body.venueId) && body.venueId > 0 && body.venueId <= MAX_INTEGER ? body.venueId : null;
  if (!venueId) fields.venueId = "Choose a venue.";
  const version = Number.isInteger(body.version) && body.version >= 0 && body.version <= MAX_INTEGER ? body.version : null;
  if (version === null) fields.version = "Send the suggestion version you loaded (0 when there was none).";
  const idempotencyKey = readIdempotencyKey(req);
  if (!idempotencyKey) fields.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
  if (hasErrors(fields)) return validationFailed(res, fields);

  try {
    const suggestion = await venueModel.suggestEventVenue({
      actorId: req.user.user_id,
      eventId: req.visibleEvent.eventId,
      venueId,
      expectedVersion: version,
      idempotencyKey,
    });
    return res.status(200).json({
      message: `${suggestion.name} was suggested to the organiser.`,
      suggestion,
    });
  } catch (err) {
    return handleError(err, res, next);
  }
};

module.exports = {
  getEventVenueOptions,
  getRequestVenueOptions,
  listSelectableVenuePhotos,
  getSelectableVenuePhotoImage,
  suggestEventVenue,
  listVenuePhotos,
  getVenuePhotoImage,
  addVenuePhoto,
  updateVenuePhoto,
  replaceVenuePhotoImage,
  deleteVenuePhoto,
  getVenueCatalogue,
  listManagedVenues,
  listVenueOptions,
  getManagedVenue,
  createVenue,
  updateVenue,
  changeVenueStatus,
  updateVenueDetails,
  getVenueAvailability,
  listVenueBookings,
  getVenueBooking,
  getEventVenueBookings,
};
