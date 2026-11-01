// Shared in-memory PostgreSQL setup for the SPM-163 waitlist and SPM-147
// withdrawal database tests. No hosted database, Auth or network.
//
// The migrations under test run whole, on top of SPM-134's
// register_for_event and event_registration_availability, which the last
// migration rebuilds so that open offers hold their places. Most tests seed
// REGISTERED places directly (register); registerDirect calls SPM-134.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8");
const functionSql = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, `Function ${name} must exist in its source migration`);
  return match[0];
};

const ORGANISER = 1;
const [A, B, C, D, E] = [2, 3, 4, 5, 6];
const INACTIVE = 7;
const REQUEST_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

let db;
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const rows = async (sql, values = []) => (await db.query(sql, values)).rows;

// Registration opens a day ago and closes at the start unless closesIn is
// given. capacity is the organiser's cap; venueCapacity books a primary venue
// of that size (null: no venue, so no places).
const createEvent = async ({
  capacity = 1,
  venueCapacity = 1000,
  startsIn = "7 days",
  opensIn = "-1 day",
  closesIn = null,
  status = "CONFIRMED",
  title = "Synthetic Gala",
} = {}) => {
  const { event_id: eventId } = await one(
    `INSERT INTO public.event (organiser_id, title, status, is_published, registration_capacity, start_datetime, end_datetime,
       registration_open_at, registration_close_at)
     VALUES ($1, $2, $3, true, $4, now() + $5::interval, now() + $5::interval + interval '2 hours',
             now() + $6::interval, now() + COALESCE($7::interval, $5::interval))
     RETURNING event_id`,
    [ORGANISER, title, status, capacity, startsIn, opensIn, closesIn]
  );
  if (venueCapacity !== null) await bookVenue(eventId, venueCapacity);
  return eventId;
};

const bookVenue = async (eventId, capacity) => {
  const { venue_id: venueId } = await one(
    "INSERT INTO public.venue (name, address, max_capacity) VALUES ('Synthetic Hall', '1 Test Street', $1) RETURNING venue_id",
    [capacity]
  );
  const { room_id: roomId } = await one(
    "INSERT INTO public.room (venue_id, layout_type, capacity) VALUES ($1, 'THEATRE', $2) RETURNING room_id",
    [venueId, capacity]
  );
  await db.query(
    `INSERT INTO public.venue_booking (event_id, room_id, status, start_datetime, end_datetime)
     SELECT event_id, $2, 'APPROVED', start_datetime, end_datetime FROM public.event WHERE event_id = $1`,
    [eventId, roomId]
  );
};
const setVenueCapacity = (eventId, capacity) =>
  db.query(
    `UPDATE public.venue SET max_capacity = $2
      WHERE venue_id IN (SELECT r.venue_id FROM public.venue_booking AS b JOIN public.room AS r USING (room_id) WHERE b.event_id = $1)`,
    [eventId, capacity]
  );

// Seeds a REGISTERED place, as if registered three days ago.
const register = async (attendeeId, eventId) =>
  (await one(
    `INSERT INTO public.registration (attendee_id, event_id, registration_status, registration_datetime)
     VALUES ($1, $2, 'REGISTERED', now() - interval '3 days') RETURNING registration_id`,
    [attendeeId, eventId]
  )).registration_id;

const registerDirect = async (attendeeId, eventId) =>
  (await one("SELECT public.register_for_event($1, $2, NULL, NULL) AS r", [attendeeId, eventId])).r;
const availabilityOf = async (eventId) =>
  (await one("SELECT public.event_registration_availability(e) AS a FROM public.event AS e WHERE e.event_id = $1", [eventId])).a;
const join = async (attendeeId, eventId, key = null, hash = REQUEST_HASH) =>
  (await one("SELECT public.join_event_waitlist($1, $2, NULL, NULL, $3, $4) AS r", [attendeeId, eventId, key, key ? hash : null])).r;
const leave = async (attendeeId, eventId) => (await one("SELECT public.leave_event_waitlist($1, $2) AS r", [attendeeId, eventId])).r;
const accept = async (attendeeId, eventId, offerId) =>
  (await one("SELECT public.accept_waitlist_offer($1, $2, $3) AS r", [attendeeId, eventId, offerId])).r;
const decline = async (attendeeId, eventId, offerId) =>
  (await one("SELECT public.decline_waitlist_offer($1, $2, $3) AS r", [attendeeId, eventId, offerId])).r;
const withdraw = async (attendeeId, eventId, key = null, hash = REQUEST_HASH) =>
  (await one("SELECT public.withdraw_event_registration($1, $2, $3, $4) AS r", [attendeeId, eventId, key, key ? hash : null])).r;
const expireDue = async (limit = 50) => (await one("SELECT public.expire_due_waitlist_offers($1) AS n", [limit])).n;

const placeOf = (attendeeId, eventId) =>
  one("SELECT * FROM public.registration WHERE attendee_id = $1 AND event_id = $2", [attendeeId, eventId]);
