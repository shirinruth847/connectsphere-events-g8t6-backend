// SPM-193 coordinator notifications (Master 1.5 sections 4.2, 5.4.3, 5.4.4,
// 5.5 and 8) on an isolated in-memory PostgreSQL engine. No hosted database,
// Auth or network. See docs/test-plans/spm-193.md.
//
// Hold expiry (SPM-188), venue blocks and technical decisions do not exist yet.
// The spm193_test_* function below stands in for them here only: it exists in
// this engine, never in a migration or route, and calls the real coordinator
// helpers the way those workflows must. Reassignment itself is tested live.
const { before, after, test } = require("node:test");
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
const COORDINATOR_TWO = 3;
const OTHER_COORDINATOR = 4;
const LEAD = 5;
const INACTIVE_COORDINATOR = 6;
const ATTENDEE = 7;
const VENUE = 10;

let db;
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const rows = async (sql, values = []) => (await db.query(sql, values)).rows;

const createEvent = async ({ coordinatorId = COORDINATOR, title = "Synthetic Expo", status = "PLANNING" } = {}) =>
  (await one(
    `INSERT INTO public.event (organiser_id, coordinator_id, title, status, start_datetime, end_datetime)
     VALUES ($1, $2, $3, $4, now() + interval '30 days', now() + interval '30 days 2 hours') RETURNING event_id`,
    [OWNER, coordinatorId, title, status]
  )).event_id;

const eventNotifications = (eventId) =>
  rows(
    `SELECT n.*, n.type::text AS type, array_agg(nr.recipient_id ORDER BY nr.recipient_id) AS recipients
       FROM public.notification AS n JOIN public.notification_recipient AS nr USING (notification_id)
      WHERE n.event_id = $1 GROUP BY n.notification_id ORDER BY n.notification_id`,
    [eventId]
  );

// Writes one notice addressed to the given users, as an existing trigger would.
const notify = async (eventId, recipients, { type = "STATUS_CHANGE", title = "Synthetic notice" } = {}) =>
  (await one(
    "SELECT public._notify_event_users($1, $2, 'Synthetic message.', $3::integer[], $4::public.notification_type, NULL, NULL) AS id",
    [eventId, title, recipients, type]
  )).id;

// What reassign_event_coordinator does to notifications (live-tested in
// coordinatorNotifications.integration.test.js): the event moves to the new
// coordinator and the previous one gets an ASSIGNMENT_ENDED notice.
const reassign = async (eventId, from, to) => {
  await db.query("UPDATE public.event SET coordinator_id = $2 WHERE event_id = $1", [eventId, to]);
  await notify(eventId, [from], { type: "ASSIGNMENT_ENDED", title: "Event assignment ended" });
  await notify(eventId, [to], { title: "New event coordination assignment" });
};

const inbox = (userId) => rows("SELECT * FROM public.list_notifications($1, 100, NULL, NULL)", [userId]);
const inboxAbout = async (userId, eventId) => (await inbox(userId)).filter((n) => n.event_id === eventId);
const unread = async (userId) => (await one("SELECT public.count_unread_notifications($1) AS n", [userId])).n;
const requestId = (eventId) => `REQ-${String(eventId).padStart(6, "0")}`;
const rejects = (promise, message) => assert.rejects(promise, (error) => error.message === message);

