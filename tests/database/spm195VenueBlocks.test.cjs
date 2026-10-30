// SPM-195 venue blocks, incidents and restoration (Master 5.2, 5.4.4, 6.2, 7,
// 7.1, 8; Q3, T4, T7, T33) on in-memory PostgreSQL. No hosted database, Auth,
// MongoDB or network: the backend's MongoDB reads (setup/turnaround minutes,
// holds) are passed in as the backend passes them. Safety-review supersession
// is the SPM-250 helper, stubbed here to record its calls; its own tests cover it.
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
const VENUE_STAFF = 4;
const VENUE_STAFF_TWO = 5;
const INACTIVE_VENUE_STAFF = 6;
const HALL = 10; // setup 30, turnaround 0 (passed in as MongoDB minutes)
const ANNEX = 11; // setup 0, turnaround 0
const WORKSHOP = 12; // UNDER_MAINTENANCE
const BLOCK_REASON = "MAINTENANCE";

let db;
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const rows = async (sql, values = []) => (await db.query(sql, values)).rows;

let nextDay = 0;
const createEvent = async ({ status = "PLANNING" } = {}) => {
  nextDay += 1;
  const day = new Date(Date.UTC(2030, 0, nextDay)).toISOString().slice(0, 10);
  const { event_id: eventId } = await one(
    `INSERT INTO public.event (organiser_id, coordinator_id, title, status, start_datetime, end_datetime, expected_attendance)
     VALUES ($1, $2, $3, $4, $5, $6, 100) RETURNING event_id`,
    [OWNER, COORDINATOR, `spm195 event ${nextDay}`, status, `${day}T08:00:00Z`, `${day}T20:00:00Z`]
  );
  return { eventId, day, at: (time) => `${day}T${time}:00Z` };
};

const ROOMS = { [HALL]: 100, [ANNEX]: 110, [WORKSHOP]: 120 };
// A booking as SPM-179 stores it: the venue, a bridging room and the occupied range.
const addBooking = async (event, venueId, start, end, { status = "APPROVED", setup = 0, occupied = true } = {}) => {
  const { booking_id: bookingId } = await one(
    `INSERT INTO public.venue_booking (room_id, venue_id, event_id, requested_by, start_datetime, end_datetime, status, occupied_range)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7,
             CASE WHEN $9 THEN tstzrange($5::timestamptz - make_interval(mins => $8), $6::timestamptz, '[)') END)
     RETURNING booking_id`,
    [ROOMS[venueId], venueId, event.eventId, COORDINATOR, event.at(start), event.at(end), status, setup, occupied]
  );
  return bookingId;
};

let keyCounter = 0;
const newKey = () => `spm195-key-${String((keyCounter += 1)).padStart(4, "0")}`;
const hashOf = (text) => require("node:crypto").createHash("sha256").update(text).digest("hex");
let blockCounter = 0;
const newBlockId = () => (blockCounter += 1).toString(16).padStart(24, "0");
const MINUTES = { [HALL]: [30, 0], [ANNEX]: [0, 0], [WORKSHOP]: [0, 0] };

// begin_venue_block then record_venue_block in one transaction, as the backend
// runs them on the venue lock connection.
const block = async (venueId, start, end, {
  eventIds = [], holds = [], actorId = VENUE_STAFF, key = newKey(), blockId = newBlockId(), note = "Air conditioning repair",
} = {}) => db.transaction(async (tx) => {
  const [setup, turnaround] = MINUTES[venueId] || [0, 0];
  const hash = hashOf(`${venueId}:${start}:${end}`);
  const started = (await tx.query(
    "SELECT public.begin_venue_block($1, $2, $3, $4, $5, $6, $7::integer[], $8, $9) AS result",
    [actorId, venueId, start, end, setup, turnaround, eventIds, key, hash]
  )).rows[0].result;
  if (started.replay) return { started, result: started.replay };
  const result = (await tx.query(
    "SELECT public.record_venue_block($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::integer[], $8, $9) AS result",
    [actorId, venueId, JSON.stringify({ blockId, reason: BLOCK_REASON, start, end, note }), JSON.stringify(holds),
     setup, turnaround, eventIds, key, hash]
  )).rows[0].result;
  return { started, result, blockId };
});

const restore = async (incidentId, venueId, { actorId = VENUE_STAFF, key = newKey(), start = null } = {}) =>
  db.transaction(async (tx) => {
    const [setup, turnaround] = MINUTES[venueId] || [0, 0];
    const hash = hashOf(`restore:${incidentId}`);
    const started = (await tx.query(
      "SELECT public.begin_venue_incident_restore($1, $2, $3, $4, $5, $6, $7) AS result",
      [actorId, incidentId, venueId, setup, turnaround, key, hash]
    )).rows[0].result;
    if (started.replay) return { started, result: started.replay };
    const result = (await tx.query(
      "SELECT public.restore_venue_incident($1, $2, $3, $4, $5, $6) AS result",
      [actorId, incidentId, venueId, start || started.incident.start, key, hash]
    )).rows[0].result;
    return { started, result };
  });

