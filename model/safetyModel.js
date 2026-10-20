// Safety review rounds (Master 5.9, SPM-243): the queue, claims, hand-backs,
// checklist progress, the review panel, decisions, outcome views and
// supersession. Every state change runs in a database function that locks the
// round (and the event, when the event changes), so this file only reads, calls
// those functions and maps results. The Safety Officer's event scope lives in
// eventModel with the other viewers'.
const crypto = require("crypto");
const supabase = require("../config/supabase");
const eventModel = require("./eventModel");
const activityModel = require("./activityModel");
const venueDetailModel = require("./venueDetailModel");
const { toFieldErrors } = require("../validators/safetyValidator");
const { HISTORY_AUDIENCE, SAFETY_REVIEW_HISTORY_FIELDS } = require("../config/eventConstants");

const ACTIVE_BOOKING_STATUSES = ["PENDING", "APPROVED"];
const REQUESTED_EQUIPMENT_STATUSES = ["PENDING", "APPROVED", "PARTIALLY_FULFILLED"];
const PANEL_HISTORY_LIMIT = 50;
const QUEUE_LIMIT = 100;

const ROUND_SELECT =
  "review_id,event_id,round_number,arrangement_version,status,submitted_at,claimed_by,claimed_at,checklist,organiser_comment,internal_notes,requested_changes,decided_by,decided_at,superseded_at,safety_review_rejected_bookings(booking_id,reason)";
const QUEUE_SELECT =
  "review_id,round_number,submitted_at,claimed_at,event:event!inner(event_id,title,start_datetime,end_datetime,expected_attendance,venue_booking(status,room(venue(venue_id,name))))";

// ---------- errors ----------

const safetyError = (code, extra = {}) => Object.assign(new Error(code), { name: "SafetyReviewError", code }, extra);

const DOMAIN_CODES = new Set([
  "FORBIDDEN",
  "REVIEW_NOT_FOUND",
  "ROUND_NOT_CLAIMABLE",
  "ROUND_NOT_OPEN",
  "NOT_CLAIMANT",
  "ARRANGEMENTS_CHANGED",
  "TRANSITION_NOT_ALLOWED",
  "EVENT_NOT_FOUND",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
]);

const toSafetyError = (error) => {
  const message = error.message || "";
  if (message === "INVALID_SAFETY_REVIEW") return safetyError("VALIDATION_FAILED", { fields: toFieldErrors(error.details) });
  if (message === "SAFETY_FACTOR_NOT_SATISFACTORY") {
    return safetyError(message, { factors: String(error.details || "").split(",").filter(Boolean) });
  }
  if (DOMAIN_CODES.has(message)) return safetyError(message, error.details ? { currentStatus: error.details } : {});
  return new Error(`[Supabase Error] ${message}`);
};

const dbError = (error) => new Error(`[Supabase Error] ${error.message}`);

const callSafetyRpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw toSafetyError(error);
  if (!data) throw new Error(`${name} returned nothing.`);
  return data;
};

// ---------- output mapping ----------

const toRejectedBookings = (row) =>
  (row.safety_review_rejected_bookings || [])
    .map((item) => ({ bookingId: item.booking_id, reason: item.reason }))
    .sort((left, right) => left.bookingId - right.bookingId);

// Everything on the round: for the claimant, the coordinator and other Safety Officers.
const toRound = (row) => ({
  reviewId: row.review_id,
  eventId: row.event_id,
  roundNumber: row.round_number,
  status: row.status,
  arrangementVersion: row.arrangement_version,
  submittedAt: row.submitted_at,
  claimedBy: row.claimed_by ?? null,
  claimedAt: row.claimed_at ?? null,
  checklist: row.checklist ?? null,
  organiserComment: row.organiser_comment ?? null,
  internalNotes: row.internal_notes ?? null,
  requestedChanges: row.requested_changes ?? null,
  rejectedBookings: toRejectedBookings(row),
  decidedBy: row.decided_by ?? null,
  decidedAt: row.decided_at ?? null,
  supersededAt: row.superseded_at ?? null,
});

