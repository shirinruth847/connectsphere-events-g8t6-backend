// SPM-155 notification functions (Master v1.1 sections 6.2, 7.1 and 8) on an
// isolated in-memory PostgreSQL engine. No hosted database, Auth or network.
// See docs/test-plans/spm-155.md.
//
// Registration, waitlist, offer and cancellation workflows belong to other
// tickets. The spm155_test_* functions below stand in for them here only: they
// exist in this engine, never in a migration or route, and call the real
// notification functions the way those tickets must.
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

const ATTENDEE = 1;
const OTHER_ATTENDEE = 2;
const WAITLISTED_ATTENDEE = 3;
const INACTIVE_ATTENDEE = 4;
const ORGANISER = 5;
const LATE_ATTENDEE = 6;

let db;
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const rows = async (sql, values = []) => (await db.query(sql, values)).rows;

const createEvent = async ({ title = "Synthetic Forum", status = "CONFIRMED", startsIn = "7 days", start = null } = {}) =>
  (await one(
    `INSERT INTO public.event (organiser_id, title, status, start_datetime, end_datetime)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now() + $5::interval), COALESCE($4::timestamptz, now() + $5::interval) + interval '2 hours')
     RETURNING event_id`,
    [ORGANISER, title, status, start, startsIn]
  )).event_id;

const register = async (attendeeId, eventId, status = "REGISTERED", registeredAgo = "3 days") =>
  (await one(
    `INSERT INTO public.registration (attendee_id, event_id, registration_status, registration_datetime)
     VALUES ($1, $2, $3, now() - $4::interval) RETURNING registration_id`,
    [attendeeId, eventId, status, registeredAgo]
  )).registration_id;

const eventNotifications = (eventId) =>
  rows(
    `SELECT n.*, array_agg(nr.recipient_id ORDER BY nr.recipient_id) AS recipients
       FROM public.notification AS n JOIN public.notification_recipient AS nr USING (notification_id)
      WHERE n.event_id = $1 GROUP BY n.notification_id ORDER BY n.notification_id`,
    [eventId]
  );

const inbox = async (userId, limit = 100, before = null) =>
  rows("SELECT * FROM public.list_notifications($1, $2, $3, $4)", [userId, limit, before?.created_at ?? null, before?.notification_id ?? null]);
const unread = async (userId) => (await one("SELECT public.count_unread_notifications($1) AS n", [userId])).n;
const sendReminders = async (limit = 50) => (await one("SELECT public.send_due_event_reminders($1) AS n", [limit])).n;

let legacyNotificationId;

