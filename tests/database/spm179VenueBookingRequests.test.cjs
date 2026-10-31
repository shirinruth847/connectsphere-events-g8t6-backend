// SPM-179 venue booking requests (Master 1.6.2 sections 5.4, 5.4.1, 5.4.2, 6.2,
// 6.3, 7, 7.4, 8, T33) on in-memory PostgreSQL. No hosted database, Auth,
// MongoDB or network: the MongoDB setup/turnaround minutes are passed in as the
// backend would pass them. Holds, blocks and the venue lock connection are
// covered by the model unit tests and the live integration suite.
const { test, before } = require("node:test");
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

const OWNER = 1;
const COORDINATOR = 2;
const OTHER_COORDINATOR = 3;
const VENUE_STAFF = 4;
const VENUE_STAFF_TWO = 5;
const INACTIVE_VENUE_STAFF = 6;
const HALL = 10; // capacity 200, one room
const ANNEX = 11; // capacity 80, no room
const MAINTENANCE = 12;
const CLOSED = 13;
const MINUTES = {
  [HALL]: { setupMinutes: 30, turnaroundMinutes: 45 },
  [ANNEX]: { setupMinutes: 0, turnaroundMinutes: 0 },
  [MAINTENANCE]: { setupMinutes: 0, turnaroundMinutes: 0 },
  [CLOSED]: { setupMinutes: 0, turnaroundMinutes: 0 },
};

let db;
let legacy;
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const rows = async (sql, values = []) => (await db.query(sql, values)).rows;

let nextDay = 0;
// An event on its own future day, 09:00-17:00 UTC.
const createEvent = async ({ status = "PLANNING", coordinatorId = COORDINATOR } = {}) => {
  nextDay += 1;
  const day = new Date(Date.UTC(2030, 0, nextDay)).toISOString().slice(0, 10);
  const { event_id: eventId } = await one(
    `INSERT INTO public.event (organiser_id, coordinator_id, title, status, start_datetime, end_datetime, expected_attendance)
     VALUES ($1, $2, $3, $4, $5, $6, 100) RETURNING event_id`,
    [OWNER, coordinatorId, `spm179 event ${nextDay}`, status, `${day}T09:00:00Z`, `${day}T17:00:00Z`]
  );
  return { eventId, day, at: (time) => `${day}T${time}:00Z` };
};

const booking = (event, venueId, start, end, extra = {}) => ({
  venueId,
  label: `Venue ${venueId}`,
  start: event.at(start),
  end: event.at(end),
  expectedAttendance: 50,
  layout: "Theatre",
  ...extra,
});

let keyCounter = 0;
const newKey = () => `spm179-key-${String((keyCounter += 1)).padStart(4, "0")}`;
const hashOf = (text) => require("node:crypto").createHash("sha256").update(text).digest("hex");

// Both steps in one transaction, as the backend runs them on the lock connection.
const request = async (eventId, bookings, {
  actorId = COORDINATOR, key = newKey(), hash = hashOf(JSON.stringify(bookings)), minutes = MINUTES, warnings = [],
} = {}) =>
  db.transaction(async (tx) => {
    const venueIds = [...new Set(bookings.map((item) => item.venueId))];
    const started = (await tx.query(
      "SELECT public.begin_venue_booking_request($1, $2, $3::integer[], $4, $5) AS result",
      [actorId, eventId, venueIds, key, hash]
    )).rows[0].result;
    if (started.replay) return started.replay;
    return (await tx.query(
      "SELECT public.request_venue_bookings($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7) AS result",
      [actorId, eventId, JSON.stringify(bookings), JSON.stringify(minutes), JSON.stringify(warnings), key, hash]
    )).rows[0].result;
  });

const refused = async (promise, message) => {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.message, message);
    return error.detail ? JSON.parse(error.detail) : null;
  }
  throw new Error(`Expected ${message}`);
};

const bookingsOf = (eventId) =>
  rows(
    `SELECT booking_id, venue_id, room_id, status::text AS status, is_primary, label, expected_attendance,
            lower(occupied_range) AS occupied_start, upper(occupied_range) AS occupied_end
       FROM public.venue_booking WHERE event_id = $1 ORDER BY booking_id`,
    [eventId]
  );

