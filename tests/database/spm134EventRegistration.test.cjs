// SPM-134 register_for_event on in-memory PostgreSQL (PGlite). No hosted
// database, Auth or network. The SPM-155 notification migrations are loaded as
// they are live, so the confirmation is the real one. PGlite has a single
// connection: last-place and duplicate races run in the live integration suite.
const { before, after, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(__dirname, "../..");
const MIGRATIONS_DIR = path.join(root, "supabase/migrations");
const read = (name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
const readBySuffix = (suffix) => {
  const name = fs.readdirSync(MIGRATIONS_DIR).find((file) => file.endsWith(suffix));
  assert.ok(name, `migration *${suffix} must exist`);
  return read(name);
};
const functionSql = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, `Function ${name} must exist in its source migration`);
  return match[0];
};

const ATTENDEE = 1;
const OTHER_ATTENDEE = 2;
const THIRD_ATTENDEE = 3;
const INACTIVE_ATTENDEE = 4;
const ORGANISER = 5;
const ORGANISATION = 1;

let db;
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const count = async (sql, values = []) => (await one(sql, values)).n;

// Every event gets its own venue with one approved booking, its primary venue,
// unless venue_capacity is null. registration_capacity is the organiser's cap.
const createEvent = async (overrides = {}) => {
  const event = {
    status: "CONFIRMED",
    is_published: true,
    is_registration_enabled: true,
    registration_capacity: 10,
    venue_capacity: 100,
    open: "-1 day",
    close: "5 days",
    start: "7 days",
    previously_confirmed: false,
    ...overrides,
  };
  const eventId = (await one(
    `INSERT INTO public.event (organiser_id, organisation_id, title, status, start_datetime, end_datetime, is_published,
       is_registration_enabled, registration_capacity, registration_open_at, registration_close_at, previously_confirmed)
     VALUES ($1, $2, 'Synthetic Forum', $3, now() + $4::interval, now() + $4::interval + interval '2 hours', $5, $6, $7,
       CASE WHEN $8::text IS NULL THEN NULL ELSE now() + $8::interval END,
       CASE WHEN $9::text IS NULL THEN NULL ELSE now() + $9::interval END, $10)
     RETURNING event_id`,
    [ORGANISER, ORGANISATION, event.status, event.start, event.is_published, event.is_registration_enabled,
      event.registration_capacity, event.open, event.close, event.previously_confirmed]
  )).event_id;
  if (event.venue_capacity !== null) await bookVenue(eventId, event.venue_capacity);
  return eventId;
};