before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm155DatabaseSchema.sql"), "utf8"));
  await db.exec(`INSERT INTO public."user" (user_id, email, name, role, is_active) VALUES
    (1, 'spm155-1@connectsphere.test', 'Attendee A', 'ATTENDEE', true),
    (2, 'spm155-2@connectsphere.test', 'Attendee B', 'ATTENDEE', true),
    (3, 'spm155-3@connectsphere.test', 'Waitlisted Attendee', 'ATTENDEE', true),
    (4, 'spm155-4@connectsphere.test', 'Inactive Attendee', 'ATTENDEE', false),
    (5, 'spm155-5@connectsphere.test', 'Organiser', 'ORGANISER', true),
    (6, 'spm155-6@connectsphere.test', 'Late Attendee', 'ATTENDEE', true)`);

  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(functionSql(idempotency, "_claim_idempotency_key") + functionSql(idempotency, "_store_idempotent_response"));
  // SPM-173's four-argument helper exactly as it is live (applied from
  // 20261019075510_spm173_lifecycle_transitions.sql, not on this branch yet).
  await db.exec(`CREATE FUNCTION public._notify_event_users(p_event_id integer, p_title text, p_message text, p_recipients integer[])
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    DECLARE v_notification_id integer;
    BEGIN
      IF p_recipients IS NULL OR cardinality(p_recipients) = 0 THEN RETURN; END IF;
      INSERT INTO public.notification (event_id, title, message, type) VALUES (p_event_id, p_title, p_message, 'STATUS_CHANGE')
      RETURNING notification_id INTO v_notification_id;
      INSERT INTO public.notification_recipient (notification_id, recipient_id)
      SELECT DISTINCT v_notification_id, recipient_id FROM unnest(p_recipients) AS recipient_id;
    END; $$;`);

  await db.exec(read("20261020161808_spm155_notification_types.sql"));
  // A row written before the foundation migration, to prove it is left alone.
  const legacyEvent = await createEvent({ title: "Legacy" });
  legacyNotificationId = (await one(
    "INSERT INTO public.notification (event_id, title, message, type, created_at) VALUES ($1, 'Old', 'Old message', 'STATUS_CHANGE', '2026-10-01T00:00:00Z') RETURNING notification_id",
    [legacyEvent]
  )).notification_id;
  await db.query("INSERT INTO public.notification_recipient (notification_id, recipient_id, is_read, read_at) VALUES ($1, $2, true, '2026-10-02T00:00:00Z')", [legacyNotificationId, ORGANISER]);

  await db.exec(read("20261020161837_spm156_notification_foundation.sql"));
  await db.exec(read("20261020161912_spm155_attendee_notifications.sql"));
  await db.exec(read("20261020161924_spm158_event_reminders.sql"));

  // Stand-in for SPM-134/SPM-163 registration: idempotent, capacity-checked,
  // notification in the same transaction. p_outcome FULL refuses before any
  // write; p_fail_after_notify fails after the notification was written.
  await db.exec(`CREATE FUNCTION public.spm155_test_register(
      p_attendee_id integer, p_event_id integer, p_outcome text, p_key text, p_fail_after_notify boolean DEFAULT false)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE v_replay jsonb; v_registration_id integer;
    BEGIN
      IF p_key IS NOT NULL THEN
        v_replay := public._claim_idempotency_key(p_attendee_id, 'test.register', p_key, repeat('a', 64));
        IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
      END IF;
      PERFORM 1 FROM public.event WHERE event_id = p_event_id FOR UPDATE;
      IF p_outcome = 'FULL' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EVENT_FULL';
      END IF;
      INSERT INTO public.registration (attendee_id, event_id, registration_status)
      VALUES (p_attendee_id, p_event_id, p_outcome::public.registration_status)
      RETURNING registration_id INTO v_registration_id;
      PERFORM public._notify_registration_recorded(v_registration_id);
      IF p_fail_after_notify THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LATER_STEP_FAILED';
      END IF;
      RETURN public._store_idempotent_response(p_attendee_id, 'test.register', p_key, jsonb_build_object('registration_id', v_registration_id));
    END; $$;`);
  // Stand-in for the cancellation ticket: notify, then close by event state.
  await db.exec(`CREATE FUNCTION public.spm155_test_cancel(p_event_id integer)
    RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM public.event WHERE event_id = p_event_id FOR UPDATE;
      PERFORM public._notify_event_cancelled_attendees(p_event_id);
      UPDATE public.event SET status = 'CANCELLED', version = version + 1 WHERE event_id = p_event_id;
    END; $$;`);
});
after(async () => { if (db) await db.close(); });

test("[SPM-156] the migrations leave existing notifications and SPM-173's helper unchanged", async () => {
  const legacy = await one("SELECT n.*, nr.is_read, nr.read_at FROM public.notification n JOIN public.notification_recipient nr USING (notification_id) WHERE notification_id = $1", [legacyNotificationId]);
  assert.equal(legacy.title, "Old");
  assert.equal(legacy.type, "STATUS_CHANGE");
  assert.equal(legacy.action_key, null);
  assert.equal(legacy.action_expires_at, null);
  assert.equal(legacy.is_read, true);
  assert.equal(new Date(legacy.read_at).toISOString(), "2026-10-02T00:00:00.000Z");

  // Both overloads resolve; keyless rows never collide with each other.
  const eventId = await createEvent();
  await db.query("SELECT public._notify_event_users($1, 'Four', 'Four-argument call', ARRAY[$2]::integer[])", [eventId, ORGANISER]);
  await db.query("SELECT public._notify_event_users($1, 'Four', 'Four-argument call', ARRAY[$2]::integer[])", [eventId, ORGANISER]);
  const seven = await one("SELECT public._notify_event_users($1, 'Seven', 'Keyed', ARRAY[$2]::integer[], 'STATUS_CHANGE', NULL, NULL) AS id", [eventId, ORGANISER]);
  assert.ok(seven.id);
  assert.equal((await eventNotifications(eventId)).length, 3);
});