before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm177DatabaseSchema.sql"), "utf8"));
  await db.exec(`
    ALTER TABLE public.venue ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE';
    CREATE TYPE public.booking_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
    -- The live venue_booking columns (SPM-181 added the requirement columns).
    CREATE TABLE public.venue_booking (
      booking_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      room_id integer NOT NULL REFERENCES public.room (room_id),
      event_id integer NOT NULL REFERENCES public.event (event_id),
      reviewed_by integer,
      requested_by integer NOT NULL REFERENCES public."user" (user_id),
      start_datetime timestamptz NOT NULL,
      end_datetime timestamptz NOT NULL,
      status public.booking_status NOT NULL DEFAULT 'PENDING',
      rejection_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      label varchar(100),
      expected_attendance integer CHECK (expected_attendance IS NULL OR expected_attendance > 0),
      layout_type varchar(100),
      required_facilities text[] NOT NULL DEFAULT '{}',
      accessibility_requirements text[] NOT NULL DEFAULT '{}',
      special_requirements text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      reviewed_at timestamptz
    );
    CREATE TABLE public.idempotency_records (
      actor_id integer NOT NULL REFERENCES public."user" (user_id) ON DELETE CASCADE,
      operation text NOT NULL CONSTRAINT idempotency_records_operation_check
        CHECK (operation IN ('event.create_draft', 'event.create_and_submit')),
      idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,128}$'),
      request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      response jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (actor_id, operation, idempotency_key)
    );
  `);
  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(functionSql(idempotency, "_claim_idempotency_key") + functionSql(idempotency, "_store_idempotent_response"));
  // Only the notification parts of SPM-156 that the booking notice uses.
  await db.exec(`
    ALTER TABLE public.notification ADD COLUMN action_key text, ADD COLUMN action_expires_at timestamptz;
    CREATE UNIQUE INDEX notification_action_key_key ON public.notification (action_key);
  `);
  await db.exec(functionSql(read("20261020161837_spm156_notification_foundation.sql"), "_notify_event_users"));

  await db.exec(`
    INSERT INTO public."user" (user_id, email, name, role, is_active) VALUES
      (1, 'spm179-owner@example.test', 'Owner', 'ORGANISER', true),
      (2, 'spm179-coordinator@example.test', 'Coordinator', 'COORDINATOR', true),
      (3, 'spm179-other@example.test', 'Other Coordinator', 'COORDINATOR', true),
      (4, 'spm179-vs1@example.test', 'Venue Staff One', 'VENUE_STAFF', true),
      (5, 'spm179-vs2@example.test', 'Venue Staff Two', 'VENUE_STAFF', true),
      (6, 'spm179-vs3@example.test', 'Inactive Venue Staff', 'VENUE_STAFF', false);
    INSERT INTO public.venue (venue_id, name, address, max_capacity, operating_hours, is_active, status) VALUES
      (10, 'Hall', '1 Test Road', 200, '08:00-22:00', true, 'ACTIVE'),
      (11, 'Annex', '2 Test Road', 80, '08:00-22:00', true, 'ACTIVE'),
      (12, 'Workshop', '3 Test Road', 100, NULL, true, 'UNDER_MAINTENANCE'),
      (13, 'Old Hall', '4 Test Road', 100, NULL, false, 'ACTIVE');
    INSERT INTO public.room (room_id, venue_id, layout_type, capacity) VALUES
      (100, 10, 'THEATRE', 200), (101, 10, 'BANQUET', 150), (120, 12, 'THEATRE', 100), (130, 13, 'THEATRE', 100);
  `);

  // Legacy rows written before the migration: one event with a single active
  // booking, one with two (no primary), one booking outside its event's window.
  const single = await createEvent();
  const double = await createEvent();
  const outside = await createEvent();
  await db.query(
    `INSERT INTO public.venue_booking (room_id, event_id, requested_by, start_datetime, end_datetime, status) VALUES
       (101, $1, 2, $2, $3, 'APPROVED'),
       (100, $4, 2, $5, $6, 'APPROVED'), (120, $4, 2, $5, $6, 'PENDING'),
       (100, $7, 2, $8, $9, 'APPROVED')`,
    [single.eventId, single.at("10:00"), single.at("12:00"),
     double.eventId, double.at("10:00"), double.at("12:00"),
     outside.eventId, outside.at("07:00"), outside.at("08:00")]
  );
  legacy = { single, double, outside };

  await db.exec(read("20261028161211_spm179_venue_booking_venue_link.sql"));
  await db.exec(read("20261028162013_spm179_request_venue_bookings.sql"));
  await db.exec(read("20261029080000_spm179_booking_range_hardening.sql"));
  await db.exec(read("20261029090000_spm179_booking_history_entry.sql"));
  await db.exec(read("20261031010000_spm185_booking_conflict_details.sql"));
});