const refused = async (promise, message) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, message);
    return true;
  });
};

const incidentsOf = (eventId) => rows(
  `SELECT incident_id, booking_id, calendar_hold_id, calendar_block_id, status, resolution
     FROM public.resource_incidents WHERE event_id = $1 ORDER BY incident_id`,
  [eventId]
);
const versionOf = async (eventId) => (await one("SELECT arrangement_version FROM public.event WHERE event_id = $1", [eventId])).arrangement_version;
const statusOf = async (eventId) => (await one("SELECT status::text AS status FROM public.event WHERE event_id = $1", [eventId])).status;
const noticesOf = (eventId) => rows(
  `SELECT n.title, n.message, n.action_key, array_agg(r.recipient_id ORDER BY r.recipient_id) AS recipients
     FROM public.notification AS n JOIN public.notification_recipient AS r ON r.notification_id = n.notification_id
    WHERE n.event_id = $1 GROUP BY n.notification_id ORDER BY n.notification_id`,
  [eventId]
);
const activityOf = (entity, id) => rows(
  "SELECT action, audience, actor_role, changes FROM public.activity_log WHERE entity_name = $1 AND entity_id = $2 ORDER BY log_id",
  [entity, id]
);

before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm177DatabaseSchema.sql"), "utf8"));
  await db.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'venue_calendar_writer') THEN
        CREATE ROLE venue_calendar_writer NOLOGIN;
      END IF;
    END $$;
    ALTER TABLE public.venue ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE';
    CREATE TYPE public.booking_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
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
      expected_attendance integer,
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
    ALTER TABLE public.notification ADD COLUMN action_key text, ADD COLUMN action_expires_at timestamptz;
    CREATE UNIQUE INDEX notification_action_key_key ON public.notification (action_key);

    -- SPM-250 stand-in: version + 1, an open review SUPERSEDED, SAFETY_REVIEW back to PLANNING.
    CREATE TABLE public.safety_reviews (
      review_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id integer NOT NULL REFERENCES public.event (event_id),
      status text NOT NULL
    );
    CREATE TABLE public.supersede_calls (event_id integer, actor_id integer, reason text);
    CREATE FUNCTION public._supersede_safety_review(p_event_id integer, p_actor_id integer, p_reason text)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO public.supersede_calls VALUES (p_event_id, p_actor_id, p_reason);
      UPDATE public.event SET arrangement_version = arrangement_version + 1 WHERE event_id = p_event_id;
      UPDATE public.safety_reviews SET status = 'SUPERSEDED' WHERE event_id = p_event_id AND status = 'OPEN';
      UPDATE public.event SET status = 'PLANNING' WHERE event_id = p_event_id AND status = 'SAFETY_REVIEW';
      RETURN '{}'::jsonb;
    END;
    $$;
  `);
  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(functionSql(idempotency, "_claim_idempotency_key") + functionSql(idempotency, "_store_idempotent_response"));
  await db.exec(functionSql(read("20261020161837_spm156_notification_foundation.sql"), "_notify_event_users"));
  await db.exec(functionSql(read("20261020090836_spm73_venue_catalogue_maintenance.sql"), "_require_venue_staff"));
  await db.exec(functionSql(read("20261026043658_spm192_organiser_notifications.sql"), "_event_owner_recipients"));
  const spm193 = read("20261027090100_spm193_coordinator_notifications.sql");
  for (const name of ["_coordinator_notice_ref", "_coordinator_notice_event", "_coordinator_notice_venue_name",
    "_event_coordinator_recipients", "_notify_coordinator_venue_blocked"]) {
    await db.exec(functionSql(spm193, name));
  }

  await db.exec(`
    INSERT INTO public."user" (user_id, email, name, role, is_active) VALUES
      (1, 'spm195-owner@example.test', 'Owner', 'ORGANISER', true),
      (2, 'spm195-coordinator@example.test', 'Coordinator', 'COORDINATOR', true),
      (3, 'spm195-attendee@example.test', 'Attendee', 'ATTENDEE', true),
      (4, 'spm195-vs1@example.test', 'Venue Staff One', 'VENUE_STAFF', true),
      (5, 'spm195-vs2@example.test', 'Venue Staff Two', 'VENUE_STAFF', true),
      (6, 'spm195-vs3@example.test', 'Inactive Venue Staff', 'VENUE_STAFF', false);
    INSERT INTO public.venue (venue_id, name, address, max_capacity, operating_hours, is_active, status) VALUES
      (10, 'Hall', '1 Test Road', 200, '08:00-22:00', true, 'ACTIVE'),
      (11, 'Annex', '2 Test Road', 80, '08:00-22:00', true, 'ACTIVE'),
      (12, 'Workshop', '3 Test Road', 100, NULL, true, 'UNDER_MAINTENANCE');
    INSERT INTO public.room (room_id, venue_id, layout_type, capacity) VALUES
      (100, 10, 'THEATRE', 200), (110, 11, 'THEATRE', 80), (120, 12, 'THEATRE', 100);
  `);
  await db.exec(read("20261028161211_spm179_venue_booking_venue_link.sql"));
  await db.exec(read("20261029130000_spm195_resource_incidents.sql"));
  await db.exec(read("20261029140000_spm195_venue_blocks.sql"));
  await db.exec(read("20261029150000_spm195_block_change_notices.sql"));
  await db.exec(read("20261029160000_spm195_close_ended_incidents.sql"));
  await db.exec(read("20261030160000_spm195_block_change_recovery.sql"));
});

test("[SPM-195-AC1][TC-03] only active Venue Staff can block, change or restore", async () => {
  const event = await createEvent();
  for (const actorId of [OWNER, COORDINATOR, 3, INACTIVE_VENUE_STAFF]) {
    await refused(block(ANNEX, event.at("13:00"), event.at("15:00"), { actorId }), "FORBIDDEN");
    await refused(db.query("SELECT public.begin_venue_block_change($1, $2, $3, '{}')", [actorId, ANNEX, "f".repeat(24)]), "FORBIDDEN");
    await refused(restore(1, ANNEX, { actorId }), "FORBIDDEN");
  }
  assert.equal((await one("SELECT count(*)::int AS n FROM public.activity_log WHERE entity_name = 'venue'")).n, 0);
});

test("[SPM-195-AC2] a block is never refused because of bookings, and needs a valid reason and note", async () => {
  const event = await createEvent();
  await addBooking(event, ANNEX, "13:00", "15:00");
  const { result } = await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });
  assert.equal(result.block.status, "ACTIVE");
  await refused(block(ANNEX, event.at("16:00"), event.at("17:00"), { note: "   " }), "INVALID_VENUE_BLOCK");
  await refused(block(ANNEX, "2020-01-01T09:00:00Z", "2020-01-01T10:00:00Z"), "INVALID_VENUE_BLOCK");
  await refused(block(999, event.at("16:00"), event.at("17:00")), "VENUE_NOT_FOUND");
});

test("[SPM-195-AC3][AC4][AC5][TC-04][TC-09] an overlapped booking gets one incident, a version bump and the three notices", async () => {
  const event = await createEvent();
  const bookingId = await addBooking(event, ANNEX, "14:00", "16:00");
  const versionBefore = await versionOf(event.eventId);

  const { started, result, blockId } = await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });

  assert.deepEqual(started.affectedEventIds, [event.eventId]);
  const incidents = await incidentsOf(event.eventId);
  assert.equal(incidents.length, 1);
  assert.deepEqual(
    [incidents[0].booking_id, incidents[0].calendar_block_id, incidents[0].status, incidents[0].resolution],
    [bookingId, blockId, "OPEN", null]
  );
  assert.equal(result.incidents.length, 1);
  assert.equal(await versionOf(event.eventId), versionBefore + 1);
  assert.equal(await statusOf(event.eventId), "PLANNING");
  const booking = await one("SELECT status::text AS status FROM public.venue_booking WHERE booking_id = $1", [bookingId]);
  assert.equal(booking.status, "APPROVED");

  const notices = await noticesOf(event.eventId);
  const byTitle = Object.fromEntries(notices.map((notice) => [notice.title, notice]));
  assert.deepEqual(byTitle["Alternative venue required"].recipients, [COORDINATOR]);
  assert.match(byTitle["Alternative venue required"].message, /restore the booking .* replace the venue or cancel the event/);
  assert.deepEqual(byTitle["Venue arrangement affected"].recipients, [OWNER]);
  assert.match(byTitle["Venue arrangement affected"].message,
    /^Annex is unavailable during your booking for REQ-\d{6} "spm195 event \d+"\. Your event is not cancelled; your coordinator will decide the next step\.$/);
  assert.doesNotMatch(byTitle["Venue arrangement affected"].message, /maintenance|Air conditioning/i);
  // The other active Venue Staff only: not the actor, not the inactive member, no attendee.
  assert.deepEqual(byTitle["Venue blocked"].recipients, [VENUE_STAFF_TWO]);
  assert.match(byTitle["Venue blocked"].message, /Annex is blocked \(Maintenance\) from .* Affected: REQ-/);
  assert.ok(notices.every((notice) => !notice.recipients.includes(3)));

  const eventHistory = await activityOf("event", event.eventId);
  assert.deepEqual(eventHistory.map((entry) => [entry.action, entry.audience, entry.actor_role]),
    [["VENUE_BLOCK_AFFECTED_EVENT", "STAFF_ONLY", "VENUE_STAFF"]]);
  assert.ok(eventHistory[0].changes.venueAvailability.after.includes("Annex blocked"));
  const venueHistory = await activityOf("venue", ANNEX);
  assert.ok(venueHistory.some((entry) => entry.action === "VENUE_BLOCK_CREATED" && entry.audience === "STAFF_ONLY"));
});

test("[SPM-195-AC3][TC-05] the occupied range counts setup time, and adjacent ranges are not affected", async () => {
  const affected = await createEvent();
  const adjacent = await createEvent();
  await addBooking(affected, HALL, "15:15", "16:00", { setup: 30 });
  await addBooking(adjacent, HALL, "15:30", "17:00", { setup: 30 });

  await block(HALL, affected.at("13:00"), affected.at("15:00"), { eventIds: [affected.eventId] });
  await block(HALL, adjacent.at("13:00"), adjacent.at("15:00"), { eventIds: [adjacent.eventId] });

  assert.equal((await incidentsOf(affected.eventId)).length, 1);
  assert.equal((await incidentsOf(adjacent.eventId)).length, 0);
});

test("[SPM-195-AC3] an older booking without a stored range uses the venue's minutes", async () => {
  const event = await createEvent();
  await addBooking(event, HALL, "15:15", "16:00", { occupied: false });
  await block(HALL, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });
  assert.equal((await incidentsOf(event.eventId)).length, 1);
});

test("[SPM-195-TC-06] in a multi-venue event only the booking at the blocked venue is affected", async () => {
  const event = await createEvent();
  const annexBooking = await addBooking(event, ANNEX, "14:00", "16:00");
  await addBooking(event, HALL, "14:00", "16:00");
  await block(ANNEX, event.at("14:00"), event.at("15:00"), { eventIds: [event.eventId] });
  assert.deepEqual((await incidentsOf(event.eventId)).map((row) => row.booking_id), [annexBooking]);
});

test("[SPM-195-AC4][TC-07] an open safety review is superseded once per affected event", async () => {
  const event = await createEvent({ status: "SAFETY_REVIEW" });
  await addBooking(event, ANNEX, "10:00", "12:00");
  await addBooking(event, HALL, "13:00", "14:00", { status: "PENDING" });
  await db.query("INSERT INTO public.safety_reviews (event_id, status) VALUES ($1, 'OPEN')", [event.eventId]);

  await block(ANNEX, event.at("09:00"), event.at("15:00"), { eventIds: [event.eventId] });

  assert.equal(await statusOf(event.eventId), "PLANNING");
  assert.equal((await one("SELECT status FROM public.safety_reviews WHERE event_id = $1", [event.eventId])).status, "SUPERSEDED");
  const calls = await rows("SELECT actor_id, reason FROM public.supersede_calls WHERE event_id = $1", [event.eventId]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor_id, VENUE_STAFF);
  assert.match(calls[0].reason, /Annex is blocked \(Maintenance\)/);
  assert.equal((await incidentsOf(event.eventId)).filter((row) => row.status === "OPEN").length >= 1, true);
});

test("[SPM-195-TC-19] closed events and inactive bookings get no incident", async () => {
  const cancelled = await createEvent({ status: "CANCELLED" });
  const rejectedBooking = await createEvent();
  await addBooking(cancelled, ANNEX, "10:00", "12:00");
  await addBooking(rejectedBooking, ANNEX, "13:00", "15:00", { status: "REJECTED" });
  const day = cancelled.day;
  await block(ANNEX, `${day}T09:00:00Z`, `${day}T16:00:00Z`, { eventIds: [cancelled.eventId] });
  await block(ANNEX, rejectedBooking.at("09:00"), rejectedBooking.at("16:00"), { eventIds: [rejectedBooking.eventId] });
  assert.equal((await incidentsOf(cancelled.eventId)).length, 0);
  assert.equal((await incidentsOf(rejectedBooking.eventId)).length, 0);
});

test("[SPM-195-TC-18] an active hold gets an incident naming the hold", async () => {
  const event = await createEvent();
  const holdId = "a".repeat(24);
  await block(ANNEX, event.at("14:30"), event.at("16:00"), { eventIds: [event.eventId], holds: [{ holdId, eventId: event.eventId }] });
  const [incident] = await incidentsOf(event.eventId);
  assert.deepEqual([incident.booking_id, incident.calendar_hold_id], [null, holdId]);
  assert.ok((await noticesOf(event.eventId)).some((notice) => notice.title === "Alternative venue required"));
});

test("[SPM-195-AC12] an affected event that was not locked first stops the write", async () => {
  const event = await createEvent();
  await addBooking(event, ANNEX, "10:00", "12:00");
  const { started } = await db.transaction(async (tx) => ({
    started: (await tx.query(
      "SELECT public.begin_venue_block($1, $2, $3, $4, 0, 0, '{}'::integer[], $5, $6) AS result",
      [VENUE_STAFF, ANNEX, event.at("09:00"), event.at("11:00"), newKey(), hashOf("unlocked")]
    )).rows[0].result,
  }));
  assert.deepEqual(started.affectedEventIds, [event.eventId]);
  await refused(block(ANNEX, event.at("09:00"), event.at("11:00"), { eventIds: [] }), "AFFECTED_SET_CHANGED");
  const holdEvent = await createEvent();
  await refused(block(ANNEX, holdEvent.at("09:00"), holdEvent.at("11:00"), {
    eventIds: [], holds: [{ holdId: "b".repeat(24), eventId: holdEvent.eventId }],
  }), "AFFECTED_SET_CHANGED");
  assert.equal((await incidentsOf(event.eventId)).length, 0);
});

test("[SPM-195-AC13][TC-17] a retried block gives one block, one set of incidents and notices", async () => {
  const event = await createEvent();
  await addBooking(event, ANNEX, "10:00", "12:00");
  const key = newKey();
  const blockId = newBlockId();
  const first = await block(ANNEX, event.at("09:00"), event.at("11:00"), { eventIds: [event.eventId], key, blockId });
  const second = await block(ANNEX, event.at("09:00"), event.at("11:00"), { eventIds: [event.eventId], key, blockId });
  assert.equal(first.result.replayed, false);
  assert.equal(second.result.replayed, true);
  assert.deepEqual(second.result.block, first.result.block);
  assert.equal((await incidentsOf(event.eventId)).length, 1);
  assert.equal((await noticesOf(event.eventId)).length, 3);
  await refused(block(ANNEX, event.at("09:00"), event.at("10:30"), { eventIds: [event.eventId], key }), "IDEMPOTENCY_KEY_REUSED");
});

test("[SPM-195-AC9][AC14] shortening or lifting writes history and returns the open incidents with their ranges", async () => {
  const event = await createEvent();
  await addBooking(event, ANNEX, "14:00", "16:00");
  const { blockId } = await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });

  await refused(db.transaction(async (tx) => {
    await tx.query("SELECT public.begin_venue_block_change($1, $2, $3, '{}'::integer[])", [VENUE_STAFF, ANNEX, blockId]);
    await tx.query(
      "SELECT public.record_venue_block_change($1, $2, $3, 'SHORTENED', $4::jsonb, $5::jsonb, 0, 0, '{}'::integer[])",
      [VENUE_STAFF, ANNEX, blockId, JSON.stringify({ start: event.at("13:00"), end: event.at("15:00") }),
       JSON.stringify({ start: event.at("13:00"), end: event.at("14:00") })]
    );
  }), "AFFECTED_SET_CHANGED");

  const { started, recorded } = await db.transaction(async (tx) => {
    const begun = (await tx.query(
      "SELECT public.begin_venue_block_change($1, $2, $3, $4::integer[]) AS result", [VENUE_STAFF, ANNEX, blockId, [event.eventId]]
    )).rows[0].result;
    const done = (await tx.query(
      "SELECT public.record_venue_block_change($1, $2, $3, 'SHORTENED', $4::jsonb, $5::jsonb, 0, 0, $6::integer[]) AS result",
      [VENUE_STAFF, ANNEX, blockId, JSON.stringify({ start: event.at("13:00"), end: event.at("15:00") }),
       JSON.stringify({ start: event.at("13:00"), end: event.at("14:00") }), [event.eventId]]
    )).rows[0].result;
    return { started: begun, recorded: done };
  });
  assert.deepEqual(started.affectedEventIds, [event.eventId]);
  assert.equal(recorded.openIncidents.length, 1);
  assert.equal(new Date(recorded.openIncidents[0].occupiedStart).toISOString(), new Date(event.at("14:00")).toISOString());
  // The incident stays open until Venue Staff restore the booking (Q3).
  assert.equal((await incidentsOf(event.eventId))[0].status, "OPEN");
  assert.ok((await activityOf("event", event.eventId)).some((entry) => entry.action === "VENUE_BLOCK_SHORTENED"));
  assert.ok((await activityOf("venue", ANNEX)).some((entry) => entry.action === "VENUE_BLOCK_SHORTENED"
    && entry.changes.block.after.includes("to")));

  // Coordinator and the other Venue Staff are told; the organiser only on restore.
  const changeNotices = (await noticesOf(event.eventId)).filter((notice) => notice.title === "Venue block shortened");
  assert.deepEqual(changeNotices.map((notice) => notice.recipients), [[COORDINATOR], [VENUE_STAFF_TWO]]);
  assert.match(changeNotices[0].message, /Venue Staff will confirm whether the booking can be restored\.$/);
  assert.ok(changeNotices.every((notice) => !notice.recipients.includes(OWNER)));
});

test("[SPM-195-AC9] each later change notifies again, and a lift is announced as lifted", async () => {
  const event = await createEvent();
  await addBooking(event, ANNEX, "14:00", "16:00");
  const { blockId } = await block(ANNEX, event.at("13:00"), event.at("15:30"), { eventIds: [event.eventId] });
  const change = (action, after) => db.transaction(async (tx) => {
    await tx.query("SELECT public.begin_venue_block_change($1, $2, $3, $4::integer[])", [VENUE_STAFF, ANNEX, blockId, [event.eventId]]);
    await tx.query(
      "SELECT public.record_venue_block_change($1, $2, $3, $4, $5::jsonb, $6::jsonb, 0, 0, $7::integer[])",
      [VENUE_STAFF, ANNEX, blockId, action, JSON.stringify({ start: event.at("13:00"), end: event.at("15:30") }),
       JSON.stringify(after), [event.eventId]]
    );
  });
  await change("SHORTENED", { start: event.at("13:00"), end: event.at("15:00") });
  await change("SHORTENED", { start: event.at("13:00"), end: event.at("14:30") });
  await change("LIFTED", { start: event.at("13:00"), end: event.at("14:30") });
  const titles = (await noticesOf(event.eventId)).map((notice) => notice.title);
  assert.equal(titles.filter((title) => title === "Venue block shortened").length, 4);
  assert.equal(titles.filter((title) => title === "Venue block lifted").length, 2);
});

test("[SPM-195-AC10][TC-11][TC-17] restoring resolves the incident, bumps the version and tells coordinator and organiser", async () => {
  const event = await createEvent();
  const bookingId = await addBooking(event, ANNEX, "14:00", "16:00");
  await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });
  const [incident] = await incidentsOf(event.eventId);
  const versionBefore = await versionOf(event.eventId);

  const { started, result } = await restore(incident.incident_id, ANNEX);

  assert.equal(started.incident.bookingId, bookingId);
  assert.equal(new Date(started.incident.occupiedStart).toISOString(), new Date(event.at("14:00")).toISOString());
  assert.deepEqual([result.status, result.resolution, result.changed], ["RESOLVED", "RESTORED", true]);
  assert.equal(await versionOf(event.eventId), versionBefore + 1);
  assert.equal(await statusOf(event.eventId), "PLANNING");
  const notice = (await noticesOf(event.eventId)).find((item) => item.title === "Venue available again");
  assert.deepEqual(notice.recipients, [OWNER, COORDINATOR].sort((a, b) => a - b));
  assert.match(notice.message, /^Annex is available again for your booking on \d{1,2} Jan 2030 22:00\.$/);
  assert.ok((await activityOf("event", event.eventId)).some((entry) => entry.action === "VENUE_BOOKING_RESTORED"));

  const repeat = await restore(incident.incident_id, ANNEX);
  assert.deepEqual([repeat.result.status, repeat.result.changed], ["RESOLVED", false]);
  assert.equal(await versionOf(event.eventId), versionBefore + 1);
  assert.equal((await noticesOf(event.eventId)).filter((item) => item.title === "Venue available again").length, 1);
});

test("[SPM-195-AC10] restore refuses another venue, a released booking and a venue out of service", async () => {
  const event = await createEvent();
  const bookingId = await addBooking(event, ANNEX, "14:00", "16:00");
  await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });
  const [incident] = await incidentsOf(event.eventId);

  await refused(restore(incident.incident_id, HALL), "INCIDENT_NOT_FOUND");
  await refused(restore(999999, ANNEX), "INCIDENT_NOT_FOUND");
  await db.query("UPDATE public.venue_booking SET status = 'CANCELLED' WHERE booking_id = $1", [bookingId]);
  await refused(restore(incident.incident_id, ANNEX), "INCIDENT_NOT_RESTORABLE");

  const other = await createEvent();
  await addBooking(other, WORKSHOP, "14:00", "16:00");
  await block(WORKSHOP, other.at("13:00"), other.at("15:00"), { eventIds: [other.eventId] });
  const [workshopIncident] = await incidentsOf(other.eventId);
  await refused(restore(workshopIncident.incident_id, WORKSHOP), "VENUE_OUT_OF_SERVICE");
});

test("[SPM-195] a booking that ends closes its incident in the same transaction, naming who ended it", async () => {
  const event = await createEvent();
  const rejected = await addBooking(event, ANNEX, "14:00", "16:00", { status: "PENDING" });
  const kept = await addBooking(event, HALL, "14:00", "16:00");
  await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });
  await block(HALL, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });

  // As decide_venue_booking rejects: status and reviewer in one update.
  await db.query("UPDATE public.venue_booking SET status = 'REJECTED', reviewed_by = $2 WHERE booking_id = $1", [rejected, VENUE_STAFF]);

  const incidents = await incidentsOf(event.eventId);
  assert.deepEqual(
    incidents.map((incident) => [incident.booking_id, incident.status, incident.resolution]),
    [[rejected, "RESOLVED", "RELEASED"], [kept, "OPEN", null]]
  );
  const closed = (await activityOf("event", event.eventId)).filter((entry) => entry.action === "VENUE_INCIDENT_CLOSED");
  assert.deepEqual(closed.map((entry) => [entry.audience, entry.actor_role, entry.changes]), [
    ["STAFF_ONLY", "VENUE_STAFF", { incident: { before: "OPEN", after: "RELEASED" } }],
  ]);
  const actor = await one(
    "SELECT user_id, details FROM public.activity_log WHERE entity_id = $1 AND action = 'VENUE_INCIDENT_CLOSED'", [event.eventId]
  );
  assert.deepEqual(actor, { user_id: VENUE_STAFF, details: `Venue incident closed: booking #${rejected} was rejected by Venue Staff.` });

  // A closed incident is never restored or reported as restored.
  const [released] = incidents;
  await refused(restore(released.incident_id, ANNEX), "INCIDENT_NOT_RESTORABLE");

  // Any later status change of the ended booking writes nothing more.
  await db.query("UPDATE public.venue_booking SET status = 'CANCELLED' WHERE booking_id = $1", [rejected]);
  assert.equal((await activityOf("event", event.eventId)).filter((entry) => entry.action === "VENUE_INCIDENT_CLOSED").length, 1);
});