test("[SPM-156] the shared helper writes one keyed notification and skips repeats and empty audiences", async () => {
  const eventId = await createEvent();
  const call = (key, recipients) =>
    one("SELECT public._notify_event_users($1, 'Title', 'Message', $2::integer[], 'STATUS_CHANGE', $3, NULL) AS id", [eventId, recipients, key]);
  const first = await call("TEST:helper:1", [ORGANISER, ORGANISER, null]);
  assert.ok(first.id);
  assert.equal((await call("TEST:helper:1", [ORGANISER])).id, null);
  assert.equal((await call("TEST:helper:2", [])).id, null);
  assert.equal((await call("TEST:helper:3", [null])).id, null);
  const written = await eventNotifications(eventId);
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].recipients, [ORGANISER]);
  await assert.rejects(call("not a key", [ORGANISER]), /notification_action_key_format/);
});

test("[SPM-155-TC-01] registering creates one unread Registration confirmed notification for that attendee", async () => {
  const eventId = await createEvent({ title: "Data Forum", start: "2026-12-01T02:00:00Z" });
  await db.query("SELECT public.spm155_test_register($1, $2, 'REGISTERED', 'tc01-key-0001')", [ATTENDEE, eventId]);
  const [notice] = await eventNotifications(eventId);
  assert.equal(notice.type, "REGISTRATION_CONFIRMED");
  assert.equal(notice.title, "Registration confirmed");
  assert.equal(notice.message, "You're registered for \"Data Forum\" on Tue 1 Dec 2026, 10:00 AM SGT.");
  assert.deepEqual(notice.recipients, [ATTENDEE]);
  assert.match(notice.action_key, /^REGISTRATION:\d+:REGISTERED:\d+$/);
  const [item] = (await inbox(ATTENDEE)).filter((row) => row.event_id === eventId);
  assert.equal(item.is_read, false);
  assert.equal(item.event_title, "Data Forum");
});

test("[SPM-155-TC-02] joining the waitlist creates a Waitlisted notification, not a registration one", async () => {
  const eventId = await createEvent({ title: "Full Forum" });
  await db.query("SELECT public.spm155_test_register($1, $2, 'WAITLISTED', 'tc02-key-0001')", [ATTENDEE, eventId]);
  const notices = await eventNotifications(eventId);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "WAITLIST_JOINED");
  assert.equal(notices[0].title, "Waitlisted");
  assert.match(notices[0].message, /on the waitlist/);
  assert.doesNotMatch(notices[0].message, /registered/i);
});

test("[SPM-155-TC-09/AC9] a refused registration and a rolled-back one leave no notification", async () => {
  const eventId = await createEvent();
  await assert.rejects(db.query("SELECT public.spm155_test_register($1, $2, 'FULL', 'tc09-key-0001')", [ATTENDEE, eventId]), /EVENT_FULL/);
  await assert.rejects(db.query("SELECT public.spm155_test_register($1, $2, 'REGISTERED', 'tc09-key-0002', true)", [ATTENDEE, eventId]), /LATER_STEP_FAILED/);
  assert.equal((await eventNotifications(eventId)).length, 0);
  assert.equal((await rows("SELECT 1 FROM public.registration WHERE event_id = $1", [eventId])).length, 0);
});

test("[SPM-155-TC-10/AC9] a retried registration request and a repeated notify call create one notification", async () => {
  const eventId = await createEvent();
  const first = (await one("SELECT public.spm155_test_register($1, $2, 'REGISTERED', 'tc10-key-0001') AS r", [ATTENDEE, eventId])).r;
  const retry = (await one("SELECT public.spm155_test_register($1, $2, 'REGISTERED', 'tc10-key-0001') AS r", [ATTENDEE, eventId])).r;
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(retry.registration_id, first.registration_id);
  assert.equal((await one("SELECT public._notify_registration_recorded($1) AS id", [first.registration_id])).id, null);
  assert.equal((await eventNotifications(eventId)).length, 1);
});