before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm155DatabaseSchema.sql"), "utf8"));
  // Only the columns these functions read.
  await db.exec(`ALTER TABLE public.event ADD COLUMN coordinator_id integer REFERENCES public."user" (user_id);
    CREATE TABLE public.venue (venue_id integer PRIMARY KEY, name varchar(150) NOT NULL);`);
  await db.exec(`INSERT INTO public."user" (user_id, email, name, role, is_active) VALUES
    (1, 'spm193-1@connectsphere.test', 'Organiser', 'ORGANISER', true),
    (2, 'spm193-2@connectsphere.test', 'Coordinator C', 'COORDINATOR', true),
    (3, 'spm193-3@connectsphere.test', 'Coordinator C2', 'COORDINATOR', true),
    (4, 'spm193-4@connectsphere.test', 'Coordinator D', 'COORDINATOR', true),
    (5, 'spm193-5@connectsphere.test', 'Lead', 'COORDINATOR_LEAD', true),
    (6, 'spm193-6@connectsphere.test', 'Inactive Coordinator', 'COORDINATOR', false),
    (7, 'spm193-7@connectsphere.test', 'Attendee', 'ATTENDEE', true);
    INSERT INTO public.venue (venue_id, name) VALUES (10, 'Synthetic Hall');`);

  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(functionSql(idempotency, "_claim_idempotency_key") + functionSql(idempotency, "_store_idempotent_response"));
  await db.exec(read("20261020161808_spm155_notification_types.sql"));
  await db.exec(read("20261020161837_spm156_notification_foundation.sql"));
  await db.exec(read("20261020161912_spm155_attendee_notifications.sql"));
  await db.exec(read("20261026043658_spm192_organiser_notifications.sql"));
  await db.exec(read("20261027051734_spm193_assignment_ended_type.sql"));
  await db.exec(read("20261027090100_spm193_coordinator_notifications.sql"));

  // Stand-in for a workflow that ends with a coordinator notice: idempotent,
  // locks the event, notifies in the same transaction. p_fail_after_notify
  // fails after the notice was written, as a later step of the real action could.
  await db.exec(`CREATE FUNCTION public.spm193_test_workflow(
      p_event_id integer, p_notice text, p_args jsonb, p_key text, p_fail_after_notify boolean DEFAULT false)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE v_replay jsonb;
    BEGIN
      IF p_key IS NOT NULL THEN
        v_replay := public._claim_idempotency_key(2, 'test.' || p_notice, p_key, repeat('a', 64));
        IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
      END IF;
      PERFORM 1 FROM public.event WHERE event_id = p_event_id FOR UPDATE;
      IF p_notice = 'hold_expiring' THEN
        PERFORM public._notify_coordinator_hold_expiring(
          p_event_id, p_args ->> 'hold', (p_args ->> 'venue')::integer, (p_args ->> 'expiresAt')::timestamptz);
      ELSIF p_notice = 'hold_expired' THEN
        PERFORM public._notify_coordinator_hold_expired(p_event_id, p_args ->> 'hold', (p_args ->> 'venue')::integer);
      ELSIF p_notice = 'venue_blocked' THEN
        PERFORM public._notify_coordinator_venue_blocked(
          p_event_id, p_args ->> 'block', (p_args ->> 'venue')::integer, p_args ->> 'reason');
      ELSIF p_notice = 'technical' THEN
        PERFORM public._notify_coordinator_technical_decision(
          p_event_id, p_args ->> 'request', p_args ->> 'decision', p_args ->> 'reason');
      END IF;
      IF p_fail_after_notify THEN RAISE EXCEPTION 'LATER_STEP_FAILED'; END IF;
      RETURN public._store_idempotent_response(2, 'test.' || p_notice, p_key, jsonb_build_object('event_id', p_event_id));
    END; $$;`);
});

after(async () => {
  await db.close();
});

const run = (eventId, notice, args, key = null, failAfterNotify = false) =>
  db.query("SELECT public.spm193_test_workflow($1, $2, $3::jsonb, $4, $5)", [eventId, notice, JSON.stringify(args), key, failAfterNotify]);

// ---------- visibility (AC2, AC10) ----------

test("[SPM-193-TC-03] after reassignment the previous coordinator sees only the 'no longer assigned' notice", async () => {
  const eventId = await createEvent();
  await notify(eventId, [COORDINATOR], { title: "New event coordination assignment" });
  await notify(eventId, [COORDINATOR], { type: "BOOKING_UPDATE", title: "Venue booking approved" });
  assert.equal((await inboxAbout(COORDINATOR, eventId)).length, 2);

  await reassign(eventId, COORDINATOR, COORDINATOR_TWO);

  const previous = await inboxAbout(COORDINATOR, eventId);
  assert.deepEqual(previous.map((n) => [n.type, n.title]), [["ASSIGNMENT_ENDED", "Event assignment ended"]]);
  assert.deepEqual((await inboxAbout(COORDINATOR_TWO, eventId)).map((n) => n.title), ["New event coordination assignment"]);
});

test("[SPM-193-TC-03] unread count and read actions follow the same rule as the list", async () => {
  const eventId = await createEvent();
  const hiddenLater = await notify(eventId, [COORDINATOR]);
  const before = await unread(COORDINATOR);
  await reassign(eventId, COORDINATOR, COORDINATOR_TWO);
  // The hidden notice leaves the count; the ended notice joins it.
  assert.equal(await unread(COORDINATOR), before);

  assert.equal((await rows("SELECT * FROM public.mark_notification_read($1, $2)", [COORDINATOR, hiddenLater])).length, 0);
  await one("SELECT public.mark_all_notifications_read($1) AS n", [COORDINATOR]);
  assert.equal(await unread(COORDINATOR), 0);
  const stored = await one(
    "SELECT is_read FROM public.notification_recipient WHERE notification_id = $1 AND recipient_id = $2",
    [hiddenLater, COORDINATOR]
  );
  assert.equal(stored.is_read, false, "mark-all must not touch notices the coordinator can no longer see");
});