// SPM-243 AC15: what each other role sees of a round. The organiser never gets
// the checklist or internal notes; Leads and Technical Support see the outcome;
// Venue Staff also see which of their own bookings were rejected and why.
const OUTCOME_SHAPES = Object.freeze({
  FULL: toRound,
  ORGANISER: (row) => ({
    roundNumber: row.round_number,
    status: row.status,
    decidedAt: row.decided_at ?? null,
    organiserComment: row.organiser_comment ?? null,
  }),
  OUTCOME: (row) => ({ roundNumber: row.round_number, status: row.status, decidedAt: row.decided_at ?? null }),
  VENUE_STAFF: (row, ownBookingIds) => ({
    roundNumber: row.round_number,
    status: row.status,
    decidedAt: row.decided_at ?? null,
    rejectedBookings: toRejectedBookings(row).filter((item) => ownBookingIds.includes(item.bookingId)),
  }),
});

const activeVenues = (bookings = []) => {
  const venues = new Map();
  for (const booking of bookings) {
    const venue = booking.room && booking.room.venue;
    if (ACTIVE_BOOKING_STATUSES.includes(booking.status) && venue) venues.set(venue.venue_id, venue.name);
  }
  return [...venues.values()];
};

const toQueueItem = (row) => ({
  reviewId: row.review_id,
  eventId: row.event.event_id,
  requestId: eventModel.formatRequestId(row.event.event_id),
  title: row.event.title,
  startDatetime: row.event.start_datetime,
  endDatetime: row.event.end_datetime,
  expectedAttendance: row.event.expected_attendance,
  venues: activeVenues(row.event.venue_booking),
  roundNumber: row.round_number,
  submittedAt: row.submitted_at,
  claimedAt: row.claimed_at ?? null,
});

// ---------- reads ----------

// AC3: open unclaimed rounds, oldest submission first.
const findQueue = async () => {
  const { data, error } = await supabase
    .from("safety_reviews")
    .select(QUEUE_SELECT)
    .eq("status", "OPEN")
    .is("claimed_by", null)
    .order("submitted_at", { ascending: true })
    .order("review_id", { ascending: true })
    .limit(QUEUE_LIMIT);
  if (error) throw dbError(error);
  return data.map(toQueueItem);
};

// AC3: rounds this officer holds and has not decided.
const findOfficerReviews = async (officerId) => {
  const { data, error } = await supabase
    .from("safety_reviews")
    .select(QUEUE_SELECT)
    .eq("status", "OPEN")
    .eq("claimed_by", officerId)
    .order("submitted_at", { ascending: true })
    .order("review_id", { ascending: true })
    .limit(QUEUE_LIMIT);
  if (error) throw dbError(error);
  return data.map(toQueueItem);
};

const findRound = async (reviewId) => {
  const { data, error } = await supabase.from("safety_reviews").select(ROUND_SELECT).eq("review_id", reviewId).maybeSingle();
  if (error) throw dbError(error);
  return data;
};

// The rounds of one event, in order.
const findEventRounds = async (eventId) => {
  const { data, error } = await supabase
    .from("safety_reviews")
    .select(ROUND_SELECT)
    .eq("event_id", eventId)
    .order("round_number", { ascending: true });
  if (error) throw dbError(error);
  return data;
};

const findActiveBookings = async (eventId) => {
  const { data, error } = await supabase
    .from("venue_booking")
    .select("booking_id,booking_reference,label,status,start_datetime,end_datetime,expected_attendance,layout_type,room(room_id,layout_type,capacity,venue(venue_id,name,address,max_capacity))")
    .eq("event_id", eventId)
    .in("status", ACTIVE_BOOKING_STATUSES)
    .order("booking_id", { ascending: true });
  if (error) throw dbError(error);
  return data;
};

const venueIdsOf = (bookings) => [...new Set(bookings.map((booking) => booking.room && booking.room.venue && booking.room.venue.venue_id).filter(Boolean))];

// AC11: the decision is refused when venue_details cannot be read.
const assertVenueDetailsReadable = async (eventId) => {
  const bookings = await findActiveBookings(eventId);
  try {
    await venueDetailModel.getVenueDetailsByIds(venueIdsOf(bookings));
  } catch {
    throw safetyError("VENUE_DETAILS_UNAVAILABLE");
  }
};

// The event a round belongs to, without any scope check: a decision by someone
// who is not the claimant is refused by the database as NOT_CLAIMANT (TC-17).
const findRoundEventId = async (reviewId) => {
  const { data, error } = await supabase.from("safety_reviews").select("event_id").eq("review_id", reviewId).maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw safetyError("REVIEW_NOT_FOUND");
  return data.event_id;
};