test("[SPM-155-AC1] re-entry after withdrawal is a new action; withdrawn registrations are refused", async () => {
  const eventId = await createEvent();
  const registrationId = await register(ATTENDEE, eventId);
  await db.query("SELECT public._notify_registration_recorded($1)", [registrationId]);
  await db.query("UPDATE public.registration SET registration_status = 'WITHDRAWN', withdrawal_date = now() WHERE registration_id = $1", [registrationId]);
  await assert.rejects(db.query("SELECT public._notify_registration_recorded($1)", [registrationId]), /REGISTRATION_NOT_ACTIVE/);
  await db.query("UPDATE public.registration SET registration_status = 'REGISTERED', registration_datetime = now() WHERE registration_id = $1", [registrationId]);
  await db.query("SELECT public._notify_registration_recorded($1)", [registrationId]);
  assert.equal((await eventNotifications(eventId)).length, 2);
  await assert.rejects(db.query("SELECT public._notify_registration_recorded(999999)"), /REGISTRATION_NOT_FOUND/);
});

test("[SPM-155-TC-03/AC2] cancellation notifies active registered and waitlisted attendees once", async () => {
  const eventId = await createEvent({ title: "Cancelled Forum", start: "2026-12-01T02:00:00Z" });
  await register(ATTENDEE, eventId);
  await register(WAITLISTED_ATTENDEE, eventId, "WAITLISTED");
  await register(OTHER_ATTENDEE, eventId, "WITHDRAWN");
  await register(INACTIVE_ATTENDEE, eventId);
  await db.query("SELECT public.spm155_test_cancel($1)", [eventId]);
  assert.equal((await one("SELECT public._notify_event_cancelled_attendees($1) AS id", [eventId])).id, null);

  const notices = await eventNotifications(eventId);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "EVENT_CANCELLED");
  assert.equal(notices[0].message, "\"Cancelled Forum\", scheduled for Tue 1 Dec 2026, 10:00 AM SGT, has been cancelled.");
  assert.deepEqual(notices[0].recipients, [ATTENDEE, WAITLISTED_ATTENDEE]);
  // The event's CANCELLED state closes the registrations, so the notice stays visible.
  assert.equal((await inbox(WAITLISTED_ATTENDEE)).filter((row) => row.event_id === eventId).length, 1);
  await assert.rejects(db.query("SELECT public._notify_event_cancelled_attendees(999999)"), /EVENT_NOT_FOUND/);
});

test("[SPM-155-TC-04/AC3] a place offer says action is required and carries its expiry", async () => {
  const eventId = await createEvent({ title: "Popular Forum" });
  const waitlisted = await register(ATTENDEE, eventId, "WAITLISTED");
  const registered = await register(OTHER_ATTENDEE, eventId);
  const expiresAt = "2026-12-03T04:00:00Z";
  const offer = (id, offerId, at) => one("SELECT public._notify_place_offered($1, $2, $3::timestamptz) AS id", [id, offerId, at]);

  assert.ok((await offer(waitlisted, 501, expiresAt)).id);
  assert.equal((await offer(waitlisted, 501, expiresAt)).id, null);
  await assert.rejects(offer(waitlisted, 502, "2020-01-01T00:00:00Z"), /OFFER_EXPIRY_INVALID/);
  await assert.rejects(offer(waitlisted, 0, expiresAt), /OFFER_ID_INVALID/);
  await assert.rejects(offer(registered, 503, expiresAt), /REGISTRATION_NOT_WAITLISTED/);

  const [notice] = await eventNotifications(eventId);
  assert.equal(notice.type, "WAITLIST_OFFER");
  assert.equal(notice.title, "Action required: a place is available");
  assert.equal(
    notice.message,
    "A place is available for \"Popular Forum\". Accept or decline it by Thu 3 Dec 2026, 12:00 PM SGT, or it will be offered to the next person."
  );
  assert.equal(new Date(notice.action_expires_at).toISOString(), "2026-12-03T04:00:00.000Z");
  assert.equal(notice.action_key, "WAITLIST_OFFER:501");
  const [item] = (await inbox(ATTENDEE)).filter((row) => row.event_id === eventId);
  assert.equal(new Date(item.action_expires_at).toISOString(), "2026-12-03T04:00:00.000Z");
});