const bookVenue = async (eventId, capacity, status = "APPROVED") => {
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
     SELECT event_id, $2, $3, start_datetime, end_datetime FROM public.event WHERE event_id = $1`,
    [eventId, roomId, status]
  );
};

const availabilityOf = async (eventId) =>
  (await one("SELECT public.event_registration_availability(e) AS a FROM public.event AS e WHERE e.event_id = $1", [eventId])).a;

const register = async (attendeeId, eventId, dietary = null, accessibility = null, key = null, hash = null) =>
  (await one("SELECT public.register_for_event($1, $2, $3, $4, $5, $6) AS r", [attendeeId, eventId, dietary, accessibility, key, hash])).r;
const seed = async (attendeeId, eventId, status) =>
  (await one("INSERT INTO public.registration (attendee_id, event_id, registration_status, registration_datetime) VALUES ($1, $2, $3, now() - interval '3 days') RETURNING registration_id", [attendeeId, eventId, status])).registration_id;

// Everything a registration attempt may write, for "nothing changed" checks.
const sideEffects = async (eventId) => ({
  registrations: (await db.query("SELECT * FROM public.registration WHERE event_id = $1 ORDER BY registration_id", [eventId])).rows,
  activity: await count("SELECT count(*)::int AS n FROM public.activity_log WHERE entity_name = 'registration'"),
  notifications: await count("SELECT count(*)::int AS n FROM public.notification WHERE event_id = $1", [eventId]),
  idempotency: await count("SELECT count(*)::int AS n FROM public.idempotency_records WHERE operation = 'registration.register'"),
});
const hasCode = (code) => (error) => {
  assert.equal(error.message, code);
  return true;
};
const refusesWithoutWriting = async (call, eventId, code) => {
  const before = await sideEffects(eventId);
  await assert.rejects(call(), hasCode(code));
  assert.deepEqual(await sideEffects(eventId), before);
};

before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm155DatabaseSchema.sql"), "utf8"));
  // Live columns and tables the registration operation reads, added to the
  // reduced SPM-155 schema (development schema inspected on 29 October 2026).
  await db.exec(`
    CREATE TABLE public.organisation (organisation_id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name varchar(150) NOT NULL);
    ALTER TABLE public.event
      ADD COLUMN organisation_id integer REFERENCES public.organisation (organisation_id),
      ADD COLUMN is_published boolean NOT NULL DEFAULT false,
      ADD COLUMN is_registration_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN registration_capacity integer CHECK (registration_capacity IS NULL OR registration_capacity > 0),
      ADD COLUMN registration_open_at timestamptz,
      ADD COLUMN registration_close_at timestamptz,
      ADD COLUMN previously_confirmed boolean NOT NULL DEFAULT false;
    CREATE TABLE public.activity_log (
      log_id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
      entity_name varchar(50) NOT NULL,
      entity_id integer NOT NULL,
      action varchar(50) NOT NULL,
      details text,
      "timestamp" timestamptz NOT NULL DEFAULT now(),
      actor_role text,
      changes jsonb,
      audience text NOT NULL CHECK (audience IN ('OWNER_ONLY', 'ORGANISER_SAFE', 'STAFF_ONLY'))
    );
    CREATE TABLE public.venue (
      venue_id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name varchar(150) NOT NULL,
      address varchar(255) NOT NULL,
      max_capacity integer NOT NULL CHECK (max_capacity > 0)
    );
    CREATE TABLE public.room (
      room_id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      venue_id integer NOT NULL REFERENCES public.venue (venue_id),
      layout_type varchar(50) NOT NULL,
      capacity integer NOT NULL
    );
    CREATE TABLE public.venue_booking (
      booking_id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      event_id integer NOT NULL REFERENCES public.event (event_id),
      room_id integer NOT NULL REFERENCES public.room (room_id),
      status text NOT NULL DEFAULT 'PENDING',
      start_datetime timestamptz NOT NULL,
      end_datetime timestamptz NOT NULL
    );
    ALTER TABLE public.idempotency_records
      ADD CONSTRAINT idempotency_records_operation_check CHECK (operation = ANY (ARRAY['event.create_draft'::text, 'event.confirm'::text]));
    INSERT INTO public."user" (user_id, email, name, role, is_active) VALUES
      (1, 'spm134-1@connectsphere.test', 'Attendee A', 'ATTENDEE', true),
      (2, 'spm134-2@connectsphere.test', 'Attendee B', 'ATTENDEE', true),
      (3, 'spm134-3@connectsphere.test', 'Attendee C', 'ATTENDEE', true),
      (4, 'spm134-4@connectsphere.test', 'Inactive Attendee', 'ATTENDEE', false),
      (5, 'spm134-5@connectsphere.test', 'Organiser', 'ORGANISER', true);
    INSERT INTO public.organisation (organisation_id, name) VALUES (1, 'Synthetic Organisation');`);

  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(functionSql(idempotency, "_claim_idempotency_key") + functionSql(idempotency, "_store_idempotent_response"));
  await db.exec(functionSql(read("20261019075510_spm173_lifecycle_transitions.sql"), "_notify_event_users"));
  await db.exec(read("20261020161808_spm155_notification_types.sql"));
  await db.exec(read("20261020161837_spm156_notification_foundation.sql"));
  await db.exec(read("20261020161912_spm155_attendee_notifications.sql"));
  // The primary venue as SPM-173 readiness reads it (the room-based definition
  // on this branch; SPM-179 keeps the same signature and result).
  await db.exec(functionSql(read("20261020112025_spm173_interim_readiness.sql"), "_event_primary_venue"));
  // The SPM-134 migrations in order: the middle two limit registration to
  // CONFIRMED and answer EVENT_NOT_FOUND for every other state; the fourth
  // dropped the enabled flag as a gate; the last restores the start time and
  // takes the capacity from the primary venue.
  await db.exec(readBySuffix("_spm134_event_registration.sql"));
  await db.exec(readBySuffix("_spm134_confirmed_only_registration.sql"));
  await db.exec(readBySuffix("_spm134_hidden_events_not_found.sql"));
  await db.exec(readBySuffix("_spm134_close_time_only_registration.sql"));
  await db.exec(readBySuffix("_spm134_window_and_venue_capacity.sql"));
});
after(async () => { if (db) await db.close(); });
beforeEach(async () => {
  await db.exec("DROP TRIGGER IF EXISTS spm134_fail_notification ON public.notification");
  await db.exec("DROP TRIGGER IF EXISTS spm134_fail_activity ON public.activity_log");
});

test("[SPM-134] should_create_one_registered_record_with_the_submitted_answers_when_registration_is_open", async () => {
  const eventId = await createEvent();
  const result = await register(ATTENDEE, eventId, "Vegetarian, no peanuts", "Step-free access");
  assert.equal(result.replayed, false);
  assert.equal(result.registration.registration_status, "REGISTERED");
  assert.equal(result.registration.dietary_restrictions, "Vegetarian, no peanuts");
  assert.equal(result.registration.accessibility_requirements, "Step-free access");
  assert.deepEqual(
    { eventId: result.event.event_id, title: result.event.title, organisation: result.event.organisation_name },
    { eventId, title: "Synthetic Forum", organisation: "Synthetic Organisation" }
  );
  const stored = await one("SELECT * FROM public.registration WHERE event_id = $1", [eventId]);
  assert.equal(stored.registration_id, result.registration.registration_id);
  assert.equal(stored.attendee_id, ATTENDEE);
  assert.equal(stored.has_attended, false);
  assert.equal(stored.withdrawal_date, null);
  assert.equal(await count("SELECT count(*)::int AS n FROM public.registration WHERE event_id = $1", [eventId]), 1);
});

test("[SPM-134] should_write_one_staff_only_activity_entry_without_personal_text_when_registration_succeeds", async () => {
  const eventId = await createEvent();
  const { registration } = await register(ATTENDEE, eventId, "Vegan", "Hearing loop");
  const entry = await one("SELECT * FROM public.activity_log WHERE entity_name = 'registration' AND entity_id = $1", [registration.registration_id]);
  assert.deepEqual(
    [entry.user_id, entry.action, entry.audience, entry.details],
    [ATTENDEE, "REGISTRATION_CREATED", "STAFF_ONLY", `Registered for event ${eventId}`]
  );
  assert.ok(!JSON.stringify(entry).includes("Vegan") && !JSON.stringify(entry).includes("Hearing loop"));
});

test("[SPM-134] should_notify_only_the_registering_attendee_once_when_registration_succeeds", async () => {
  const eventId = await createEvent();
  await seed(OTHER_ATTENDEE, eventId, "REGISTERED");
  await register(ATTENDEE, eventId);
  const notices = (await db.query(
    `SELECT n.type, n.title, n.message, array_agg(r.recipient_id) AS recipients
       FROM public.notification n JOIN public.notification_recipient r USING (notification_id)
      WHERE n.event_id = $1 GROUP BY n.notification_id`, [eventId])).rows;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "REGISTRATION_CONFIRMED");
  assert.equal(notices[0].title, "Registration confirmed");
  assert.match(notices[0].message, /Synthetic Forum/);
  assert.deepEqual(notices[0].recipients, [ATTENDEE]);
});

test("[SPM-134] should_refuse_with_already_registered_and_write_nothing_when_the_attendee_is_registered", async () => {
  const eventId = await createEvent();
  await register(ATTENDEE, eventId, "Vegan");
  await refusesWithoutWriting(() => register(ATTENDEE, eventId, "Halal"), eventId, "ALREADY_REGISTERED");
  assert.equal((await one("SELECT dietary_restrictions FROM public.registration WHERE event_id = $1", [eventId])).dietary_restrictions, "Vegan");
});

test("[SPM-134] should_refuse_with_already_waitlisted_when_the_attendee_is_on_the_waitlist", async () => {
  const eventId = await createEvent();
  await seed(ATTENDEE, eventId, "WAITLISTED");
  await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, "ALREADY_WAITLISTED");
});

test("[SPM-134] should_re_enter_the_same_record_with_a_new_time_and_notify_again_when_the_attendee_had_withdrawn", async () => {
  const eventId = await createEvent();
  const registrationId = await seed(ATTENDEE, eventId, "WITHDRAWN");
  await db.query("UPDATE public.registration SET withdrawal_date = now() - interval '1 day' WHERE registration_id = $1", [registrationId]);
  const before = await one("SELECT registration_datetime FROM public.registration WHERE registration_id = $1", [registrationId]);
  const result = await register(ATTENDEE, eventId, "Halal", null);
  const after = await one("SELECT * FROM public.registration WHERE registration_id = $1", [registrationId]);
  assert.equal(result.registration.registration_id, registrationId);
  assert.equal(after.registration_status, "REGISTERED");
  assert.equal(after.withdrawal_date, null);
  assert.equal(after.dietary_restrictions, "Halal");
  assert.ok(after.registration_datetime > before.registration_datetime);
  assert.equal(await count("SELECT count(*)::int AS n FROM public.registration WHERE event_id = $1", [eventId]), 1);
  assert.equal((await one("SELECT action FROM public.activity_log WHERE entity_name = 'registration' AND entity_id = $1", [registrationId])).action, "REGISTRATION_REENTERED");
  assert.equal(await count("SELECT count(*)::int AS n FROM public.notification WHERE event_id = $1 AND type = 'REGISTRATION_CONFIRMED'", [eventId]), 1);
});

test("[SPM-134] should_accept_the_last_place_and_refuse_the_next_with_registration_full_when_capacity_is_reached", async () => {
  const eventId = await createEvent({ registration_capacity: 2 });
  await seed(OTHER_ATTENDEE, eventId, "REGISTERED");
  await register(ATTENDEE, eventId);
  await refusesWithoutWriting(() => register(THIRD_ATTENDEE, eventId), eventId, "REGISTRATION_FULL");
  assert.equal(await count("SELECT count(*)::int AS n FROM public.registration WHERE event_id = $1 AND registration_status = 'REGISTERED'", [eventId]), 2);
  assert.equal(await count("SELECT count(*)::int AS n FROM public.registration WHERE event_id = $1 AND registration_status = 'WAITLISTED'", [eventId]), 0);
});

test("[SPM-134] should_count_only_registered_places_when_others_are_waitlisted_or_withdrawn", async () => {
  const eventId = await createEvent({ registration_capacity: 1 });
  await seed(OTHER_ATTENDEE, eventId, "WAITLISTED");
  await seed(THIRD_ATTENDEE, eventId, "WITHDRAWN");
  assert.equal((await register(ATTENDEE, eventId)).registration.registration_status, "REGISTERED");
});

// Final rule (team agreement of 30 October 2026, Master 5.6): open from the
// registration start time until the end time, subject to venue capacity. The
// enabled flag is not a gate.
test("[SPM-134] should_register_and_still_enforce_capacity_when_registration_enabled_is_false", async () => {
  const eventId = await createEvent({ is_registration_enabled: false, registration_capacity: 1 });
  assert.equal((await register(ATTENDEE, eventId)).registration.registration_status, "REGISTERED");
  await refusesWithoutWriting(() => register(OTHER_ATTENDEE, eventId), eventId, "REGISTRATION_FULL");
});

test("[TC-REG-018] should_refuse_with_registration_not_yet_open_and_write_nothing_before_the_start_time", async () => {
  const eventId = await createEvent({ open: "1 day", close: "5 days" });
  assert.equal(await availabilityOf(eventId), "NOT_YET_OPEN");
  await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, "REGISTRATION_NOT_YET_OPEN");
});

test("[SPM-134] should_refuse_with_registration_not_yet_open_not_full_when_a_full_event_has_not_opened", async () => {
  const eventId = await createEvent({ registration_capacity: 1, open: "1 day", close: "5 days" });
  await seed(OTHER_ATTENDEE, eventId, "REGISTERED");
  await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, "REGISTRATION_NOT_YET_OPEN");
});

for (const [label, window] of [
  ["after_the_close_time", { open: "-5 days", close: "-1 second" }],
  ["at_the_close_instant", { open: "-5 days", close: "0 seconds" }],
]) {
  test(`[SPM-134] should_refuse_with_registration_closed_${label}_by_database_time`, async () => {
    const eventId = await createEvent(window);
    await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, "REGISTRATION_CLOSED");
  });
}

test("[SPM-134] should_refuse_with_registration_closed_not_full_when_the_window_has_closed_and_capacity_is_also_reached", async () => {
  const eventId = await createEvent({ registration_capacity: 1, open: "-5 days", close: "-1 hour" });
  await seed(OTHER_ATTENDEE, eventId, "REGISTERED");
  await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, "REGISTRATION_CLOSED");
});

// ---------- venue capacity (Master 5.6, T18) ----------

test("[TC-REG-017] should_refuse_with_registration_full_when_the_primary_venue_is_full_and_no_organiser_cap_is_set", async () => {
  const eventId = await createEvent({ registration_capacity: null, venue_capacity: 2 });
  await seed(OTHER_ATTENDEE, eventId, "REGISTERED");
  assert.equal(await availabilityOf(eventId), "OPEN");
  assert.equal((await register(ATTENDEE, eventId)).registration.registration_status, "REGISTERED");
  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  await refusesWithoutWriting(() => register(THIRD_ATTENDEE, eventId), eventId, "REGISTRATION_FULL");
});

test("[SPM-134] should_stop_at_the_venue_capacity_when_the_organiser_cap_is_higher", async () => {
  const eventId = await createEvent({ registration_capacity: 50, venue_capacity: 1 });
  assert.equal((await register(ATTENDEE, eventId)).registration.registration_status, "REGISTERED");
  await refusesWithoutWriting(() => register(OTHER_ATTENDEE, eventId), eventId, "REGISTRATION_FULL");
});

test("[SPM-134] should_stop_at_the_organiser_cap_when_it_is_lower_than_the_venue_capacity", async () => {
  const eventId = await createEvent({ registration_capacity: 1, venue_capacity: 500 });
  assert.equal((await register(ATTENDEE, eventId)).registration.registration_status, "REGISTERED");
  await refusesWithoutWriting(() => register(OTHER_ATTENDEE, eventId), eventId, "REGISTRATION_FULL");
});

test("[SPM-134] should_read_the_capacity_from_an_approved_or_pending_primary_booking_only", async () => {
  const rejectedOnly = await createEvent({ venue_capacity: null });
  await bookVenue(rejectedOnly, 100, "REJECTED");
  await refusesWithoutWriting(() => register(ATTENDEE, rejectedOnly), rejectedOnly, "REGISTRATION_UNAVAILABLE");
});

// Missing configuration never means "always open" or "unlimited".
for (const [label, overrides] of [
  ["there_is_no_primary_venue", { venue_capacity: null }],
  ["there_are_two_bookings_and_no_primary_venue", { venue_capacity: null, second: true }],
  ["there_is_no_start_time", { open: null }],
  ["there_is_no_end_time", { close: null }],
  ["there_are_no_start_or_end_times", { open: null, close: null }],
]) {
  test(`[SPM-134] should_refuse_with_registration_unavailable_and_write_nothing_when_${label}`, async () => {
    const { second, ...event } = overrides;
    const eventId = await createEvent(event);
    if (second) {
      await bookVenue(eventId, 100);
      await bookVenue(eventId, 100);
    }
    assert.equal(await availabilityOf(eventId), "UNAVAILABLE");
    await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, "REGISTRATION_UNAVAILABLE");
  });
}

// Discovery and registration read one function, so each state has one outcome.
test("[SPM-134] should_refuse_each_state_discovery_shows_with_its_own_code_and_register_only_when_open", async () => {
  const cases = [
    [{ open: "1 day" }, "NOT_YET_OPEN", "REGISTRATION_NOT_YET_OPEN"],
    [{ close: "-1 second" }, "CLOSED", "REGISTRATION_CLOSED"],
    [{ venue_capacity: 1, full: true }, "FULL_WAITLIST", "REGISTRATION_FULL"],
    [{ venue_capacity: null }, "UNAVAILABLE", "REGISTRATION_UNAVAILABLE"],
  ];
  for (const [{ full, ...overrides }, availability, code] of cases) {
    const eventId = await createEvent(overrides);
    if (full) await seed(OTHER_ATTENDEE, eventId, "REGISTERED");
    assert.equal(await availabilityOf(eventId), availability);
    await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, code);
  }
  const open = await createEvent();
  assert.equal(await availabilityOf(open), "OPEN");
  assert.equal((await register(ATTENDEE, open)).registration.registration_status, "REGISTERED");
});

test("[SPM-134] should_show_closed_for_every_state_but_confirmed_whatever_the_window_and_capacity", async () => {
  for (const status of ["PREPARATION", "PLANNING", "SAFETY_REVIEW", "COMPLETED", "CANCELLED"]) {
    assert.equal(await availabilityOf(await createEvent({ status })), "CLOSED");
  }
});

test("[SPM-134] should_allow_only_the_backend_role_to_read_the_availability_function", async () => {
  const signature = "public.event_registration_availability(public.event)";
  const privileges = await one(`SELECT
      has_function_privilege('service_role', '${signature}', 'EXECUTE') AS service_role,
      has_function_privilege('anon', '${signature}', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', '${signature}', 'EXECUTE') AS authenticated`);
  assert.deepEqual(privileges, { service_role: true, anon: false, authenticated: false });
});

