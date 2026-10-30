const venueModel = require("../model/venueModel");
const {
  parseBookingFilters,
  parseId,
  validateVenueBookingRequest,
  BOOKING_MESSAGES,
} = require("../validators/venueBookingValidator");
const { formatRequestId } = require("../model/eventModel");
const { EVENT_RELATIONSHIP, EVENT_TYPE_LABELS } = require("../config/eventConstants");
const { validateAvailabilityQuery } = require("../validators/venueAvailabilityValidator");
const {
  validateVenueCreate,
  validateVenueUpdate,
  validateVenueStatusChange,
  validateVenueListQuery,
  validateVenueDetails,
  validateCatalogueQuery,
  validateVenueOptionsQuery,
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
  // Overlapping occupied ranges, refused by venue_booking_no_overlap (SPM-185 AC7).
  VENUE_BOOKING_CONFLICT: [409, "Another booking already occupies this venue at that time, including its setup and turnaround."],
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

// Event context is derived only after requireVisibleEvent verifies the actor.
const getEventVenueAvailability = async (req, res, next) => {
  const { query, fields } = validateAvailabilityQuery(req.query);
  if (fields) return validationFailed(res, fields);
  try {
    return res.status(200).json(await venueModel.getVenueAvailability(
      { ...query, excludeEventId: req.visibleEvent.eventId }, req.user
    ));
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

// ---------- venue booking requests (SPM-179) ----------
// requireVisibleEvent has answered "not found" to anyone outside the event's
// scope; these handlers then decide what a related user may do.

const SINGAPORE_TIME = new Intl.DateTimeFormat("en-SG", {
  timeZone: "Asia/Singapore", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
const formatPeriod = (start, end) => `${SINGAPORE_TIME.format(new Date(start))} to ${SINGAPORE_TIME.format(new Date(end))}`;
const CONFLICT_SOURCES = Object.freeze({ BOOKING: "another booking", HOLD: "a tentative hold", BLOCK: "an operational block" });

// [status, message or message builder, field shown in the venue section]
const BOOKING_REQUEST_ERRORS = Object.freeze({
  FORBIDDEN: [403, "Only the event's assigned coordinator can request venue bookings.", null],
  EVENT_NOT_FOUND: [404, "Event request not found.", null],
  EVENT_NOT_IN_PLANNING: [409, "Venue bookings can be requested only while the event is in planning.", null],
  IDEMPOTENCY_KEY_REUSED: [409, DOMAIN_ERRORS.IDEMPOTENCY_KEY_REUSED[1], null],
  IDEMPOTENCY_IN_PROGRESS: [409, "This request is still being processed. Try again shortly.", null],
  VENUE_LOCK_TIMEOUT: [409, "Another change to this event or venue is in progress. Try again.", null],
  INVALID_VENUE_BOOKING_REQUEST: [400, "Please correct the highlighted fields.", null],
  VENUE_LISTED_TWICE: [400, BOOKING_MESSAGES.venueTwice, "venueId"],
  VENUE_NOT_BOOKABLE: [409, "This venue is not available for booking.", "venueId"],
  VENUE_ALREADY_BOOKED_FOR_EVENT: [409, "This event already has a booking at this venue.", "venueId"],
  VENUE_BUFFERS_NOT_SET: [409, "This venue cannot take bookings until Venue Staff set its setup and turnaround times.", "venueId"],
  BOOKING_IN_PAST: [409, BOOKING_MESSAGES.startInPast, "start"],
  BOOKING_OUTSIDE_EVENT: [409, BOOKING_MESSAGES.outsideEvent, "start"],
  VENUE_CAPACITY_EXCEEDED: [409, (error) => (error.capacity != null
    ? `Expected attendance (${error.expectedAttendance}) exceeds this venue's capacity (${error.capacity}).`
    : "Expected attendance exceeds this venue's capacity."), "expectedAttendance"],
  BOOKING_CONFLICT: [409, (error) => {
    if (error.conflicts?.some((conflict) => conflict.message)) {
      return error.conflicts.map((conflict) => conflict.message
        || `This venue is unavailable from ${formatPeriod(conflict.occupiedStart, conflict.occupiedEnd)}, including setup and turnaround time.`).join(" ");
    }
    const periods = (error.conflicts || []).map((conflict) =>
      `${formatPeriod(conflict.occupiedStart, conflict.occupiedEnd)} (${CONFLICT_SOURCES[conflict.type] || "another arrangement"})`);
    return periods.length
      ? `This venue is unavailable from ${periods.join("; ")}, including setup and turnaround time.`
      : "This venue is unavailable at that time.";
  }, "start"],
  PRIMARY_VENUE_REQUIRED: [409, BOOKING_MESSAGES.onePrimary, null],
  PRIMARY_VENUE_ALREADY_SET: [409, "This event already has a primary venue. Add the new venues as additional venues.", null],
  AVAILABILITY_UNAVAILABLE: [503, "Availability could not be checked. Try again later.", null],
  VENUE_BOOKINGS_UNAVAILABLE: [503, "Venue bookings cannot be requested right now. Try again shortly.", null],
});

const handleBookingRequestError = (error, res, next) => {
  if (error.name !== "VenueError" || !BOOKING_REQUEST_ERRORS[error.code]) return next(error);
  const [status, message, field] = BOOKING_REQUEST_ERRORS[error.code];
  const text = typeof message === "function" ? message(error) : message;
  const extra = {};
  if (Number.isInteger(error.index)) {
    extra.bookingIndex = error.index;
    if (field) extra.fields = { [`bookings.${error.index}.${field}`]: text };
  } else if (error.code === "PRIMARY_VENUE_REQUIRED") {
    extra.fields = { "bookings.primary": text };
  }
  if (error.venueId != null) extra.venueId = error.venueId;
  if (error.conflicts) extra.conflicts = error.conflicts;
  return sendError(res, status, error.code, text, extra);
};

// POST /api/events/:id/venue-bookings — body { bookings: [...] } plus an
// Idempotency-Key header. 201 with the saved bookings; 200 for a replay.
const requestVenueBookings = async (req, res, next) => {
  const { event, eventId, access } = req.visibleEvent;
  if (!access.canRequestVenueBookings) {
    const code = access.relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR ? "EVENT_NOT_IN_PLANNING" : "FORBIDDEN";
    return sendError(res, BOOKING_REQUEST_ERRORS[code][0], code, BOOKING_REQUEST_ERRORS[code][1]);
  }

  const { bookings, fields } = validateVenueBookingRequest(req.body, { event });
  const allFields = { ...(fields || {}) };
  const idempotencyKey = readIdempotencyKey(req);
  if (!idempotencyKey) allFields.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
  if (hasErrors(allFields)) return validationFailed(res, allFields);

  try {
    const result = await venueModel.requestVenueBookings({
      actorId: req.user.user_id,
      eventId,
      bookings,
      idempotencyKey,
    });
    const count = result.bookings.length;
    return res.status(result.replayed ? 200 : 201).json({
      message: `${count === 1 ? "Venue booking" : `${count} venue bookings`} requested. Venue Staff will review ${count === 1 ? "it" : "them"}.`,
      ...result,
    });
  } catch (err) {
    return handleBookingRequestError(err, res, next);
  }
};

// GET /api/events/:id/venue-bookings — the assigned coordinator and the
// supervising Lead (read-only) see every booking of the event.
const listEventVenueBookings = async (req, res, next) => {
  try {
    const { event, eventId, access } = req.visibleEvent;
    const bookings = await venueModel.listEventVenueBookings(eventId);
    // The event view has no event type; the request form shows it read-only (AC2).
    const eventType = event.event_type ?? null;
    return res.status(200).json({
      eventId,
      requestId: formatRequestId(eventId),
      eventType,
      eventTypeLabel: eventType ? EVENT_TYPE_LABELS[eventType] || eventType : null,
      canRequestVenueBookings: access.canRequestVenueBookings === true,
      bookings,
    });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  requestVenueBookings,
  listEventVenueBookings,
  getEventVenueAvailability,
  getEventVenueOptions,
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
