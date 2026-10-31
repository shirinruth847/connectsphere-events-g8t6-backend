const venueModel = require("../model/venueModel");
const activityModel = require("../model/activityModel");
const {
  parseBookingFilters, parseBookingDecision,
  parseId,
  validateVenueBookingRequest,
  validateVenueBookingCheck,
  BOOKING_MESSAGES,
} = require("../validators/venueBookingValidator");
const { formatRequestId } = require("../model/eventModel");
const { EVENT_RELATIONSHIP, EVENT_TYPE_LABELS, HISTORY_AUDIENCE, VENUE_STAFF_HISTORY_FIELDS } = require("../config/eventConstants");
const { validateAvailabilityQuery, validateRequestAvailabilityQuery } = require("../validators/venueAvailabilityValidator");
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
const {
  validateHoldRequest,
  validateHoldDecline,
  validateHoldExtension,
  validateEmptyBody,
  parseHoldId,
  HOLD_MESSAGES,
} = require("../validators/venueHoldValidator");
const {
  validateBlockCreate,
  validateBlockChange,
  validateBlockLift,
  parseBlockId,
  BLOCK_MESSAGES,
} = require("../validators/venueBlockValidator");

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
  // Booking decisions (SPM-186, SPM-189): business conflicts the user can act on.
  EVENT_NOT_IN_PLANNING: [409, "Bookings can be approved only while the event is in planning."],
  EVENT_NOT_ACTIVE: [409, "This event is closed, so its bookings can no longer be changed."],
  VENUE_NOT_AVAILABLE: [409, "This venue is not available for bookings. Reject the request or make the venue active first."],
  VENUE_CAPACITY_EXCEEDED: [409, "The expected attendance is more than this venue's capacity."],
  VENUE_BUFFERS_NOT_SET: [409, "Set this venue's setup and turnaround times before approving bookings."],
  VENUE_BOOKING_CONFLICT: [409, "Another active booking already occupies this venue at that time, including its setup and turnaround."],
  VENUE_BLOCKED: [409, "The venue is blocked for part of this booking's time."],
  VENUE_HELD: [409, "The venue is held for another event during part of this booking's time."],
  VENUE_LOCK_TIMEOUT: [409, "Another change to this venue is in progress. Try again."],
  VENUE_BOOKINGS_UNAVAILABLE: [503, "Venue bookings cannot be decided right now. Try again shortly."],
  BOOKING_ALREADY_STARTED: [409, "This booking has already started, so it can no longer be rejected here. Coordinate changes on the day directly."],
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
  + "Confirm to continue; existing bookings and events are kept, and their coordinators and organisers are notified.";

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
      affectedEvents: error.affectedEvents || [],
    });
  }
  if (error.code === "BOOKING_NOT_FOUND") return res.status(404).json(BOOKING_NOT_FOUND);
  if (error.code === "BOOKING_ALREADY_DECIDED") {
    return sendError(res, 409, error.code, "This booking has already been actioned by another staff member. Reload it to see the decision.", {
      currentStatus: error.currentStatus,
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

const invalidCursor = (res) => validationFailed(res, { cursor: "Invalid page cursor." });

// GET /api/venues/bookings/:bookingId/availability (SPM-186): the booking's
// venue calendar over ?from&to, with the booking's own window as the checked
// period. The venue, window and excluded event come from the booking, never
// from the query.
const getBookingAvailability = async (req, res, next) => {
  const bookingId = parseId(req.params.bookingId);
  if (!bookingId) return res.status(404).json(BOOKING_NOT_FOUND);
  const extra = Object.keys(req.query).filter((key) => key !== "from" && key !== "to");
  const { query, fields } = validateAvailabilityQuery({ from: req.query.from, to: req.query.to });
  const allFields = { ...(fields || {}), ...Object.fromEntries(extra.map((key) => [key.slice(0, 60), "This parameter is not supported."])) };
  if (hasErrors(allFields)) return validationFailed(res, allFields);
  try {
    const result = await venueModel.findBookingAvailability(bookingId, query, req.user);
    if (!result) return res.status(404).json(BOOKING_NOT_FOUND);
    return res.status(200).json(result);
  } catch (err) {
    return handleError(err, res, next);
  }
};

// The venue-relevant part of an event's history (SPM-186, Master 4.2).
const getEventBookingHistory = async (req, res, next) => {
  try {
    const eventId = parseId(req.params.eventId);
    if (!eventId || !(await venueModel.hasReviewableBookings(eventId))) return res.status(404).json(EVENT_NOT_FOUND);
    const page = await activityModel.findEventHistory(eventId, {
      ...req.pagination,
      audiences: [HISTORY_AUDIENCE.ORGANISER_SAFE, HISTORY_AUDIENCE.STAFF_ONLY],
      fields: VENUE_STAFF_HISTORY_FIELDS,
      actionPattern: "VENUE_*",
    });
    return res.status(200).json(page);
  } catch (err) {
    if (err.code === "INVALID_CURSOR") return invalidCursor(res);
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

const getVenueHistory = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  try {
    return res.status(200).json(await venueModel.findVenueHistory(venueId, req.pagination));
  } catch (err) {
    if (err.code === "INVALID_CURSOR") return invalidCursor(res);
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
    const { venue, changed, upcomingBookings, affectedEvents } = await venueModel.setVenueStatus(req.user.user_id, venueId, values);
    return res.status(200).json({
      message: changed ? "Venue status updated." : "No changes to save.",
      venue,
      changed,
      upcomingBookings,
      affectedEvents,
    });
  } catch (err) {
    return handleError(err, res, next);
  }
};

// ---------- booking decisions (SPM-186, SPM-189, Venue Staff) ----------

const decideBooking = (decision) => async (req, res, next) => {
  const bookingId = parseId(req.params.bookingId);
  if (!bookingId) return res.status(404).json(BOOKING_NOT_FOUND);
  const { values, fields } = parseBookingDecision(req.body, decision);
  if (fields) return validationFailed(res, fields);
  try {
    const result = decision === "approve"
      ? await venueModel.approveVenueBooking(req.user.user_id, bookingId, values)
      : await venueModel.rejectVenueBooking(req.user.user_id, bookingId, values);
    return res.status(200).json({
      message: decision === "approve" ? "Venue booking approved." : "Venue booking rejected.",
      ...result,
    });
  } catch (err) {
    return handleError(err, res, next);
  }
};

const approveVenueBooking = decideBooking("approve");
const rejectVenueBooking = decideBooking("reject");

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

// GET /api/venues/options/:venueId/availability (SPM-76).
const getRequestVenueAvailability = async (req, res, next) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) return venueNotFound(res);
  const { query, fields } = validateRequestAvailabilityQuery(req.query);
  if (fields) return validationFailed(res, fields);
  try {
    return res.status(200).json(await venueModel.getRequestVenueAvailability(venueId, query, req.user));
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
  // SPM-188 AC9/AC10: confirming a hold as a booking. The form has no hold
  // field, so these are shown as the form's message rather than on a field.
  HOLD_NOT_FOUND: [404, "This hold could not be found for this event and venue.", null],
  HOLD_EXPIRED: [409, "This hold has expired, so it can no longer be confirmed. Request a booking instead.", null],
  HOLD_NOT_ACTIVE: [409, "This hold is no longer active, so it cannot be confirmed.", null],
  HOLD_ALREADY_CONVERTED: [409, "This hold has already been confirmed as a booking.", null],
  HOLD_WINDOW_CHANGED: [409, "A confirmed hold keeps its venue and times. Request a separate booking for a different time.", "start"],
  VENUE_CALENDAR_UNAVAILABLE: [503, "The hold could not be updated. Try again shortly.", null],
  // A rollback whose MongoDB undo failed: nothing may be promised (Master 7.4).
  VENUE_CALENDAR_OUTCOME_UNKNOWN: [503, "The hold's outcome could not be confirmed. Reload the event before trying again.", null],
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

// POST /api/events/:id/venue-bookings/check — SPM-186: the assigned coordinator
// sees each booking's checks for its own venue and window while preparing a
// request. Advisory: nothing is saved, and the request checks again under the
// venue lock.
const checkVenueBookings = async (req, res, next) => {
  const { event, eventId, access } = req.visibleEvent;
  if (!access.canRequestVenueBookings) {
    const code = access.relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR ? "EVENT_NOT_IN_PLANNING" : "FORBIDDEN";
    return sendError(res, BOOKING_REQUEST_ERRORS[code][0], code, BOOKING_REQUEST_ERRORS[code][1]);
  }
  const { items, fields } = validateVenueBookingCheck(req.body, { event });
  if (fields) return validationFailed(res, fields);
  try {
    return res.status(200).json({ bookings: await venueModel.checkVenueBookings(items, { eventId }) });
  } catch (err) {
    return next(err);
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

// ---------- operational blocks and restoration (SPM-195, Venue Staff) ----------

// [status, message]. The database re-checks the Venue Staff role in each write.
const BLOCK_ERRORS = Object.freeze({
  FORBIDDEN: [403, DOMAIN_ERRORS.FORBIDDEN[1]],
  VENUE_NOT_FOUND: [404, DOMAIN_ERRORS.VENUE_NOT_FOUND[1]],
  BLOCK_NOT_FOUND: [404, "Block not found."],
  INCIDENT_NOT_FOUND: [404, "Affected booking not found."],
  INVALID_VENUE_BLOCK: [400, "Please correct the highlighted fields."],
  IDEMPOTENCY_KEY_REUSED: [409, DOMAIN_ERRORS.IDEMPOTENCY_KEY_REUSED[1]],
  IDEMPOTENCY_IN_PROGRESS: [409, "This request is still being processed. Try again shortly."],
  VENUE_LOCK_TIMEOUT: [409, "Another change to this venue or event is in progress. Try again."],
  BLOCK_NOT_ACTIVE: [409, "This block has been lifted. Reload the venue."],
  BLOCK_CANNOT_BE_EXTENDED: [409, BLOCK_MESSAGES.extend],
  BLOCK_VERSION_CONFLICT: [409, "This block was changed after you loaded it. Reload it, then try again."],
  INCIDENT_STILL_BLOCKED: [409, "Part of this booking's time, including setup and turnaround, is still blocked."],
  INCIDENT_NOT_RESTORABLE: [409, "This booking can no longer be restored."],
  VENUE_OUT_OF_SERVICE: [409, "This venue is out of service, so the booking cannot be restored."],
  // Only the confirmed failure response may promise that nothing changed.
  VENUE_CALENDAR_OUTCOME_UNKNOWN: [503, "The venue calendar outcome could not be confirmed. Reload before taking another action; reconciliation may be required."],
  VENUE_CALENDAR_UNAVAILABLE: [503, "The venue calendar cannot be read or saved right now, so nothing was changed. Try again shortly."],
  VENUE_BOOKINGS_UNAVAILABLE: [503, "Venue blocks cannot be saved right now. Try again shortly."],
});

const handleBlockError = (error, res, next) => {
  if (error.name !== "VenueError" || !BLOCK_ERRORS[error.code]) return next(error);
  const [status, message] = BLOCK_ERRORS[error.code];
  const extra = {};
  if (error.code === "BLOCK_CANNOT_BE_EXTENDED") extra.fields = { end: message };
  if (error.blocks) extra.blocks = error.blocks;
  return sendError(res, status, error.code, message, extra);
};

const readVenueParam = (req, res) => {
  const venueId = parseVenueId(req.params.venueId);
  if (!venueId) venueNotFound(res);
  return venueId;
};

// GET /api/venues/:venueId/blocks — current and upcoming blocks with their
// affected bookings and holds.
const listVenueBlocks = async (req, res, next) => {
  const venueId = readVenueParam(req, res);
  if (!venueId) return undefined;
  try {
    return res.status(200).json(await venueModel.listVenueBlocks(venueId));
  } catch (err) {
    return handleBlockError(err, res, next);
  }
};

const blockRecordedMessage = (affected) => {
  if (!affected) return "Block recorded. No bookings or holds are affected.";
  const subject = affected === 1 ? "One booking or hold is" : `${affected} bookings or holds are`;
  return `Block recorded. ${subject} affected; their coordinators have been told.`;
};

// POST /api/venues/:venueId/blocks — body { reason, start, end, note } plus an
// Idempotency-Key header. 201 with the block and its incidents; 200 for a replay.
const createVenueBlock = async (req, res, next) => {
  const venueId = readVenueParam(req, res);
  if (!venueId) return undefined;
  const { block, fields } = validateBlockCreate(req.body);
  const allFields = { ...(fields || {}) };
  const idempotencyKey = readIdempotencyKey(req);
  if (!idempotencyKey) allFields.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
  if (hasErrors(allFields)) return validationFailed(res, allFields);

  try {
    const result = await venueModel.createVenueBlock({ actorId: req.user.user_id, venueId, block, idempotencyKey });
    return res.status(result.replayed ? 200 : 201).json({ message: blockRecordedMessage(result.incidents.length), ...result });
  } catch (err) {
    return handleBlockError(err, res, next);
  }
};

const readBlockParams = (req, res) => {
  const venueId = parseVenueId(req.params.venueId);
  const blockId = parseBlockId(req.params.blockId);
  if (!venueId) {
    venueNotFound(res);
    return null;
  }
  if (!blockId) {
    sendError(res, 404, "BLOCK_NOT_FOUND", BLOCK_ERRORS.BLOCK_NOT_FOUND[1]);
    return null;
  }
  return { venueId, blockId };
};

const sendBlockChange = (res, result, done) => res.status(200).json({
  message: result.changed ? done : "No change: the block already matches.",
  ...result,
});

// PUT /api/venues/:venueId/blocks/:blockId — body { start, end, version }.
// Only a shorter block is accepted (AC9).
const shortenVenueBlock = async (req, res, next) => {
  const params = readBlockParams(req, res);
  if (!params) return undefined;
  const { change, fields } = validateBlockChange(req.body);
  if (fields) return validationFailed(res, fields);
  try {
    const result = await venueModel.changeVenueBlock({ actorId: req.user.user_id, ...params, change });
    return sendBlockChange(res, result, "Block shortened.");
  } catch (err) {
    return handleBlockError(err, res, next);
  }
};

// POST /api/venues/:venueId/blocks/:blockId/lift — body { version }.
const liftVenueBlock = async (req, res, next) => {
  const params = readBlockParams(req, res);
  if (!params) return undefined;
  const { lift, fields } = validateBlockLift(req.body);
  if (fields) return validationFailed(res, fields);
  try {
    const result = await venueModel.changeVenueBlock({ actorId: req.user.user_id, ...params, lift });
    return sendBlockChange(res, result, "Block lifted.");
  } catch (err) {
    return handleBlockError(err, res, next);
  }
};

// POST /api/venues/incidents/:incidentId/restore — Idempotency-Key header.
// 200 with the resolved incident; a resolved incident is returned unchanged.
const restoreVenueIncident = async (req, res, next) => {
  const incidentId = parseId(req.params.incidentId);
  if (!incidentId) return sendError(res, 404, "INCIDENT_NOT_FOUND", BLOCK_ERRORS.INCIDENT_NOT_FOUND[1]);
  const idempotencyKey = readIdempotencyKey(req);
  if (!idempotencyKey) return validationFailed(res, { idempotencyKey: IDEMPOTENCY_KEY_MESSAGE });
  try {
    const result = await venueModel.restoreVenueIncident({ actorId: req.user.user_id, incidentId, idempotencyKey });
    return res.status(200).json({
      message: result.changed ? "Booking restored. The coordinator and organiser have been told." : "This booking was already restored.",
      ...result,
    });
  } catch (err) {
    return handleBlockError(err, res, next);
  }
};

// ---------- tentative holds (SPM-190) ----------

const HOLD_ERRORS = Object.freeze({
  HOLD_REQUEST_NOT_FOUND: [404, "Hold request not found."],
  HOLD_NOT_FOUND: [404, "Hold not found."],
  HOLD_REQUEST_EXISTS: [409, "This event already has a pending hold request for this venue."],
  HOLD_REQUEST_DECIDED: [409, "This hold request has already been actioned. Reload it to see the outcome."],
  HOLD_TOO_LATE: [409, "Setup starts within 24 hours, so no hold is possible. Ask the coordinator to submit a booking request instead."],
  HOLD_NOT_ACTIVE: [409, "This hold is no longer active. Reload it to see its status."],
  HOLD_EXPIRED: [409, "This hold has expired, so it can no longer be changed."],
  HOLD_ALREADY_EXTENDED: [409, "A hold can be extended only once."],
  VENUE_CAPACITY_EXCEEDED: [409, "The requested attendance exceeds this venue’s current capacity. Ask the coordinator to revise the request or choose another venue."],
  VENUE_NOT_BOOKABLE: [409, "This venue is out of service and takes no new holds."],
  INVALID_HOLD: [400, "The hold could not be read. Reload it and try again."],
  INVALID_HOLD_REQUEST: [400, "Please correct the highlighted fields."],
  IDEMPOTENCY_KEY_REQUIRED: [400, IDEMPOTENCY_KEY_MESSAGE],
  EVENT_NOT_FOUND: [404, "Event not found."],
  EVENT_NOT_IN_PLANNING: [409, "Holds can be requested only while the event is in Planning."],
  VENUE_BOOKING_CONFLICT: [409, "Another approved booking now overlaps this window, so the hold cannot be placed."],
  VENUE_HELD: [409, "Another active hold overlaps this window, so the hold cannot be placed."],
  VENUE_BLOCKED: [409, "The venue is blocked for part of this window, so the hold cannot be placed."],
  VENUE_BUFFERS_NOT_SET: [409, "Set this venue's setup and turnaround times before placing holds."],
});
const HOLD_FIELD_ERRORS = Object.freeze({
  HOLD_OUTSIDE_EVENT: ["start", HOLD_MESSAGES.outsideEvent],
  DECLINE_REASON_INVALID: ["reason", HOLD_MESSAGES.reason],
  HOLD_EXTENSION_TOO_LONG: ["days", "The hold must still end at least 24 hours before setup starts. Choose fewer days."],
});

const handleHoldError = (error, res, next) => {
  if (error?.name === "VenueError" && HOLD_FIELD_ERRORS[error.code]) {
    const [field, message] = HOLD_FIELD_ERRORS[error.code];
    return validationFailed(res, { [field]: message });
  }
  if (error?.name === "VenueError" && HOLD_ERRORS[error.code]) {
    const [status, message] = HOLD_ERRORS[error.code];
    return sendError(res, status, error.code, message, error.currentStatus ? { currentStatus: error.currentStatus } : undefined);
  }
  return handleBlockError(error, res, next);
};

const readHoldRequestId = (req, res) => {
  const requestId = parseId(req.params.requestId);
  if (!requestId) res.status(404).json({ error: HOLD_ERRORS.HOLD_REQUEST_NOT_FOUND[1], code: "HOLD_REQUEST_NOT_FOUND" });
  return requestId;
};

const readHoldIdParam = (req, res) => {
  const holdId = parseHoldId(req.params.holdId);
  if (!holdId) res.status(404).json({ error: HOLD_ERRORS.HOLD_NOT_FOUND[1], code: "HOLD_NOT_FOUND" });
  return holdId;
};

// POST /api/events/:id/venue-holds — the assigned coordinator asks Venue Staff
// for a hold on one venue for a window of the event (AC1).
const requestVenueHold = async (req, res, next) => {
  const { event, eventId, access } = req.visibleEvent;
  if (!access.canRequestVenueBookings) {
    const code = access.relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR ? "EVENT_NOT_IN_PLANNING" : "FORBIDDEN";
    return sendError(res, BOOKING_REQUEST_ERRORS[code][0], code, BOOKING_REQUEST_ERRORS[code][1]);
  }
  const { values, fields } = validateHoldRequest(req.body, { event });
  const allFields = { ...(fields || {}) };
  const idempotencyKey = readIdempotencyKey(req);
  if (!idempotencyKey) allFields.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
  if (hasErrors(allFields)) return validationFailed(res, allFields);
  try {
    const holdRequest = await venueModel.requestVenueHold({ actorId: req.user.user_id, eventId, values, idempotencyKey });
    return res.status(201).json({ message: "Hold requested. Venue Staff will place it or tell you why not.", holdRequest });
  } catch (err) {
    return handleHoldError(err, res, next);
  }
};

// GET /api/events/:id/venue-holds — the event's hold requests and holds, for
// its coordinator and supervising Lead.
const listEventHolds = async (req, res, next) => {
  try {
    return res.status(200).json({ holds: await venueModel.listEventHolds(req.visibleEvent.eventId) });
  } catch (err) {
    return next(err);
  }
};

const HOLD_REQUEST_STATUSES = new Set(["PENDING", "PLACED", "DECLINED", "WITHDRAWN"]);

// GET /api/venues/hold-requests — Venue Staff's hold requests, pending first.
const listHoldRequests = async (req, res, next) => {
  const extra = Object.keys(req.query).filter((key) => key !== "status");
  const status = req.query.status;
  const fields = Object.fromEntries(extra.map((key) => [key.slice(0, 60), HOLD_MESSAGES.unknown]));
  if (status !== undefined && !HOLD_REQUEST_STATUSES.has(status)) fields.status = "Choose PENDING, PLACED, DECLINED or WITHDRAWN.";
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    return res.status(200).json(await venueModel.listHoldRequests({ status: status ?? null }));
  } catch (err) {
    return handleHoldError(err, res, next);
  }
};

// POST /api/venues/hold-requests/:requestId/place (AC1–AC4)
const placeVenueHold = async (req, res, next) => {
  const requestId = readHoldRequestId(req, res);
  if (!requestId) return undefined;
  const allFields = { ...(validateEmptyBody(req.body).fields || {}) };
  const idempotencyKey = readIdempotencyKey(req);
  if (!idempotencyKey) allFields.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
  if (hasErrors(allFields)) return validationFailed(res, allFields);
  try {
    const holdRequest = await venueModel.placeVenueHold({ actorId: req.user.user_id, requestId, idempotencyKey });
    return res.status(200).json({ message: "Hold placed. The coordinator has been told when it expires.", holdRequest });
  } catch (err) {
    return handleHoldError(err, res, next);
  }
};

const declineHoldRequest = async (req, res, next) => {
  const requestId = readHoldRequestId(req, res);
  if (!requestId) return undefined;
  const { values, fields } = validateHoldDecline(req.body);
  if (fields) return validationFailed(res, fields);
  try {
    const holdRequest = await venueModel.declineVenueHoldRequest({ actorId: req.user.user_id, requestId, reason: values.reason });
    return res.status(200).json({ message: "Hold request declined. The coordinator has the reason.", holdRequest });
  } catch (err) {
    return handleHoldError(err, res, next);
  }
};

const withdrawHoldRequest = async (req, res, next) => {
  const requestId = readHoldRequestId(req, res);
  if (!requestId) return undefined;
  const { fields } = validateEmptyBody(req.body);
  if (fields) return validationFailed(res, fields);
  try {
    const holdRequest = await venueModel.withdrawVenueHoldRequest({ actorId: req.user.user_id, requestId });
    return res.status(200).json({ message: "Hold request withdrawn.", holdRequest });
  } catch (err) {
    return handleHoldError(err, res, next);
  }
};

// POST /api/venues/holds/:holdId/extend (AC6): once, by 1–7 days.
const extendVenueHold = async (req, res, next) => {
  const holdId = readHoldIdParam(req, res);
  if (!holdId) return undefined;
  const { values, fields } = validateHoldExtension(req.body);
  if (fields) return validationFailed(res, fields);
  try {
    const holdRequest = await venueModel.extendVenueHold({ actorId: req.user.user_id, holdId, days: values.days });
    return res.status(200).json({ message: "Hold extended. The coordinator has been told the new expiry.", holdRequest });
  } catch (err) {
    return handleHoldError(err, res, next);
  }
};

// POST /api/venues/holds/:holdId/release — Venue Staff, or the event's coordinator.
const releaseVenueHold = async (req, res, next) => {
  const holdId = readHoldIdParam(req, res);
  if (!holdId) return undefined;
  const { fields } = validateEmptyBody(req.body);
  if (fields) return validationFailed(res, fields);
  try {
    const holdRequest = await venueModel.releaseVenueHold({ actorId: req.user.user_id, holdId });
    return res.status(200).json({ message: "Hold released. The venue is free for that time again.", holdRequest });
  } catch (err) {
    return handleHoldError(err, res, next);
  }
};

module.exports = {
  requestVenueHold,
  listEventHolds,
  listHoldRequests,
  placeVenueHold,
  declineHoldRequest,
  withdrawHoldRequest,
  extendVenueHold,
  releaseVenueHold,
  listVenueBlocks,
  createVenueBlock,
  shortenVenueBlock,
  liftVenueBlock,
  restoreVenueIncident,
  requestVenueBookings,
  listEventVenueBookings,
  getEventVenueAvailability,
  getEventVenueOptions,
  getRequestVenueOptions,
  getRequestVenueAvailability,
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
  approveVenueBooking,
  rejectVenueBooking,
  updateVenueDetails,
  getVenueAvailability,
  listVenueBookings,
  getVenueBooking,
  getEventVenueBookings,
  getEventBookingHistory,
  checkVenueBookings,
  getVenueHistory,
  getBookingAvailability,
};