test("[SPM-134] should_register_when_the_event_is_confirmed_open_before_the_deadline_with_places_left", async () => {
  const eventId = await createEvent({ status: "CONFIRMED", registration_capacity: 2, open: "-1 day", close: "1 day" });
  await seed(OTHER_ATTENDEE, eventId, "REGISTERED");
  assert.equal((await register(ATTENDEE, eventId)).registration.registration_status, "REGISTERED");
});

test("[SPM-134] should_refuse_with_event_not_found_and_write_nothing_when_the_event_is_in_preparation", async () => {
  for (const previouslyConfirmed of [false, true]) {
    const eventId = await createEvent({ status: "PREPARATION", previously_confirmed: previouslyConfirmed });
    await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, "EVENT_NOT_FOUND");
  }
});

// Every lifecycle state except CONFIRMED, read from the enum so a new state is
// covered too, both for never-confirmed events and for confirmed events that
// went back to an earlier state. The open window and free places show the
// refusal comes from the state alone.
test("[SPM-134] should_refuse_with_event_not_found_and_write_nothing_when_the_event_is_in_any_state_other_than_confirmed", async () => {
  const states = (await db.query(
    "SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.event_status'::regtype AND enumlabel <> 'CONFIRMED' ORDER BY enumsortorder"
  )).rows.map((row) => row.enumlabel);
  for (const expected of ["PREPARATION", "PLANNING", "SAFETY_REVIEW", "DRAFT", "SUBMITTED", "UNDER_REVIEW",
    "AWAITING_CLARIFICATION", "COMPLETED", "REJECTED", "CANCELLED"]) {
    assert.ok(states.includes(expected), `${expected} must be an event state`);
  }
  for (const status of states) {
    for (const previouslyConfirmed of [false, true]) {
      const eventId = await createEvent({ status, previously_confirmed: previouslyConfirmed, open: "-1 day", close: "5 days" });
      await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, "EVENT_NOT_FOUND");
    }
  }
});

