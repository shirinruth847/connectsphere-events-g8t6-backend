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
  hasErrors,
  MESSAGES,
} = require("../validators/venueValidator");
const { MAX_INTEGER } = require("../validators/eventValidator");

const BOOKING_NOT_FOUND = { error: "Venue booking not found.", code: "BOOKING_NOT_FOUND" };
const EVENT_NOT_FOUND = { error: "Event not found.", code: "EVENT_NOT_FOUND" };

const DOMAIN_ERRORS = Object.freeze({
  // Same response as requireRole: the database re-checks the role in the write.
  FORBIDDEN: [403, "You do not have permission to access this resource."],
  VENUE_NOT_FOUND: [404, "Venue not found."],
  VENUE_VERSION_CONFLICT: [409, "This venue was changed after you loaded it. Reload it, then try again."],
  VENUE_DETAILS_VERSION_CONFLICT: [409, "These venue details were changed after you loaded them. Reload them, then try again."],
  VENUE_DETAILS_UNAVAILABLE: [503, "Venue details cannot be read or saved right now. Try again shortly."],
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

module.exports = {
  getVenueCatalogue,
  listManagedVenues,
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