test("[SPM-193-TC-13] a coordinator never sees notices about an event not assigned to them", async () => {
  const eventId = await createEvent();
  // Addressed to D by mistake: still hidden, and cannot be marked read.
  const misaddressed = await notify(eventId, [COORDINATOR, OTHER_COORDINATOR]);
  assert.equal((await inboxAbout(OTHER_COORDINATOR, eventId)).length, 0);
  assert.equal((await rows("SELECT * FROM public.mark_notification_read($1, $2)", [OTHER_COORDINATOR, misaddressed])).length, 0);
  assert.equal((await inboxAbout(COORDINATOR, eventId)).length, 1);
});

test("[SPM-193-AC10] reassigned back, the coordinator sees the event's notices again; notices without an event stay hidden", async () => {
  const eventId = await createEvent();
  await notify(eventId, [COORDINATOR], { title: "Before reassignment" });
  await reassign(eventId, COORDINATOR, COORDINATOR_TWO);
  await reassign(eventId, COORDINATOR_TWO, COORDINATOR);
  const titles = (await inboxAbout(COORDINATOR, eventId)).map((n) => n.title).sort();
  assert.deepEqual(titles, ["Before reassignment", "Event assignment ended", "New event coordination assignment"]);

  const before = (await inbox(COORDINATOR)).length;
  await notify(null, [COORDINATOR]);
  await notify(null, [COORDINATOR], { type: "ASSIGNMENT_ENDED" });
  assert.equal((await inbox(COORDINATOR)).length, before);
});

test("[SPM-193-AC10] attendee and organiser rules are unchanged; a Lead's inbox is closed by the route, not here", async () => {
  const eventId = await createEvent({ status: "CONFIRMED" });
  await notify(eventId, [OWNER, ATTENDEE, LEAD]);
  assert.equal((await inboxAbout(OWNER, eventId)).length, 1);
  assert.equal((await inboxAbout(ATTENDEE, eventId)).length, 0, "no registration, no notice");
  await db.query("INSERT INTO public.registration (attendee_id, event_id) VALUES ($1, $2)", [ATTENDEE, eventId]);
  assert.equal((await inboxAbout(ATTENDEE, eventId)).length, 1);
  assert.equal((await inboxAbout(LEAD, eventId)).length, 1);
});

// ---------- helpers for missing triggers (AC5, AC6, AC8, AC12) ----------

test("[SPM-193-TC-10] a hold warns its coordinator once, again after an extension, and once at expiry", async () => {
  const eventId = await createEvent();
  const expiresAt = "2027-05-01T02:00:00Z";
  await run(eventId, "hold_expiring", { hold: "6720aa01b2c3d4e5f6a7b8c9", venue: VENUE, expiresAt });
  await run(eventId, "hold_expiring", { hold: "6720aa01b2c3d4e5f6a7b8c9", venue: VENUE, expiresAt });
  let notices = await eventNotifications(eventId);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].recipients, [COORDINATOR]);
  assert.equal(notices[0].type, "BOOKING_UPDATE");
  assert.equal(notices[0].title, "Venue hold expiring");
  assert.ok(notices[0].message.includes("Synthetic Hall") && notices[0].message.includes(requestId(eventId)));
  assert.ok(notices[0].message.includes("Sat 1 May 2027, 10:00 AM SGT"));

  await run(eventId, "hold_expiring", { hold: "6720aa01b2c3d4e5f6a7b8c9", venue: VENUE, expiresAt: "2027-05-08T02:00:00Z" });
  await run(eventId, "hold_expired", { hold: "6720aa01b2c3d4e5f6a7b8c9", venue: VENUE });
  await run(eventId, "hold_expired", { hold: "6720aa01b2c3d4e5f6a7b8c9", venue: VENUE });
  notices = await eventNotifications(eventId);
  assert.deepEqual(notices.map((n) => n.title), ["Venue hold expiring", "Venue hold expiring", "Venue hold expired"]);
  assert.equal(notices[2].action_key, "HOLD_EXPIRED:6720aa01b2c3d4e5f6a7b8c9");
});