// The outcomes for an attendee-visible CONFIRMED event, side by side:
// CONFIRMED + inside [start, end) + capacity left registers; nothing else does.
test("[SPM-134] should_answer_not_yet_open_closed_full_or_registered_only_for_a_confirmed_event", async () => {
  const notYetOpen = await createEvent({ status: "CONFIRMED", open: "1 day", close: "5 days" });
  await refusesWithoutWriting(() => register(ATTENDEE, notYetOpen), notYetOpen, "REGISTRATION_NOT_YET_OPEN");

  const closed = await createEvent({ status: "CONFIRMED", open: "-5 days", close: "-1 second" });
  await refusesWithoutWriting(() => register(ATTENDEE, closed), closed, "REGISTRATION_CLOSED");

  const disabled = await createEvent({ status: "CONFIRMED", is_registration_enabled: false, open: "-1 day", close: "5 days" });
  assert.equal((await register(ATTENDEE, disabled)).registration.registration_status, "REGISTERED");

  const full = await createEvent({ status: "CONFIRMED", registration_capacity: 1, open: "-1 day", close: "5 days" });
  await seed(OTHER_ATTENDEE, full, "REGISTERED");
  await refusesWithoutWriting(() => register(ATTENDEE, full), full, "REGISTRATION_FULL");

  const open = await createEvent({ status: "CONFIRMED", registration_capacity: 2, open: "-1 day", close: "5 days" });
  await seed(OTHER_ATTENDEE, open, "REGISTERED");
  assert.equal((await register(ATTENDEE, open)).registration.registration_status, "REGISTERED");
});