test("backfill: every booking gets its room's venue and only single-booking events get a primary", async () => {
  const [single] = await bookingsOf(legacy.single.eventId);
  assert.equal(single.venue_id, HALL);
  assert.equal(single.is_primary, true);
  const double = await bookingsOf(legacy.double.eventId);
  assert.deepEqual(double.map((row) => [row.venue_id, row.is_primary]), [[HALL, false], [MAINTENANCE, false]]);
  assert.equal((await one("SELECT count(*)::int AS n FROM public._event_primary_venue($1)", [legacy.double.eventId])).n, 0);
  assert.equal((await one("SELECT venue_id FROM public._event_primary_venue($1)", [legacy.single.eventId])).venue_id, HALL);
});

test("unflagged bookings from other insert paths keep the interim primary rule", async () => {
  const insertLegacy = (event, roomId) => db.query(
    `INSERT INTO public.venue_booking (room_id, event_id, requested_by, start_datetime, end_datetime, status)
     VALUES ($1, $2, 2, $3, $4, 'APPROVED')`,
    [roomId, event.eventId, event.at("10:00"), event.at("11:00")]
  );
  const single = await createEvent();
  await insertLegacy(single, 100);
  assert.equal((await one("SELECT venue_id FROM public._event_primary_venue($1)", [single.eventId])).venue_id, HALL);
  const double = await createEvent();
  await insertLegacy(double, 100);
  await insertLegacy(double, 120);
  assert.equal((await one("SELECT count(*)::int AS n FROM public._event_primary_venue($1)", [double.eventId])).n, 0);

  // A request flags the implicit primary first, so it stays the primary venue.
  const result = await request(single.eventId, [booking(single, ANNEX, "12:00", "13:00")]);
  assert.equal(result.bookings[0].isPrimary, false);
  assert.deepEqual((await bookingsOf(single.eventId)).map((row) => [row.venue_id, row.is_primary]), [[HALL, true], [ANNEX, false]]);
  assert.equal((await one("SELECT venue_id FROM public._event_primary_venue($1)", [single.eventId])).venue_id, HALL);
});

test("legacy rows outside their event keep working when only the status changes", async () => {
  await db.query("UPDATE public.venue_booking SET status = 'REJECTED' WHERE event_id = $1", [legacy.outside.eventId]);
  const [row] = await bookingsOf(legacy.outside.eventId);
  assert.equal(row.status, "REJECTED");
});

test("fill trigger: a room-only insert gets the venue; a room of another venue is refused", async () => {
  const event = await createEvent();
  const { venue_id: venueId } = await one(
    `INSERT INTO public.venue_booking (room_id, event_id, requested_by, start_datetime, end_datetime)
     VALUES (100, $1, 2, $2, $3) RETURNING venue_id`,
    [event.eventId, event.at("10:00"), event.at("11:00")]
  );
  assert.equal(venueId, HALL);
  await assert.rejects(
    db.query(
      `INSERT INTO public.venue_booking (room_id, venue_id, event_id, requested_by, start_datetime, end_datetime, status)
       VALUES (100, $1, $2, 2, $3, $4, 'REJECTED')`,
      [ANNEX, event.eventId, event.at("12:00"), event.at("13:00")]
    ),
    /BOOKING_ROOM_VENUE_MISMATCH/
  );
});

test("window trigger (Master 6.3): a booking outside its event is refused", async () => {
  const event = await createEvent();
  await assert.rejects(
    db.query(
      `INSERT INTO public.venue_booking (room_id, event_id, requested_by, start_datetime, end_datetime, status)
       VALUES (100, $1, 2, $2, $3, 'REJECTED')`,
      [event.eventId, event.at("08:30"), event.at("10:00")]
    ),
    /BOOKING_OUTSIDE_EVENT/
  );
});

