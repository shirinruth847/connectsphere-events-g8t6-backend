// SPM-188 AC9/AC10: record_venue_hold_conversion on in-memory PostgreSQL.
// Verifies constraints, role execution permissions (venue_calendar_writer),
// window and detail checks (label and attendance), uniqueness, and activity logging.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8");

const HOLD_ID = "6720a1b2c3d4e5f60718293a";
const START = "2030-11-04T10:00:00Z";
const END = "2030-11-04T12:00:00Z";

async function setup(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE ROLE venue_calendar_writer;

    CREATE TABLE public."user" (
      user_id integer PRIMARY KEY,
      name text,
      role text,
      is_active boolean
    );

    CREATE TABLE public.event (
      event_id integer PRIMARY KEY,
      title text,
      status text,
      coordinator_id integer
    );

    CREATE TABLE public.venue (
      venue_id integer PRIMARY KEY,
      name text
    );

    CREATE TABLE public.activity_log (
      activity_id serial PRIMARY KEY,
      user_id integer,
      entity_name text,
      entity_id integer,
      action text,
      details text,
      actor_role text,
      changes jsonb,
      audience text
    );

    CREATE TABLE public.venue_hold_request (
      hold_request_id serial PRIMARY KEY,
      event_id integer,
      venue_id integer,
      status text,
      calendar_hold_id text,
      start_datetime timestamptz,
      end_datetime timestamptz,
      label text,
      expected_attendance integer
    );

    CREATE TABLE public.venue_booking (
      booking_id serial PRIMARY KEY,
      event_id integer,
      venue_id integer,
      status text,
      start_datetime timestamptz,
      end_datetime timestamptz,
      label text,
      expected_attendance integer
    );

    INSERT INTO public."user" VALUES (10, 'Coordinator One', 'COORDINATOR', true), (11, 'Coordinator Two', 'COORDINATOR', true);
    INSERT INTO public.venue VALUES (7, 'Grand Hall');
    INSERT INTO public.event VALUES (42, 'Tech Conference', 'PLANNING', 10);
  `);

  await db.exec(read("20261031111244_spm188_hold_conversion.sql"));
  return db;
}

test("[SPM-188] record_venue_hold_conversion links booking, writes activity, and permits venue_calendar_writer", async (t) => {
  const db = await setup(t);

  await db.exec(`
    INSERT INTO public.venue_hold_request (event_id, venue_id, status, calendar_hold_id, start_datetime, end_datetime, label, expected_attendance)
    VALUES (42, 7, 'PLACED', '${HOLD_ID}', '${START}', '${END}', 'Keynote', 150);

    INSERT INTO public.venue_booking (booking_id, event_id, venue_id, status, start_datetime, end_datetime, label, expected_attendance)
    VALUES (900, 42, 7, 'PENDING', '${START}', '${END}', 'Keynote', 150);
  `);

  // Executed as venue_calendar_writer
  await db.exec("SET ROLE venue_calendar_writer");
  const res = await db.query("SELECT public.record_venue_hold_conversion(10, 42, 900, $1) AS result", [HOLD_ID]);
  assert.deepEqual(res.rows[0].result, { holdId: HOLD_ID, bookingId: 900, holdRequestId: 1 });

  // Reset role to check outcomes
  await db.exec("RESET ROLE");
  const booking = (await db.query("SELECT calendar_hold_id FROM public.venue_booking WHERE booking_id = 900")).rows[0];
  assert.equal(booking.calendar_hold_id, HOLD_ID);

  const log = (await db.query("SELECT action, audience, details FROM public.activity_log WHERE entity_id = 42")).rows[0];
  assert.equal(log.action, "VENUE_HOLD_CONVERTED");
  assert.equal(log.audience, "STAFF_ONLY");
  assert.match(log.details, /The hold on Grand Hall was confirmed as Booking #900\./);
});

test("[SPM-188] record_venue_hold_conversion refuses mismatched label or expected attendance", async (t) => {
  const db = await setup(t);

  await db.exec(`
    INSERT INTO public.venue_hold_request (event_id, venue_id, status, calendar_hold_id, start_datetime, end_datetime, label, expected_attendance)
    VALUES (42, 7, 'PLACED', '${HOLD_ID}', '${START}', '${END}', 'Original Label', 150);
  `);

  // Booking with different label
  await db.exec(`
    INSERT INTO public.venue_booking (booking_id, event_id, venue_id, status, start_datetime, end_datetime, label, expected_attendance)
    VALUES (901, 42, 7, 'PENDING', '${START}', '${END}', 'Changed Label', 150);
  `);
  await assert.rejects(
    () => db.query("SELECT public.record_venue_hold_conversion(10, 42, 901, $1)", [HOLD_ID]),
    { message: "HOLD_DETAILS_CHANGED" }
  );

  // Booking with different attendance
  await db.exec(`
    INSERT INTO public.venue_booking (booking_id, event_id, venue_id, status, start_datetime, end_datetime, label, expected_attendance)
    VALUES (902, 42, 7, 'PENDING', '${START}', '${END}', 'Original Label', 160);
  `);
  await assert.rejects(
    () => db.query("SELECT public.record_venue_hold_conversion(10, 42, 902, $1)", [HOLD_ID]),
    { message: "HOLD_DETAILS_CHANGED" }
  );
});

test("[SPM-188] record_venue_hold_conversion refuses unauthorized coordinators, changed window, and duplicates", async (t) => {
  const db = await setup(t);

  await db.exec(`
    INSERT INTO public.venue_hold_request (event_id, venue_id, status, calendar_hold_id, start_datetime, end_datetime, label, expected_attendance)
    VALUES (42, 7, 'PLACED', '${HOLD_ID}', '${START}', '${END}', 'Keynote', 150);

    INSERT INTO public.venue_booking (booking_id, event_id, venue_id, status, start_datetime, end_datetime, label, expected_attendance)
    VALUES (900, 42, 7, 'PENDING', '${START}', '${END}', 'Keynote', 150),
           (901, 42, 7, 'PENDING', '2030-11-04T11:00:00Z', '${END}', 'Keynote', 150);
  `);

  // Unauthorized coordinator
  await assert.rejects(
    () => db.query("SELECT public.record_venue_hold_conversion(11, 42, 900, $1)", [HOLD_ID]),
    { message: "FORBIDDEN" }
  );

  // Changed window
  await assert.rejects(
    () => db.query("SELECT public.record_venue_hold_conversion(10, 42, 901, $1)", [HOLD_ID]),
    { message: "HOLD_WINDOW_CHANGED" }
  );

  // First conversion succeeds
  await db.query("SELECT public.record_venue_hold_conversion(10, 42, 900, $1)", [HOLD_ID]);

  // Duplicate conversion for same hold
  await db.exec(`
    INSERT INTO public.venue_booking (booking_id, event_id, venue_id, status, start_datetime, end_datetime, label, expected_attendance)
    VALUES (902, 42, 7, 'PENDING', '${START}', '${END}', 'Keynote', 150);
  `);
  await assert.rejects(
    () => db.query("SELECT public.record_venue_hold_conversion(10, 42, 902, $1)", [HOLD_ID]),
    { message: "HOLD_ALREADY_CONVERTED" }
  );
});