test("[SPM-155-TC-06/AC5] a changed confirmation tells registered and waitlisted attendees what changed, once per version", async () => {
  const eventId = await createEvent({ title: "Moved Forum" });
  await register(ATTENDEE, eventId);
  await register(WAITLISTED_ATTENDEE, eventId, "WAITLISTED");
  await register(OTHER_ATTENDEE, eventId, "WITHDRAWN");
  const snapshot = (start, venue, capacity = 100) => JSON.stringify({
    title: "Moved Forum", start_datetime: start, end_datetime: start, registration_capacity: capacity,
    primary_venue: venue ? { venue_id: venue, name: `Hall ${venue}` } : null,
  });
  const changed = (previous, current) => one("SELECT public._notify_event_changed_attendees($1, $2::jsonb, $3::jsonb) AS id", [eventId, previous, current]);
  const bump = () => db.query("UPDATE public.event SET version = version + 1 WHERE event_id = $1", [eventId]);

  assert.equal((await changed(null, snapshot("2026-12-01T02:00:00Z", 1))).id, null);
  assert.equal((await changed(snapshot("2026-12-01T02:00:00Z", 1), snapshot("2026-12-01T02:00:00Z", 1))).id, null);
  assert.ok((await changed(snapshot("2026-12-01T02:00:00Z", 1), snapshot("2026-12-02T02:00:00Z", 1))).id);
  assert.equal((await changed(snapshot("2026-12-01T02:00:00Z", 1), snapshot("2026-12-02T02:00:00Z", 1))).id, null);
  await bump();
  await changed(snapshot("2026-12-02T02:00:00Z", 1), snapshot("2026-12-02T02:00:00Z", 2));
  await bump();
  await changed(snapshot("2026-12-02T02:00:00Z", 2), snapshot("2026-12-03T02:00:00Z", 3));
  await bump();
  await changed(snapshot("2026-12-03T02:00:00Z", 3), snapshot("2026-12-03T02:00:00Z", 3, 120));

  const notices = await eventNotifications(eventId);
  assert.deepEqual(notices.map((notice) => notice.message), [
    "The date and time for \"Moved Forum\" changed. Open My Events to see the latest information.",
    "The venue for \"Moved Forum\" changed. Open My Events to see the latest information.",
    "The date and time and venue for \"Moved Forum\" changed. Open My Events to see the latest information.",
    "The details for \"Moved Forum\" changed. Open My Events to see the latest information.",
  ]);
  for (const notice of notices) {
    assert.equal(notice.type, "EVENT_CHANGED");
    assert.deepEqual(notice.recipients, [ATTENDEE, WAITLISTED_ATTENDEE]);
  }
});