const positionOf = async (attendeeId, eventId) =>
  (await rows("SELECT * FROM public.list_waitlist_positions($1)", [attendeeId])).find((row) => row.event_id === eventId);
const offersFor = (eventId) =>
  rows(
    `SELECT o.*, r.attendee_id FROM public.waitlist_offer AS o
       JOIN public.registration AS r USING (registration_id)
      WHERE r.event_id = $1 ORDER BY o.offer_id`,
    [eventId]
  );
const openOfferOf = async (attendeeId, eventId) =>
  (await offersFor(eventId)).find((offer) => offer.attendee_id === attendeeId && offer.state === "OPEN");
const makeOverdue = (offerId) =>
  db.query("UPDATE public.waitlist_offer SET offered_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE offer_id = $1", [offerId]);
const noticesFor = (userId, eventId) =>
  rows(
    `SELECT n.* FROM public.notification AS n JOIN public.notification_recipient AS nr USING (notification_id)
      WHERE nr.recipient_id = $1 AND n.event_id = $2 ORDER BY n.notification_id`,
    [userId, eventId]
  );
const visible = async (userId, role, eventId, type) =>
  (await one("SELECT public._notification_visible($1, $2, $3, $4) AS v", [userId, role, eventId, type])).v;

// A full one-place event with A registered and the given attendees queued in order.
const fullEventWithQueue = async (queue, options = {}) => {
  const eventId = await createEvent(options);
  await register(A, eventId);
  for (const attendeeId of queue) await join(attendeeId, eventId);
  return eventId;
};


const openWaitlistDatabase = async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm163DatabaseSchema.sql"), "utf8"));
  await db.exec(`INSERT INTO public."user" (user_id, email, name, role, is_active) VALUES
    (1, 'spm163-1@connectsphere.test', 'Organiser', 'ORGANISER', true),
    (2, 'spm163-2@connectsphere.test', 'Attendee A', 'ATTENDEE', true),
    (3, 'spm163-3@connectsphere.test', 'Attendee B', 'ATTENDEE', true),
    (4, 'spm163-4@connectsphere.test', 'Attendee C', 'ATTENDEE', true),
    (5, 'spm163-5@connectsphere.test', 'Attendee D', 'ATTENDEE', true),
    (6, 'spm163-6@connectsphere.test', 'Attendee E', 'ATTENDEE', true),
    (7, 'spm163-7@connectsphere.test', 'Inactive Attendee', 'ATTENDEE', true)`);

  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  const foundation = read("20261020161837_spm156_notification_foundation.sql");
  await db.exec(functionSql(idempotency, "_claim_idempotency_key") + functionSql(idempotency, "_store_idempotent_response"));
  await db.exec(functionSql(foundation, "_notify_event_users") + functionSql(foundation, "_notification_key_time"));
  await db.exec(functionSql(read("20261020161912_spm155_attendee_notifications.sql"), "_attendee_datetime_text"));
  // The primary venue as SPM-134's PGlite test reads it, and SPM-134's live rule.
  await db.exec(functionSql(read("20261020112025_spm173_interim_readiness.sql"), "_event_primary_venue"));
  const spm134 = read("20261030142619_spm134_window_and_venue_capacity.sql");
  await db.exec(functionSql(spm134, "event_registration_availability") + functionSql(spm134, "register_for_event"));
  for (const name of MIGRATIONS) await db.exec(read(name));
};

// Applied migrations, in order. Held ones are passed to applyMigration.
const MIGRATIONS = [
  "20261030170000_spm163_waitlist_notification_types.sql",
  "20261030170100_spm163_waitlist_offers.sql",
  "20261030170200_spm147_withdraw_registration.sql",
  "20261031030000_spm163_venue_capacity_places.sql",
  "20261031080611_spm163_offers_hold_places.sql",
  // Main's correction must follow the shared waitlist function replacements.
  "20261031100000_spm134_registration_deadline_clock.sql",
  "20261031130000_spm163_147_post_lock_deadlines.sql",
  // PREPARATION is attendee-facing like CONFIRMED; confirmation publishes.
  "20261031140000_attendee_lifecycle_preparation_publication.sql",
];
const applyMigration = (name) => db.exec(read(name));

module.exports = {
  openWaitlistDatabase,
  ORGANISER,
  A,
  B,
  C,
  D,
  E,
  INACTIVE,
  OTHER_HASH,
  one,
  rows,
  createEvent,
  setVenueCapacity,
  register,
  registerDirect,
  availabilityOf,
  applyMigration,
  join,
  leave,
  accept,
  decline,
  withdraw,
  expireDue,
  placeOf,
  positionOf,
  offersFor,
  openOfferOf,
  makeOverdue,
  noticesFor,
  visible,
  fullEventWithQueue,
  query: (sql, values = []) => db.query(sql, values),
};