test("[SPM-195] cancelling or rejecting the event closes all its incidents as the system", async () => {
  const cancelled = await createEvent();
  await addBooking(cancelled, ANNEX, "14:00", "16:00");
  await addBooking(cancelled, HALL, "14:00", "16:00");
  await block(ANNEX, cancelled.at("13:00"), cancelled.at("15:00"), { eventIds: [cancelled.eventId] });
  await block(HALL, cancelled.at("13:00"), cancelled.at("15:00"), { eventIds: [cancelled.eventId] });
  await db.query("UPDATE public.event SET status = 'CANCELLED' WHERE event_id = $1", [cancelled.eventId]);
  assert.deepEqual((await incidentsOf(cancelled.eventId)).map((incident) => [incident.status, incident.resolution]),
    [["RESOLVED", "EVENT_CANCELLED"], ["RESOLVED", "EVENT_CANCELLED"]]);
  const closed = (await activityOf("event", cancelled.eventId)).filter((entry) => entry.action === "VENUE_INCIDENT_CLOSED");
  assert.deepEqual(closed.map((entry) => entry.actor_role), ["SYSTEM", "SYSTEM"]);

  const rejected = await createEvent();
  await addBooking(rejected, ANNEX, "14:00", "16:00");
  await block(ANNEX, rejected.at("13:00"), rejected.at("15:00"), { eventIds: [rejected.eventId] });
  await db.query("UPDATE public.event SET status = 'REJECTED' WHERE event_id = $1", [rejected.eventId]);
  assert.deepEqual((await incidentsOf(rejected.eventId)).map((incident) => incident.resolution), ["RELEASED"]);
});