test("TC-01: one booking is saved PENDING with its occupied range, primary, version, activity and one notice", async () => {
  const event = await createEvent();
  const before = await one("SELECT arrangement_version FROM public.event WHERE event_id = $1", [event.eventId]);
  const result = await request(event.eventId, [booking(event, HALL, "10:00", "12:00", { expectedAttendance: 150 })]);

  assert.equal(result.replayed, false);
  assert.equal(result.requestId, `REQ-${String(event.eventId).padStart(6, "0")}`);
  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0].status, "PENDING");
  assert.equal(result.bookings[0].isPrimary, true);

  const [saved] = await bookingsOf(event.eventId);
  assert.equal(saved.status, "PENDING");
  assert.equal(saved.venue_id, HALL);
  assert.equal(saved.room_id, 100);
  assert.equal(saved.is_primary, true);
  assert.equal(new Date(saved.occupied_start).toISOString(), new Date(event.at("09:30")).toISOString());
  assert.equal(new Date(saved.occupied_end).toISOString(), new Date(event.at("12:45")).toISOString());

  const after = await one("SELECT arrangement_version FROM public.event WHERE event_id = $1", [event.eventId]);
  assert.equal(after.arrangement_version, before.arrangement_version + 1);
  const activity = await rows(
    "SELECT action, audience, actor_role FROM public.activity_log WHERE entity_name = 'event' AND entity_id = $1",
    [event.eventId]
  );
  assert.deepEqual(activity, [{ action: "VENUE_BOOKINGS_REQUESTED", audience: "STAFF_ONLY", actor_role: "COORDINATOR" }]);
  const notices = await rows(
    `SELECT n.type::text AS type, array_agg(r.recipient_id ORDER BY r.recipient_id) AS recipients
       FROM public.notification AS n JOIN public.notification_recipient AS r USING (notification_id)
      WHERE n.event_id = $1 GROUP BY n.notification_id`,
    [event.eventId]
  );
  assert.deepEqual(notices, [{ type: "BOOKING_UPDATE", recipients: [VENUE_STAFF, VENUE_STAFF_TWO] }]);
});

test("TC-02 / TC-21: two venues with one primary; a venue without a room gets one", async () => {
  const event = await createEvent();
  const result = await request(event.eventId, [
    booking(event, HALL, "10:00", "12:00", { isPrimary: true }),
    booking(event, ANNEX, "10:00", "12:00", { expectedAttendance: 80 }),
  ]);
  assert.deepEqual(result.bookings.map((item) => [item.venueId, item.isPrimary]), [[HALL, true], [ANNEX, false]]);
  // The history entry uses the event history's { field: { before, after } } shape.
  const [hallId, annexId] = result.bookings.map((item) => item.bookingId);
  const { changes } = await one(
    "SELECT changes FROM public.activity_log WHERE entity_name = 'event' AND entity_id = $1 AND action = 'VENUE_BOOKINGS_REQUESTED'",
    [event.eventId]
  );
  assert.deepEqual(changes, {
    venueBookings: { before: null, after: [`Hall (Booking #${hallId}, primary)`, `Annex (Booking #${annexId})`] },
  });
  const annexRoom = await one("SELECT room_id, capacity, layout_type FROM public.room WHERE venue_id = $1", [ANNEX]);
  assert.equal(annexRoom.capacity, 80);
  assert.equal(annexRoom.layout_type, "Theatre");
  const saved = await bookingsOf(event.eventId);
  assert.equal(saved[1].room_id, annexRoom.room_id);
});

test("TC-16: several bookings need exactly one primary; nothing is saved otherwise", async () => {
  const event = await createEvent();
  await refused(request(event.eventId, [
    booking(event, HALL, "10:00", "12:00"),
    booking(event, ANNEX, "10:00", "12:00"),
  ]), "PRIMARY_VENUE_REQUIRED");
  await refused(request(event.eventId, [
    booking(event, HALL, "10:00", "12:00", { isPrimary: true }),
    booking(event, ANNEX, "10:00", "12:00", { isPrimary: true }),
  ]), "PRIMARY_VENUE_REQUIRED");
  assert.equal((await bookingsOf(event.eventId)).length, 0);
});