const toPanelBooking = (booking) => ({
  bookingId: booking.booking_id,
  bookingReference: booking.booking_reference ?? null,
  label: booking.label ?? null,
  status: booking.status,
  startDatetime: booking.start_datetime,
  endDatetime: booking.end_datetime,
  expectedAttendance: booking.expected_attendance ?? null,
  layoutType: booking.layout_type ?? (booking.room ? booking.room.layout_type : null),
  venue: booking.room && booking.room.venue
    ? {
        venueId: booking.room.venue.venue_id,
        name: booking.room.venue.name,
        address: booking.room.venue.address,
        capacity: booking.room.venue.max_capacity,
      }
    : null,
});

// SPM-248 (AC6): what the officer reviews. Venue safety detail comes from
// MongoDB; when it cannot be read the panel still loads and says so, and the
// decision is refused (AC11). No participant data is included.
const findReviewPanel = async (reviewId, officerId) => {
  const round = await findRound(reviewId);
  if (!round || !eventModel.isRoundInOfficerScope(round, officerId)) throw safetyError("REVIEW_NOT_FOUND");
  const eventId = round.event_id;

  const [eventResult, bookings, equipmentResult, rounds, history] = await Promise.all([
    supabase
      .from("event")
      .select("event_id,title,status,start_datetime,end_datetime,expected_attendance,accessibility_needs,preferred_layout_type,arrangement_version,registration(count)")
      .eq("event_id", eventId)
      .eq("registration.registration_status", "REGISTERED")
      .single(),
    findActiveBookings(eventId),
    supabase
      .from("equipment_request")
      .select("equip_request_id,quantity_requested,start_datetime,end_datetime,status,technical_notes,equipment(equipment_id,name,category)")
      .eq("event_id", eventId)
      .in("status", REQUESTED_EQUIPMENT_STATUSES)
      .order("equip_request_id", { ascending: true }),
    findEventRounds(eventId),
    activityModel.findEventHistory(eventId, {
      limit: PANEL_HISTORY_LIMIT,
      audiences: [HISTORY_AUDIENCE.ORGANISER_SAFE, HISTORY_AUDIENCE.STAFF_ONLY],
      fields: [...SAFETY_REVIEW_HISTORY_FIELDS],
    }),
  ]);
  if (eventResult.error) throw dbError(eventResult.error);
  if (equipmentResult.error) throw dbError(equipmentResult.error);
  const event = eventResult.data;

  const venueIds = venueIdsOf(bookings);
  let details = new Map();
  let venueDetailsAvailable = true;
  try {
    details = await venueDetailModel.getVenueDetailsByIds(venueIds);
  } catch {
    venueDetailsAvailable = false;
  }

  return {
    review: toRound(round),
    event: {
      eventId: event.event_id,
      requestId: eventModel.formatRequestId(event.event_id),
      title: event.title,
      status: event.status,
      startDatetime: event.start_datetime,
      endDatetime: event.end_datetime,
      expectedAttendance: event.expected_attendance,
      registeredCount: Array.isArray(event.registration) && event.registration[0] ? event.registration[0].count : 0,
      preferredLayoutType: event.preferred_layout_type,
      accessibilityNeeds: eventModel.parseAccessibility(event.accessibility_needs),
      arrangementVersion: event.arrangement_version,
    },
    bookings: bookings.map(toPanelBooking),
    // Placement is the technical notes until technical request lines exist (SPM-243 decision).
    equipment: equipmentResult.data.map((request) => ({
      requestId: request.equip_request_id,
      name: request.equipment ? request.equipment.name : null,
      category: request.equipment ? request.equipment.category : null,
      quantity: request.quantity_requested,
      startDatetime: request.start_datetime,
      endDatetime: request.end_datetime,
      status: request.status,
      placement: request.technical_notes ?? null,
    })),
    history: history.history,
    rounds: rounds.map(toRound),
    venueDetailsAvailable,
    venueDetails: venueDetailsAvailable
      ? venueIds.map((venueId) => {
          const document = details.get(String(venueId));
          return {
            venueId,
            found: Boolean(document),
            emergencyAccess: document ? document.emergencyAccess ?? null : null,
            knownRestrictions: document && Array.isArray(document.knownRestrictions) ? document.knownRestrictions : [],
          };
        })
      : [],
  };
};