test("[SPM-195] the hold expiry and conversion flows close a hold's incident through the shared helper", async () => {
  const event = await createEvent();
  const holdId = "e".repeat(24);
  await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId], holds: [{ holdId, eventId: event.eventId }] });
  const closed = await one(
    "SELECT public._close_venue_block_incidents($1, NULL, $2, 'RELEASED', NULL, 'the hold expired.') AS n", [event.eventId, holdId]
  );
  assert.equal(closed.n, 1);
  assert.deepEqual((await incidentsOf(event.eventId)).map((incident) => [incident.calendar_hold_id, incident.resolution]),
    [[holdId, "RELEASED"]]);
});

test("[SPM-195] a block is never refused because of how many events it covers", async () => {
  const event = await createEvent();
  const many = Array.from({ length: 1500 }, (_, index) => index + 100000).concat(event.eventId);
  const { result } = await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: many });
  assert.equal(result.block.status, "ACTIVE");
});

test("only the venue lock role may run the entry points", async () => {
  const signatures = [
    "public.begin_venue_block(integer, integer, timestamptz, timestamptz, integer, integer, integer[], text, text)",
    "public.record_venue_block(integer, integer, jsonb, jsonb, integer, integer, integer[], text, text)",
    "public.begin_venue_block_change(integer, integer, text, integer[])",
    "public.record_venue_block_change(integer, integer, text, text, jsonb, jsonb, integer, integer, integer[])",
    "public.begin_venue_incident_restore(integer, integer, integer, integer, integer, text, text)",
    "public.restore_venue_incident(integer, integer, integer, timestamptz, text, text)",
  ];
  for (const signature of signatures) {
    const privileges = await one(
      `SELECT has_function_privilege('venue_calendar_writer', $1, 'EXECUTE') AS writer,
              has_function_privilege('service_role', $1, 'EXECUTE') AS service`,
      [signature]
    );
    assert.deepEqual(privileges, { writer: true, service: false }, signature);
  }
  const helper = await one(
    "SELECT has_function_privilege('venue_calendar_writer', 'public._lock_events_then_venue(integer[], integer)', 'EXECUTE') AS writer"
  );
  assert.equal(helper.writer, false);
});