test("TC-15: an existing primary is kept and a new booking is not primary", async () => {
  const event = await createEvent();
  await request(event.eventId, [booking(event, HALL, "10:00", "12:00")]);
  const result = await request(event.eventId, [booking(event, ANNEX, "13:00", "14:00")]);
  assert.equal(result.bookings[0].isPrimary, false);
  await refused(
    request(event.eventId, [booking(event, MAINTENANCE, "13:00", "14:00", { isPrimary: true })]),
    "PRIMARY_VENUE_ALREADY_SET"
  );
  assert.deepEqual((await bookingsOf(event.eventId)).map((row) => row.is_primary), [true, false]);
});

test("TC-07: capacity is checked per venue and the whole request is refused", async () => {
  const event = await createEvent();
  const detail = await refused(request(event.eventId, [
    booking(event, HALL, "10:00", "12:00", { isPrimary: true }),
    booking(event, ANNEX, "10:00", "12:00", { expectedAttendance: 81 }),
  ]), "VENUE_CAPACITY_EXCEEDED");
  assert.deepEqual(detail, { index: 1, venueId: ANNEX, capacity: 80, expectedAttendance: 81 });
  assert.equal((await bookingsOf(event.eventId)).length, 0);
  assert.equal((await one("SELECT arrangement_version FROM public.event WHERE event_id = $1", [event.eventId])).arrangement_version, 1);
});

test("TC-08: a venue twice in one request, or already booked for the event, is refused", async () => {
  const event = await createEvent();
  const twice = await refused(request(event.eventId, [
    booking(event, HALL, "10:00", "11:00", { isPrimary: true }),
    booking(event, HALL, "13:00", "14:00"),
  ]), "VENUE_LISTED_TWICE");
  assert.deepEqual(twice, { index: 1, venueId: HALL });
  await request(event.eventId, [booking(event, HALL, "10:00", "11:00")]);
  const again = await refused(request(event.eventId, [booking(event, HALL, "14:00", "15:00")]), "VENUE_ALREADY_BOOKED_FOR_EVENT");
  assert.deepEqual(again, { index: 0, venueId: HALL });
});

test("TC-09 / TC-10: other bookings conflict over occupied ranges; adjacency is allowed", async () => {
  const day = await createEvent();
  const neighbour = await createEvent();
  // Make both events share one day so their bookings compete for the Hall.
  await db.query("UPDATE public.event SET start_datetime = $2, end_datetime = $3 WHERE event_id = $1",
    [neighbour.eventId, day.at("07:00"), day.at("20:00")]);
  const other = { ...neighbour, at: day.at };
  await request(other.eventId, [booking(other, HALL, "10:00", "12:00")]); // occupies 09:30-12:45

  const conflict = await refused(request(day.eventId, [booking(day, HALL, "13:14", "14:00")]), "BOOKING_CONFLICT");
  assert.equal(conflict.index, 0);
  assert.equal(new Date(conflict.conflicts[0].start).toISOString(), new Date(day.at("10:00")).toISOString());
  assert.equal(new Date(conflict.conflicts[0].end).toISOString(), new Date(day.at("12:00")).toISOString());
  assert.equal(new Date(conflict.conflicts[0].occupiedStart).toISOString(), new Date(day.at("09:30")).toISOString());
  assert.equal(new Date(conflict.conflicts[0].occupiedEnd).toISOString(), new Date(day.at("12:45")).toISOString());

  const result = await request(day.eventId, [booking(day, HALL, "13:15", "14:00")]); // setup starts 12:45
  assert.equal(result.bookings.length, 1);
});

test("TC-12: the event's own booking at another venue is not a conflict", async () => {
  const event = await createEvent();
  await request(event.eventId, [booking(event, HALL, "10:00", "12:00")]);
  const result = await request(event.eventId, [booking(event, ANNEX, "10:00", "12:00")]);
  assert.equal(result.bookings.length, 1);
});