test("[SPM-134] should_refuse_with_event_not_found_when_the_event_is_hidden_from_attendees", async () => {
  const hidden = [
    await createEvent({ is_published: false }),
    await createEvent({ status: "DRAFT" }),
    await createEvent({ status: "PLANNING" }),
    await createEvent({ status: "COMPLETED" }),
    await createEvent({ status: "CANCELLED" }),
    await createEvent({ start: "-3 hours" }),
  ];
  for (const eventId of hidden) {
    await refusesWithoutWriting(() => register(ATTENDEE, eventId), eventId, "EVENT_NOT_FOUND");
  }
  await assert.rejects(register(ATTENDEE, 999999), hasCode("EVENT_NOT_FOUND"));
});

test("[SPM-134] should_refuse_with_not_attendee_and_write_nothing_when_the_user_is_not_an_active_attendee", async () => {
  const eventId = await createEvent();
  for (const userId of [ORGANISER, INACTIVE_ATTENDEE, 999999]) {
    await refusesWithoutWriting(() => register(userId, eventId), eventId, "NOT_ATTENDEE");
  }
});

test("[SPM-134] should_replay_the_stored_result_without_new_rows_when_the_same_idempotency_key_is_sent_again", async () => {
  const eventId = await createEvent();
  const hash = "a".repeat(64);
  const first = await register(ATTENDEE, eventId, "Vegan", null, "spm134-key-0001", hash);
  const before = await sideEffects(eventId);
  const replay = await register(ATTENDEE, eventId, "Vegan", null, "spm134-key-0001", hash);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.registration, first.registration);
  assert.deepEqual(await sideEffects(eventId), before);
  await assert.rejects(register(ATTENDEE, eventId, "Halal", null, "spm134-key-0001", "b".repeat(64)), hasCode("IDEMPOTENCY_KEY_REUSED"));
});