test("[SPM-195] change receipts roll back with effects and make recovery exactly once", async () => {
  const event = await createEvent();
  await addBooking(event, ANNEX, "14:00", "16:00");
  const { blockId } = await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });
  const token = require("node:crypto").randomUUID();
  const args = [VENUE_STAFF, VENUE_STAFF, token, ANNEX, blockId, "SHORTENED",
    JSON.stringify({ start: event.at("13:00"), end: event.at("15:00") }),
    JSON.stringify({ start: event.at("13:00"), end: event.at("14:00") }), 0, 0, [event.eventId]];
  const execute = async (tx, values = args) => {
    await tx.query("SELECT public.begin_venue_block_change($1,$2,$3,$4::integer[])", [VENUE_STAFF, ANNEX, blockId, [event.eventId]]);
    return (await tx.query("SELECT public.record_venue_block_change_once($1,$2,$3::uuid,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::integer[]) AS result", values)).rows[0].result;
  };
  await assert.rejects(db.transaction(async (tx) => { await execute(tx); throw new Error("Mongo write failed"); }), /Mongo write failed/);
  assert.equal((await rows("SELECT * FROM public.venue_block_change_receipts WHERE write_token=$1", [token])).length, 0);
  assert.equal((await activityOf("event", event.eventId)).filter(x => x.action === "VENUE_BLOCK_SHORTENED").length, 0);
  const recovered = await db.transaction(tx => execute(tx));
  const replayed = await db.transaction(tx => execute(tx));
  assert.deepEqual(replayed, recovered);
  assert.equal((await rows("SELECT * FROM public.venue_block_change_receipts WHERE write_token=$1", [token])).length, 1);
  assert.equal((await activityOf("event", event.eventId)).filter(x => x.action === "VENUE_BLOCK_SHORTENED").length, 1);
  assert.equal((await noticesOf(event.eventId)).filter(x => x.title === "Venue block shortened").length, 2);
  const changed = [...args]; changed[5] = "LIFTED";
  await refused(db.transaction(tx => execute(tx, changed)), "IDEMPOTENCY_KEY_REUSED");
});