// ---------- writes ----------

const claimReview = async ({ reviewId, actorId }) =>
  toRound(await callSafetyRpc("claim_safety_review", { p_review_id: reviewId, p_actor_id: actorId }));

const handBackReview = async ({ reviewId, actorId, note }) =>
  toRound(await callSafetyRpc("hand_back_safety_review", { p_review_id: reviewId, p_actor_id: actorId, p_note: note ?? null }));

const saveReviewProgress = async ({ reviewId, actorId, progress }) =>
  toRound(await callSafetyRpc("save_safety_review_progress", { p_review_id: reviewId, p_actor_id: actorId, p_progress: progress }));

const hashDecision = (reviewId, decision, arrangementVersion) =>
  crypto.createHash("sha256").update(JSON.stringify({ reviewId, decision, arrangementVersion })).digest("hex");

// SPM-249: the decision, superseded instead when the arrangements changed.
const decideReview = async ({ reviewId, actorId, decision, arrangementVersion, idempotencyKey }) => {
  const data = await callSafetyRpc("decide_safety_review", {
    p_review_id: reviewId,
    p_actor_id: actorId,
    p_decision: decision,
    p_expected_arrangement_version: arrangementVersion,
    p_idempotency_key: idempotencyKey,
    p_request_hash: idempotencyKey ? hashDecision(reviewId, decision, arrangementVersion) : null,
  });
  // The stored response has no embedded rejected bookings, so re-read the round.
  const round = await findRound(reviewId);
  return {
    superseded: data.superseded === true,
    replayed: data.replayed === true,
    review: toRound(round || data.review),
    event: data.event,
  };
};

// SPM-250: for backend code that changes an event's venue bookings, technical
// arrangements or expected attendance outside a database function. Inside a
// database function, call public._supersede_safety_review in the same transaction.
const recordArrangementChange = async ({ eventId, actorId = null, reason = null }) => {
  const { data, error } = await supabase.rpc("record_arrangement_change", { p_event_id: eventId, p_actor_id: actorId, p_reason: reason });
  if (error) throw toSafetyError(error);
  return data;
};

// ---------- outcome visibility (SPM-251) ----------

// Lead, Venue Staff and Technical Support have no event page yet; their scope for
// the safety outcome is: any submitted event (Lead), events where they reviewed a
// venue booking (Venue Staff) or an equipment request (Technical Support).
// Returns the shape to use and, for Venue Staff, their booking IDs; null when the
// event is outside their scope.
const findOutcomeScope = async (eventId, user) => {
  if (user.role === "COORDINATOR_LEAD") {
    const { data, error } = await supabase.from("event").select("event_id").eq("event_id", eventId).neq("status", "DRAFT").maybeSingle();
    if (error) throw dbError(error);
    return data ? { shape: "OUTCOME" } : null;
  }
  if (user.role === "VENUE_STAFF") {
    const { data, error } = await supabase.from("venue_booking").select("booking_id").eq("event_id", eventId).eq("reviewed_by", user.user_id);
    if (error) throw dbError(error);
    return data.length ? { shape: "VENUE_STAFF", ownBookingIds: data.map((row) => row.booking_id) } : null;
  }
  if (user.role === "TECH_SUPPORT") {
    const { data, error } = await supabase.from("equipment_request").select("equip_request_id").eq("event_id", eventId).eq("reviewed_by", user.user_id).limit(1);
    if (error) throw dbError(error);
    return data.length ? { shape: "OUTCOME" } : null;
  }
  return null;
};

const findEventOutcomes = async (eventId, { shape, ownBookingIds = [] }) => {
  const rounds = await findEventRounds(eventId);
  const toOutcome = OUTCOME_SHAPES[shape];
  return rounds.map((row) => toOutcome(row, ownBookingIds));
};

module.exports = {
  findQueue,
  findOfficerReviews,
  findReviewPanel,
  findRoundEventId,
  assertVenueDetailsReadable,
  claimReview,
  handBackReview,
  saveReviewProgress,
  decideReview,
  recordArrangementChange,
  findOutcomeScope,
  findEventOutcomes,
  toRound,
  OUTCOME_SHAPES,
};