test("[SPM-155-TC-07/AC6] attendees never see notifications for events they hold no place on", async () => {
  const theirs = await createEvent({ title: "Their Event" });
  const others = await createEvent({ title: "Other Event" });
  const left = await createEvent({ title: "Left Event" });
  await register(ATTENDEE, theirs);
  await register(OTHER_ATTENDEE, others);
  const leftRegistration = await register(ATTENDEE, left);
  await db.query("SELECT public._notify_event_users($1, 'Other', 'For others', ARRAY[$2]::integer[], 'STATUS_CHANGE', NULL, NULL)", [others, OTHER_ATTENDEE]);
  const hidden = (await one("SELECT public._notify_event_users($1, 'Left', 'Before leaving', ARRAY[$2]::integer[], 'STATUS_CHANGE', NULL, NULL) AS id", [left, ATTENDEE])).id;
  const noEvent = (await one("SELECT public._notify_event_users(NULL, 'No event', 'Account notice', ARRAY[$1]::integer[], 'STATUS_CHANGE', NULL, NULL) AS id", [ATTENDEE])).id;
  await db.query("SELECT public._notify_event_users($1, 'Theirs', 'Visible', ARRAY[$2]::integer[], 'STATUS_CHANGE', NULL, NULL)", [theirs, ATTENDEE]);
  await db.query("UPDATE public.registration SET registration_status = 'WITHDRAWN' WHERE registration_id = $1", [leftRegistration]);

  const visibleEvents = (await inbox(ATTENDEE)).map((row) => row.event_id);
  assert.ok(visibleEvents.includes(theirs));
  assert.ok(!visibleEvents.includes(others));
  assert.ok(!visibleEvents.includes(left));
  assert.ok(!visibleEvents.includes(null));

  const before = await unread(ATTENDEE);
  assert.equal((await rows("SELECT * FROM public.mark_notification_read($1, $2)", [ATTENDEE, hidden])).length, 0);
  assert.equal((await rows("SELECT * FROM public.mark_notification_read($1, $2)", [OTHER_ATTENDEE, hidden])).length, 0);
  await db.query("SELECT public.mark_all_notifications_read($1)", [ATTENDEE]);
  const untouched = await rows("SELECT is_read FROM public.notification_recipient WHERE notification_id = ANY($1::integer[])", [[hidden, noEvent]]);
  assert.deepEqual(untouched.map((row) => row.is_read), [false, false]);
  assert.ok(before > 0);
  assert.equal(await unread(ATTENDEE), 0);

  // Other roles keep every notification addressed to them until their tickets add a rule.
  assert.ok((await inbox(ORGANISER)).some((row) => row.notification_id === legacyNotificationId));
});

test("[SPM-155-TC-08/AC8] marking one and then all as read moves the unread count 3, 2, 0", async () => {
  const userId = OTHER_ATTENDEE;
  await db.query("SELECT public.mark_all_notifications_read($1)", [userId]);
  const eventId = await createEvent();
  await register(userId, eventId);
  const ids = [];
  for (const n of [1, 2, 3]) {
    ids.push((await one(`SELECT public._notify_event_users($1, 'N${n}', 'Message', ARRAY[$2]::integer[], 'STATUS_CHANGE', 'TEST:tc08:${n}', NULL) AS id`, [eventId, userId])).id);
  }
  assert.equal(await unread(userId), 3);
  const [marked] = await rows("SELECT * FROM public.mark_notification_read($1, $2)", [userId, ids[1]]);
  assert.equal(marked.is_read, true);
  assert.ok(marked.read_at);
  assert.equal(await unread(userId), 2);
  const [again] = await rows("SELECT * FROM public.mark_notification_read($1, $2)", [userId, ids[1]]);
  assert.equal(new Date(again.read_at).getTime(), new Date(marked.read_at).getTime());
  assert.equal((await one("SELECT public.mark_all_notifications_read($1) AS n", [userId])).n, 2);
  assert.equal(await unread(userId), 0);
  assert.equal((await one("SELECT public.mark_all_notifications_read($1) AS n", [userId])).n, 0);
});

test("[SPM-155-AC8] the inbox is newest first and pages without gaps, including equal timestamps", async () => {
  const userId = LATE_ATTENDEE;
  const eventId = await createEvent();
  await register(userId, eventId);
  // One statement, so every row shares created_at and only the ID orders them.
  await db.query(`SELECT public._notify_event_users($1, 'Same ' || g, 'Message', ARRAY[$2]::integer[], 'STATUS_CHANGE', 'TEST:paging:' || g, NULL) FROM generate_series(1, 5) AS g`, [eventId, userId]);
  await db.query(`INSERT INTO public.notification (event_id, title, message, type, created_at) VALUES ($1, 'Older', 'Message', 'STATUS_CHANGE', now() - interval '1 day')`, [eventId]);
  await db.query(`INSERT INTO public.notification_recipient (notification_id, recipient_id) SELECT max(notification_id), $1 FROM public.notification`, [userId]);

  const all = await inbox(userId);
  assert.deepEqual(all.map((row) => row.title), ["Same 5", "Same 4", "Same 3", "Same 2", "Same 1", "Older"]);
  const seen = [];
  let page = await inbox(userId, 2);
  while (page.length) {
    seen.push(...page.map((row) => row.notification_id));
    page = await inbox(userId, 2, page[page.length - 1]);
  }
  assert.deepEqual(seen, all.map((row) => row.notification_id));
  assert.equal((await inbox(userId, 1000)).length, 6);
  assert.equal((await inbox(INACTIVE_ATTENDEE)).length, 0);
});