test("other bookings are checked by their stored occupied range; rows without one use the venue's minutes", async () => {
  const day = await createEvent();
  const stored = await createEvent();
  const unstored = await createEvent();
  for (const event of [stored, unstored]) {
    await db.query("UPDATE public.event SET start_datetime = $2, end_datetime = $3 WHERE event_id = $1",
      [event.eventId, day.at("07:00"), day.at("20:00")]);
  }
  // Stored wider than the Hall's 30/45 minutes would give (Master 5.4.1: the stored range counts).
  await db.query(
    `INSERT INTO public.venue_booking (room_id, venue_id, event_id, requested_by, start_datetime, end_datetime, status, occupied_range)
     VALUES (100, $1, $2, $3, $4, $5, 'PENDING', tstzrange($6::timestamptz, $7::timestamptz, '[)'))`,
    [HALL, stored.eventId, COORDINATOR, day.at("10:00"), day.at("12:00"), day.at("09:00"), day.at("14:00")]
  );
  // A row from before occupied_range existed: 15:00-15:30 occupies 14:30-16:15.
  await db.query(
    `INSERT INTO public.venue_booking (room_id, venue_id, event_id, requested_by, start_datetime, end_datetime, status)
     VALUES (100, $1, $2, $3, $4, $5, 'PENDING')`,
    [HALL, unstored.eventId, COORDINATOR, day.at("15:00"), day.at("15:30")]
  );

  // 14:00-14:30 occupies 13:30-15:15: it overlaps both.
  const conflict = await refused(request(day.eventId, [booking(day, HALL, "14:00", "14:30")]), "BOOKING_CONFLICT");
  const periods = conflict.conflicts.map((item) => [new Date(item.occupiedStart).toISOString(), new Date(item.occupiedEnd).toISOString()]);
  assert.deepEqual(periods, [
    [new Date(day.at("09:00")).toISOString(), new Date(day.at("14:00")).toISOString()],
    [new Date(day.at("14:30")).toISOString(), new Date(day.at("16:15")).toISOString()],
  ]);
});

test("SPM-179 SECURITY DEFINER functions search pg_temp last", async () => {
  const settings = await rows(
    `SELECT p.proname, array_to_string(p.proconfig, ',') AS config
       FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY ($1)`,
    [["begin_venue_booking_request", "request_venue_bookings", "_venue_booking_room", "_require_booking_coordinator",
      "_venue_booking_fill_venue", "_venue_booking_window_check", "_event_primary_venue"]]
  );
  assert.equal(settings.length, 7);
  for (const { proname, config } of settings) {
    assert.equal(config, "search_path=pg_catalog, public, pg_temp", proname);
  }
});

test("TC-14: venues out of service, inactive or without minutes are refused", async () => {
  const event = await createEvent();
  assert.deepEqual(
    await refused(request(event.eventId, [booking(event, MAINTENANCE, "10:00", "11:00")]), "VENUE_NOT_BOOKABLE"),
    { index: 0, venueId: MAINTENANCE }
  );
  await refused(request(event.eventId, [booking(event, CLOSED, "10:00", "11:00")]), "VENUE_NOT_BOOKABLE");
  await refused(
    request(event.eventId, [booking(event, ANNEX, "10:00", "11:00")], { minutes: { [HALL]: MINUTES[HALL] } }),
    "VENUE_BUFFERS_NOT_SET"
  );
});

test("TC-04 / TC-05: windows outside the event or in the past are refused", async () => {
  const event = await createEvent();
  await refused(request(event.eventId, [booking(event, HALL, "08:30", "10:00")]), "BOOKING_OUTSIDE_EVENT");
  await refused(request(event.eventId, [booking(event, HALL, "16:00", "17:30")]), "BOOKING_OUTSIDE_EVENT");
  const ok = await request(event.eventId, [booking(event, HALL, "09:00", "17:00")]);
  assert.equal(ok.bookings.length, 1);

  const past = await createEvent();
  await db.query("UPDATE public.event SET start_datetime = now() - interval '2 hours', end_datetime = now() + interval '2 hours' WHERE event_id = $1", [past.eventId]);
  await refused(request(past.eventId, [{
    ...booking(past, HALL, "10:00", "11:00"),
    start: new Date(Date.now() - 3600 * 1000).toISOString(),
    end: new Date(Date.now() + 3600 * 1000).toISOString(),
  }]), "BOOKING_IN_PAST");
});