test("[SPM-193-TC-10] hold notices refuse an unusable hold ID or a missing expiry, and an unknown venue", async () => {
  const eventId = await createEvent();
  await rejects(run(eventId, "hold_expired", { hold: "bad id!", venue: VENUE }), "INVALID_HOLD_ID");
  await rejects(run(eventId, "hold_expiring", { hold: "h1", venue: VENUE, expiresAt: null }), "HOLD_EXPIRY_REQUIRED");
  await rejects(run(eventId, "hold_expired", { hold: "h1", venue: 999 }), "VENUE_NOT_FOUND");
  assert.equal((await eventNotifications(eventId)).length, 0);
});

test("[SPM-193-TC-06] a venue block tells the coordinator an alternative venue is required, once per event", async () => {
  const eventId = await createEvent();
  const args = { block: "blk-6720aa01", venue: VENUE, reason: "EQUIPMENT_FAILURE" };
  await run(eventId, "venue_blocked", args);
  await run(eventId, "venue_blocked", args);
  const notices = await eventNotifications(eventId);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "Alternative venue required");
  assert.deepEqual(notices[0].recipients, [COORDINATOR]);
  assert.ok(notices[0].message.includes("Synthetic Hall is blocked (equipment failure)"));
  assert.equal(notices[0].action_key, `VENUE_BLOCKED:blk-6720aa01:${eventId}:COORDINATOR`);
  await rejects(run(eventId, "venue_blocked", { ...args, reason: "WEATHER" }), "INVALID_BLOCK_REASON");
});

test("[SPM-193-TC-07] technical decisions reach the coordinator; a rejection carries its reason", async () => {
  const approved = await createEvent();
  await run(approved, "technical", { request: "41", decision: "APPROVED" });
  const [approval] = await eventNotifications(approved);
  assert.equal(approval.title, "Technical request approved");
  assert.equal(approval.type, "EQUIPMENT_UPDATE");
  assert.deepEqual(approval.recipients, [COORDINATOR]);

  const rejected = await createEvent();
  await rejects(run(rejected, "technical", { request: "42", decision: "REJECTED", reason: "  " }), "REJECTION_REASON_REQUIRED");
  await run(rejected, "technical", { request: "42", decision: "REJECTED", reason: "Projector unavailable" });
  await run(rejected, "technical", { request: "42", decision: "REJECTED", reason: "Projector unavailable" });
  const notices = await eventNotifications(rejected);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "Technical request rejected");
  assert.ok(notices[0].message.includes("Reason: Projector unavailable."));
  assert.equal(notices[0].action_key, "TECHNICAL_REQUEST_REJECTED:42:COORDINATOR");
  await rejects(run(rejected, "technical", { request: "43", decision: "PARTIAL" }), "INVALID_TECHNICAL_DECISION");
});

test("[SPM-193-AC12] a failed action leaves no notice, and a retried one leaves one", async () => {
  const eventId = await createEvent();
  const args = { request: "50", decision: "APPROVED" };
  await assert.rejects(run(eventId, "technical", args, "spm193-retry-1", true), /LATER_STEP_FAILED/);
  assert.equal((await eventNotifications(eventId)).length, 0);

  await run(eventId, "technical", args, "spm193-retry-1");
  await run(eventId, "technical", args, "spm193-retry-1");
  assert.equal((await eventNotifications(eventId)).length, 1);
});

test("[SPM-193-AC10] helpers address the current coordinator only, and nobody when unassigned or inactive", async () => {
  const eventId = await createEvent();
  await reassign(eventId, COORDINATOR, COORDINATOR_TWO);
  await run(eventId, "hold_expired", { hold: "h-current", venue: VENUE });
  const [notice] = (await eventNotifications(eventId)).filter((n) => n.title === "Venue hold expired");
  assert.deepEqual(notice.recipients, [COORDINATOR_TWO]);

  for (const coordinatorId of [null, INACTIVE_COORDINATOR]) {
    const other = await createEvent({ coordinatorId, status: coordinatorId ? "PLANNING" : "SUBMITTED" });
    await run(other, "hold_expired", { hold: `h-${other}`, venue: VENUE });
    assert.equal((await eventNotifications(other)).length, 0);
  }
  await rejects(run(999999, "hold_expired", { hold: "h-missing", venue: VENUE }), "EVENT_NOT_FOUND");
});