test("[SPM-134] should_not_consume_the_idempotency_key_when_the_registration_is_refused", async () => {
  const eventId = await createEvent({ registration_capacity: 1 });
  const registrationId = await seed(OTHER_ATTENDEE, eventId, "REGISTERED");
  const hash = "c".repeat(64);
  await assert.rejects(register(ATTENDEE, eventId, null, null, "spm134-key-0002", hash), hasCode("REGISTRATION_FULL"));
  await db.query("UPDATE public.registration SET registration_status = 'WITHDRAWN' WHERE registration_id = $1", [registrationId]);
  const retried = await register(ATTENDEE, eventId, null, null, "spm134-key-0002", hash);
  assert.equal(retried.replayed, false);
  assert.equal(retried.registration.registration_status, "REGISTERED");
});

test("[SPM-134] should_roll_back_the_registration_activity_and_key_when_the_confirmation_cannot_be_written", async () => {
  const eventId = await createEvent();
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.spm134_fail_notification() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOTIFICATION_WRITE_FAILED'; END; $$;
    CREATE TRIGGER spm134_fail_notification BEFORE INSERT ON public.notification
      FOR EACH ROW EXECUTE FUNCTION public.spm134_fail_notification();`);
  await refusesWithoutWriting(
    () => register(ATTENDEE, eventId, "Vegan", null, "spm134-key-0003", "d".repeat(64)),
    eventId,
    "NOTIFICATION_WRITE_FAILED"
  );
});

test("[SPM-134] should_refuse_text_the_database_cannot_hold_and_write_nothing_when_answers_break_the_checks", async () => {
  const eventId = await createEvent();
  const before = await sideEffects(eventId);
  await assert.rejects(register(ATTENDEE, eventId, "   ", null), (error) => error.code === "23514");
  await assert.rejects(register(ATTENDEE, eventId, null, "x".repeat(1001)), (error) => error.code === "23514");
  assert.deepEqual(await sideEffects(eventId), before);
  assert.equal((await register(ATTENDEE, eventId, "x".repeat(1000), "🌾 素食")).registration.accessibility_requirements, "🌾 素食");
});

test("[SPM-134] should_keep_existing_operations_and_allow_registration_register_when_extending_the_idempotency_check", async () => {
  const check = await one("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'idempotency_records_operation_check'");
  assert.match(check.def, /event\.create_draft/);
  assert.match(check.def, /event\.confirm/);
  assert.match(check.def, /registration\.register/);
});

test("[SPM-134] should_allow_only_the_backend_role_to_run_the_registration_function", async () => {
  const signature = "public.register_for_event(integer, integer, text, text, text, text)";
  const privileges = await one(`SELECT
      has_function_privilege('service_role', '${signature}', 'EXECUTE') AS service_role,
      has_function_privilege('anon', '${signature}', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', '${signature}', 'EXECUTE') AS authenticated`);
  assert.deepEqual(privileges, { service_role: true, anon: false, authenticated: false });
});

// ---------- exact boundaries (Master 5.6: [registration_open_at, registration_close_at)) ----------

// Inside one transaction now() is a single instant, so an event created there
// with "0 seconds" opens or closes exactly when register_for_event checks it.
const atOneInstant = async (window) => {
  await db.exec("BEGIN");
  try {
    const eventId = await createEvent(window);
    return await register(ATTENDEE, eventId);
  } finally {
    await db.exec("ROLLBACK");
  }
};

test("[SPM-134] should_accept_the_registration_when_database_time_is_exactly_registration_open_at", async () => {
  assert.equal((await atOneInstant({ open: "0 seconds", close: "5 days" })).registration.registration_status, "REGISTERED");
});

test("[SPM-134] should_refuse_with_registration_not_yet_open_when_database_time_is_one_microsecond_before_open", async () => {
  await assert.rejects(atOneInstant({ open: "1 microsecond", close: "5 days" }), hasCode("REGISTRATION_NOT_YET_OPEN"));
});

test("[SPM-134] should_accept_the_registration_when_database_time_is_one_microsecond_before_close", async () => {
  assert.equal((await atOneInstant({ open: "-5 days", close: "1 microsecond" })).registration.registration_status, "REGISTERED");
});

test("[SPM-134] should_refuse_with_registration_closed_when_database_time_is_exactly_registration_close_at", async () => {
  await assert.rejects(atOneInstant({ open: "-5 days", close: "0 seconds" }), hasCode("REGISTRATION_CLOSED"));
});

test("[TC-REG-017] should_refuse_with_registration_full_not_closed_when_capacity_is_reached_one_microsecond_before_close", async () => {
  await db.exec("BEGIN");
  try {
    const eventId = await createEvent({ registration_capacity: 1, open: "-5 days", close: "1 microsecond" });
    await seed(OTHER_ATTENDEE, eventId, "REGISTERED");
    await assert.rejects(register(ATTENDEE, eventId), hasCode("REGISTRATION_FULL"));
  } finally {
    await db.exec("ROLLBACK");
  }
});

// ---------- atomicity at the activity stage ----------

test("[SPM-134] should_roll_back_the_registration_answers_notice_and_key_when_the_activity_entry_cannot_be_written", async () => {
  const eventId = await createEvent();
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.spm134_fail_activity() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ACTIVITY_WRITE_FAILED'; END; $$;
    CREATE TRIGGER spm134_fail_activity BEFORE INSERT ON public.activity_log
      FOR EACH ROW EXECUTE FUNCTION public.spm134_fail_activity();`);
  await refusesWithoutWriting(
    () => register(ATTENDEE, eventId, "Vegan", "Ramp", "spm134-key-0004", "e".repeat(64)),
    eventId,
    "ACTIVITY_WRITE_FAILED"
  );
  await db.exec("DROP TRIGGER spm134_fail_activity ON public.activity_log");
  // Nothing was consumed: the same key now succeeds once.
  assert.equal((await register(ATTENDEE, eventId, "Vegan", "Ramp", "spm134-key-0004", "e".repeat(64))).replayed, false);
});

test("[TC-REG-020] should_roll_back_a_re_entry_to_its_withdrawn_state_when_the_confirmation_cannot_be_written", async () => {
  const eventId = await createEvent();
  const registrationId = await seed(ATTENDEE, eventId, "WITHDRAWN");
  await db.exec(`
    CREATE OR REPLACE FUNCTION public.spm134_fail_notification() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOTIFICATION_WRITE_FAILED'; END; $$;
    CREATE TRIGGER spm134_fail_notification BEFORE INSERT ON public.notification
      FOR EACH ROW EXECUTE FUNCTION public.spm134_fail_notification();`);
  await refusesWithoutWriting(() => register(ATTENDEE, eventId, "Halal", null), eventId, "NOTIFICATION_WRITE_FAILED");
  const row = await one("SELECT registration_status, dietary_restrictions FROM public.registration WHERE registration_id = $1", [registrationId]);
  assert.deepEqual(row, { registration_status: "WITHDRAWN", dietary_restrictions: null });
});

test("[TC-REG-013] should_keep_the_submitted_answers_when_the_attendee_profile_changes_afterwards", async () => {
  // The function stores the request's answers; nothing reads attendee_profile.
  const source = (await one("SELECT prosrc FROM pg_proc WHERE proname = 'register_for_event'")).prosrc;
  assert.ok(!source.includes("attendee_profile"), "register_for_event must not read or write attendee_profile");
  const eventId = await createEvent();
  const { registration } = await register(ATTENDEE, eventId, "Vegetarian, no peanuts", "Step-free access");
  const stored = await one("SELECT dietary_restrictions, accessibility_requirements FROM public.registration WHERE registration_id = $1", [registration.registration_id]);
  assert.deepEqual(stored, { dietary_restrictions: "Vegetarian, no peanuts", accessibility_requirements: "Step-free access" });
});