test("[SPM-155-TC-11/AC7] the reminder job sends one reminder per registered attendee, once", async () => {
  // Drain anything due from earlier tests so counts below are this test's only.
  while ((await sendReminders()) > 0);
  const due = await createEvent({ title: "Tomorrow Forum", startsIn: "23 hours" });
  await register(ATTENDEE, due);
  await register(OTHER_ATTENDEE, due);
  await register(WAITLISTED_ATTENDEE, due, "WAITLISTED");
  await register(INACTIVE_ATTENDEE, due);
  // Registered 23h10m before the start (23h40m after the reschedule below): no reminder.
  await register(LATE_ATTENDEE, due, "REGISTERED", "10 minutes");
  const later = await createEvent({ startsIn: "25 hours" });
  await register(ATTENDEE, later);
  const planning = await createEvent({ status: "PLANNING", startsIn: "20 hours" });
  await register(ATTENDEE, planning);
  const started = await createEvent({ startsIn: "-1 hour" });
  await register(ATTENDEE, started);

  assert.equal(await sendReminders(1), 1);
  assert.equal(await sendReminders(), 1);
  assert.equal(await sendReminders(), 0);

  const notices = await eventNotifications(due);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices.map((notice) => notice.recipients[0]).sort(), [ATTENDEE, OTHER_ATTENDEE]);
  assert.equal(notices[0].type, "EVENT_REMINDER");
  assert.equal(notices[0].title, "Event reminder");
  assert.match(notices[0].message, /^Reminder: "Tomorrow Forum" starts \w{3} \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} [AP]M SGT\.$/);
  for (const other of [later, planning, started]) assert.equal((await eventNotifications(other)).length, 0);

  // Rescheduled within the window: one more reminder for the new time.
  await db.query("UPDATE public.event SET start_datetime = start_datetime + interval '30 minutes' WHERE event_id = $1", [due]);
  assert.equal(await sendReminders(), 2);
  assert.equal(await sendReminders(), 0);
  await assert.rejects(sendReminders(0), /INVALID_LIMIT/);
  await assert.rejects(sendReminders(501), /INVALID_LIMIT/);
});

test("[SPM-156] only the service role can call the inbox and reminder functions; helpers stay private", async () => {
  const can = async (role, signature) =>
    (await one("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, signature])).ok;
  const publicFunctions = [
    "public.list_notifications(integer, integer, timestamptz, integer)",
    "public.count_unread_notifications(integer)",
    "public.mark_notification_read(integer, integer)",
    "public.mark_all_notifications_read(integer)",
    "public.send_due_event_reminders(integer)",
  ];
  const privateFunctions = [
    "public._notify_event_users(integer, text, text, integer[], public.notification_type, text, timestamptz)",
    "public._notification_visible(integer, public.user_role, integer)",
    "public._notification_key_time(timestamptz)",
    "public._attendee_datetime_text(timestamptz)",
    "public._event_attendee_recipients(integer)",
    "public._notify_registration_recorded(integer)",
    "public._notify_place_offered(integer, bigint, timestamptz)",
    "public._notify_event_cancelled_attendees(integer)",
    "public._notify_event_changed_attendees(integer, jsonb, jsonb)",
  ];
  for (const signature of publicFunctions) {
    assert.equal(await can("service_role", signature), true, signature);
    assert.equal(await can("anon", signature), false, signature);
    assert.equal(await can("authenticated", signature), false, signature);
  }
  for (const signature of privateFunctions) {
    for (const role of ["service_role", "anon", "authenticated"]) assert.equal(await can(role, signature), false, `${role} ${signature}`);
  }
});