test("[SPM-195] recovery retains original event history after the booking ended", async () => {
  const event = await createEvent();
  const bookingId = await addBooking(event, ANNEX, "14:00", "16:00");
  const { blockId } = await block(ANNEX, event.at("13:00"), event.at("15:00"), { eventIds: [event.eventId] });
  await db.query("UPDATE public.venue_booking SET status='REJECTED' WHERE booking_id=$1", [bookingId]);
  await db.transaction(async (tx) => {
    await tx.query("SELECT public.begin_venue_block_change($1,$2,$3,$4::integer[])", [VENUE_STAFF, ANNEX, blockId, [event.eventId]]);
    await tx.query("SELECT public.record_venue_block_change_once($1,$1,$2::uuid,$3,$4,'LIFTED',$5::jsonb,$5::jsonb,0,0,$6::integer[])",
      [VENUE_STAFF, require("node:crypto").randomUUID(), ANNEX, blockId,
        JSON.stringify({ start: event.at("13:00"), end: event.at("15:00") }), [event.eventId]]);
  });
  assert.equal((await activityOf("event", event.eventId)).filter(x => x.action === "VENUE_BLOCK_LIFTED").length, 1);
});

test("[SPM-195] recovery receipts are private and only callable by the lock role", async () => {
  const signature = "public.record_venue_block_change_once(integer,integer,uuid,integer,text,text,jsonb,jsonb,integer,integer,integer[])";
  const privileges = await one(`SELECT has_function_privilege('venue_calendar_writer',$1,'EXECUTE') AS writer,
    has_function_privilege('service_role',$1,'EXECUTE') AS service,
    has_table_privilege('authenticated','public.venue_block_change_receipts','SELECT') AS browser,
    has_table_privilege('venue_calendar_writer','public.venue_block_change_receipts','INSERT') AS direct_write`, [signature]);
  assert.deepEqual(privileges, { writer: true, service: false, browser: false, direct_write: false });
});