test("TC-19: only the assigned coordinator, only in PLANNING; drafts are not found", async () => {
  const event = await createEvent();
  await refused(request(event.eventId, [booking(event, HALL, "10:00", "11:00")], { actorId: OTHER_COORDINATOR }), "FORBIDDEN");
  await refused(request(event.eventId, [booking(event, HALL, "10:00", "11:00")], { actorId: VENUE_STAFF }), "FORBIDDEN");
  const review = await createEvent({ status: "UNDER_REVIEW" });
  await refused(request(review.eventId, [booking(review, HALL, "10:00", "11:00")]), "EVENT_NOT_IN_PLANNING");
  const draft = await createEvent({ status: "DRAFT" });
  await refused(request(draft.eventId, [booking(draft, HALL, "10:00", "11:00")]), "EVENT_NOT_FOUND");
});

test("TC-17: a replay returns the stored result; a reused key with another body is refused", async () => {
  const event = await createEvent();
  const items = [booking(event, HALL, "10:00", "11:00")];
  const key = newKey();
  const first = await request(event.eventId, items, { key });
  const replay = await request(event.eventId, items, { key });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.bookings, first.bookings);
  assert.equal((await bookingsOf(event.eventId)).length, 1);
  assert.equal((await one("SELECT count(*)::int AS n FROM public.notification WHERE event_id = $1", [event.eventId])).n, 1);
  await refused(
    request(event.eventId, [booking(event, HALL, "13:00", "14:00")], { key, hash: hashOf("another body") }),
    "IDEMPOTENCY_KEY_REUSED"
  );
});

test("the second step refuses to run without the first in the same transaction", async () => {
  const event = await createEvent();
  await refused(
    db.query(
      "SELECT public.request_venue_bookings($1, $2, $3::jsonb, $4::jsonb, '[]'::jsonb, $5, $6)",
      [COORDINATOR, event.eventId, JSON.stringify([booking(event, HALL, "10:00", "11:00")]), JSON.stringify(MINUTES), newKey(), hashOf("x")]
    ),
    "VENUE_BOOKING_REQUEST_NOT_STARTED"
  );
});

test("malformed items are refused with their index", async () => {
  const event = await createEvent();
  const detail = await refused(request(event.eventId, [
    booking(event, HALL, "10:00", "11:00", { isPrimary: true }),
    { ...booking(event, ANNEX, "10:00", "11:00"), label: undefined },
  ]), "INVALID_VENUE_BOOKING_REQUEST");
  assert.deepEqual(detail, { index: 1 });
  await refused(request(event.eventId, [booking(event, HALL, "11:00", "10:00")]), "INVALID_VENUE_BOOKING_REQUEST");
  await refused(request(event.eventId, [booking(event, HALL, "10:00", "11:00", { expectedAttendance: 1.5 })]), "INVALID_VENUE_BOOKING_REQUEST");
});

test("TC-20: a failure after the inserts leaves no booking, version change, notice or claimed key", async () => {
  const event = await createEvent();
  await db.exec(`
    CREATE FUNCTION public.spm179_fail_activity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'VENUE_BOOKINGS_REQUESTED' THEN RAISE EXCEPTION 'forced activity failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER spm179_fail_activity BEFORE INSERT ON public.activity_log
      FOR EACH ROW EXECUTE FUNCTION public.spm179_fail_activity();
  `);
  const key = newKey();
  try {
    await assert.rejects(request(event.eventId, [booking(event, HALL, "10:00", "11:00")], { key }), /forced activity failure/);
  } finally {
    await db.exec("DROP TRIGGER spm179_fail_activity ON public.activity_log; DROP FUNCTION public.spm179_fail_activity();");
  }
  assert.equal((await bookingsOf(event.eventId)).length, 0);
  assert.equal((await one("SELECT arrangement_version FROM public.event WHERE event_id = $1", [event.eventId])).arrangement_version, 1);
  assert.equal((await one("SELECT count(*)::int AS n FROM public.notification WHERE event_id = $1", [event.eventId])).n, 0);
  assert.equal((await one("SELECT count(*)::int AS n FROM public.idempotency_records WHERE idempotency_key = $1", [key])).n, 0);
});
