// SPM-192 organiser notifications (Master 1.5 sections 4.2, 7.1 and 8) on an
// isolated in-memory PostgreSQL engine. No hosted database, Auth or network.
// See docs/test-plans/spm-192.md.
//
// Feasibility acceptance, rejection (SPM-39) and cancellation (SPM-40) do not
// exist yet. The spm192_test_* functions below stand in for them here only:
// they exist in this engine, never in a migration or route, and call the real
// owner-notice helpers the way those tickets must.
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
const SAME_ORG_ORGANISER = 2;
const OTHER_ORGANISER = 3;
const ATTENDEE = 4;
const LEAD = 5;
const INACTIVE_ORGANISER = 6;

let db;
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const rows = async (sql, values = []) => (await db.query(sql, values)).rows;

const createEvent = async ({ organiserId = OWNER, title = "Synthetic Showcase", status = "UNDER_REVIEW" } = {}) =>
  (await one(
    `INSERT INTO public.event (organiser_id, title, status, start_datetime, end_datetime)
     VALUES ($1, $2, $3, now() + interval '30 days', now() + interval '30 days 2 hours') RETURNING event_id`,
    [organiserId, title, status]
  )).event_id;

const statusOf = async (eventId) => (await one("SELECT status::text AS s FROM public.event WHERE event_id = $1", [eventId])).s;

const eventNotifications = (eventId) =>
  rows(
    `SELECT n.*, array_agg(nr.recipient_id ORDER BY nr.recipient_id) AS recipients
       FROM public.notification AS n JOIN public.notification_recipient AS nr USING (notification_id)
      WHERE n.event_id = $1 GROUP BY n.notification_id ORDER BY n.notification_id`,
    [eventId]
  );

const inbox = (userId) => rows("SELECT * FROM public.list_notifications($1, 100, NULL, NULL)", [userId]);
const unread = async (userId) => (await one("SELECT public.count_unread_notifications($1) AS n", [userId])).n;
const requestId = (eventId) => `REQ-${String(eventId).padStart(6, "0")}`;
const rejects = (promise, message) => assert.rejects(promise, (error) => error.message === message);

before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm155DatabaseSchema.sql"), "utf8"));
  await db.exec(`INSERT INTO public."user" (user_id, email, name, role, is_active) VALUES
    (1, 'spm192-1@connectsphere.test', 'Organiser A', 'ORGANISER', true),
    (2, 'spm192-2@connectsphere.test', 'Organiser B', 'ORGANISER', true),
    (3, 'spm192-3@connectsphere.test', 'Organiser D', 'ORGANISER', true),
    (4, 'spm192-4@connectsphere.test', 'Attendee', 'ATTENDEE', true),
    (5, 'spm192-5@connectsphere.test', 'Lead', 'COORDINATOR_LEAD', true),
    (6, 'spm192-6@connectsphere.test', 'Inactive Organiser', 'ORGANISER', false)`);

  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(functionSql(idempotency, "_claim_idempotency_key") + functionSql(idempotency, "_store_idempotent_response"));
  await db.exec(read("20261020161808_spm155_notification_types.sql"));
  await db.exec(read("20261020161837_spm156_notification_foundation.sql"));
  await db.exec(read("20261020161912_spm155_attendee_notifications.sql"));
  await db.exec(read("20261026043658_spm192_organiser_notifications.sql"));

  // Stand-in for an SPM-39/SPM-40 action: idempotent, locks the event, changes
  // its state, notifies in the same transaction. p_fail_after_notify fails
  // after the notice was written, as a later step of the real action could.
  await db.exec(`CREATE FUNCTION public.spm192_test_decide(
      p_event_id integer, p_action text, p_reason text, p_key text, p_fail_after_notify boolean DEFAULT false)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE v_replay jsonb; v_event public.event;
    BEGIN
      IF p_key IS NOT NULL THEN
        v_replay := public._claim_idempotency_key(1, 'test.' || p_action, p_key, repeat('a', 64));
        IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
      END IF;
      SELECT * INTO v_event FROM public.event WHERE event_id = p_event_id FOR UPDATE;
      IF p_action = 'accept_feasibility' THEN
        IF v_event.status <> 'UNDER_REVIEW' THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
        UPDATE public.event SET status = 'PLANNING' WHERE event_id = p_event_id;
        PERFORM public._notify_feasibility_accepted(p_event_id);
      ELSIF p_action = 'reject' THEN
        IF v_event.status NOT IN ('UNDER_REVIEW', 'PLANNING') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
        UPDATE public.event SET status = 'REJECTED' WHERE event_id = p_event_id;
        PERFORM public._notify_event_rejected_owner(p_event_id, p_reason);
      ELSIF p_action = 'cancel' THEN
        IF v_event.status IN ('CANCELLED', 'REJECTED', 'COMPLETED') THEN RAISE EXCEPTION 'INVALID_TRANSITION'; END IF;
        UPDATE public.event SET status = 'CANCELLED' WHERE event_id = p_event_id;
        PERFORM public._notify_event_cancelled_owner(p_event_id);
        PERFORM public._notify_event_cancelled_attendees(p_event_id);
      END IF;
      IF p_fail_after_notify THEN RAISE EXCEPTION 'LATER_STEP_FAILED'; END IF;
      RETURN public._store_idempotent_response(1, 'test.' || p_action, p_key, jsonb_build_object('event_id', p_event_id));
    END; $$;`);
});

after(async () => {
  await db.close();
});

test("[SPM-192-TC-03] accepting feasibility sends the owner one 'in planning' notice with the request ID", async () => {
  const eventId = await createEvent();
  await db.query("SELECT public.spm192_test_decide($1, 'accept_feasibility', NULL, 'spm192-accept-1')", [eventId]);

  const notices = await eventNotifications(eventId);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].recipients, [OWNER]);
  assert.equal(notices[0].type, "STATUS_CHANGE");
  assert.equal(notices[0].action_key, `FEASIBILITY_ACCEPTED:${eventId}`);
  assert.match(notices[0].title, /in planning/i);
  assert.ok(notices[0].message.includes(requestId(eventId)));
  assert.equal((await inbox(OWNER)).filter((n) => n.event_id === eventId).length, 1);
});

test("[SPM-192-TC-04] rejecting includes the reason in the owner's notice; a blank reason rolls the action back", async () => {
  const eventId = await createEvent();
  await rejects(db.query("SELECT public.spm192_test_decide($1, 'reject', '   ', NULL)", [eventId]), "REJECTION_REASON_REQUIRED");
  assert.equal(await statusOf(eventId), "UNDER_REVIEW");
  assert.equal((await eventNotifications(eventId)).length, 0);

  await db.query("SELECT public.spm192_test_decide($1, 'reject', $2, NULL)", [eventId, "  Venue unavailable for this size.  "]);
  const [notice] = await eventNotifications(eventId);
  assert.deepEqual(notice.recipients, [OWNER]);
  assert.equal(notice.title, "Request rejected");
  assert.ok(notice.message.endsWith("Reason: Venue unavailable for this size."));
  assert.equal(notice.action_key, `EVENT_REJECTED:${eventId}`);
});

test("[SPM-192-TC-08] cancelling notifies the owner and registered attendees separately, each once", async () => {
  const eventId = await createEvent({ status: "CONFIRMED" });
  await db.query("INSERT INTO public.registration (attendee_id, event_id) VALUES ($1, $2)", [ATTENDEE, eventId]);
  await db.query("SELECT public.spm192_test_decide($1, 'cancel', NULL, NULL)", [eventId]);

  const notices = await eventNotifications(eventId);
  assert.deepEqual(notices.map((n) => [n.action_key, n.recipients]), [
    [`EVENT_CANCELLED_OWNER:${eventId}`, [OWNER]],
    [`EVENT_CANCELLED:${eventId}`, [ATTENDEE]],
  ]);
  assert.ok(notices[0].message.includes(requestId(eventId)));
  assert.equal(notices[0].type, "EVENT_CANCELLED");
  // A repeated notice call for the same cancellation writes nothing.
  assert.equal((await one("SELECT public._notify_event_cancelled_owner($1) AS id", [eventId])).id, null);
  assert.equal((await eventNotifications(eventId)).length, 2);
});

test("[SPM-192-AC10] a rolled-back action leaves no notice; a retried one leaves exactly one", async () => {
  const failed = await createEvent();
  await rejects(db.query("SELECT public.spm192_test_decide($1, 'accept_feasibility', NULL, NULL, true)", [failed]), "LATER_STEP_FAILED");
  assert.equal(await statusOf(failed), "UNDER_REVIEW");
  assert.equal((await eventNotifications(failed)).length, 0);

  const retried = await createEvent();
  const first = await one("SELECT public.spm192_test_decide($1, 'accept_feasibility', NULL, 'spm192-retry-1') AS r", [retried]);
  const replay = await one("SELECT public.spm192_test_decide($1, 'accept_feasibility', NULL, 'spm192-retry-1') AS r", [retried]);
  assert.notEqual(first.r.replayed, true);
  assert.equal(replay.r.replayed, true);
  // Even a caller without an idempotency claim cannot notify twice.
  assert.equal((await one("SELECT public._notify_feasibility_accepted($1) AS id", [retried])).id, null);
  assert.equal((await eventNotifications(retried)).length, 1);
});

test("[SPM-192] a notice helper refuses an event not in the state it announces, and skips an inactive owner", async () => {
  const eventId = await createEvent();
  await rejects(db.query("SELECT public._notify_feasibility_accepted($1)", [eventId]), "EVENT_STATUS_MISMATCH");
  await rejects(db.query("SELECT public._notify_event_cancelled_owner($1)", [eventId]), "EVENT_STATUS_MISMATCH");
  await rejects(db.query("SELECT public._notify_event_rejected_owner(999999, 'x')"), "EVENT_NOT_FOUND");

  const inactiveOwners = await createEvent({ organiserId: INACTIVE_ORGANISER, status: "PLANNING" });
  assert.equal((await one("SELECT public._notify_feasibility_accepted($1) AS id", [inactiveOwners])).id, null);
  assert.equal((await eventNotifications(inactiveOwners)).length, 0);
});

test("[SPM-192-TC-10/TC-11/AC8] an organiser sees, counts and marks only notices about events they own", async () => {
  const own = await createEvent({ title: "Owned E1" });
  const others = await createEvent({ organiserId: OTHER_ORGANISER, title: "Other organiser's E3" });
  const ownNotice = (await one(
    "SELECT public._notify_event_users($1, 'Owned', 'Owned notice', ARRAY[$2]::integer[], 'STATUS_CHANGE', $3, NULL) AS id",
    [own, OWNER, `TEST_NOTICE:${own}`]
  )).id;
  // Addressed to organisers who do not own E3, as a faulty writer might.
  const strayNotice = (await one(
    "SELECT public._notify_event_users($1, 'Stray', 'Not yours', ARRAY[$2, $3, $4]::integer[], 'STATUS_CHANGE', $5, NULL) AS id",
    [others, OWNER, SAME_ORG_ORGANISER, OTHER_ORGANISER, `TEST_NOTICE:${others}`]
  )).id;
  const noEvent = (await one(
    "SELECT public._notify_event_users(NULL, 'Detached', 'No event', ARRAY[$1]::integer[], 'STATUS_CHANGE', 'TEST_NOTICE:detached', NULL) AS id",
    [OWNER]
  )).id;

  const ownerIds = (await inbox(OWNER)).map((n) => n.notification_id);
  assert.ok(ownerIds.includes(ownNotice));
  assert.ok(!ownerIds.includes(strayNotice));
  assert.ok(!ownerIds.includes(noEvent));
  assert.equal((await inbox(SAME_ORG_ORGANISER)).length, 0);
  assert.deepEqual((await inbox(OTHER_ORGANISER)).map((n) => n.notification_id), [strayNotice]);

  assert.equal((await rows("SELECT * FROM public.mark_notification_read($1, $2)", [OWNER, strayNotice])).length, 0);
  const unreadBefore = await unread(OWNER);
  const marked = (await one("SELECT public.mark_all_notifications_read($1) AS n", [OWNER])).n;
  assert.equal(marked, unreadBefore);
  assert.equal(await unread(OWNER), 0);
  const stray = await one("SELECT is_read FROM public.notification_recipient WHERE notification_id = $1 AND recipient_id = $2", [strayNotice, OWNER]);
  assert.equal(stray.is_read, false);
});

test("[SPM-192] attendee and staff visibility are unchanged", async () => {
  const eventId = await createEvent({ status: "CONFIRMED" });
  const id = (await one(
    "SELECT public._notify_event_users($1, 'Mixed', 'Mixed audience', ARRAY[$2, $3]::integer[], 'STATUS_CHANGE', $4, NULL) AS id",
    [eventId, ATTENDEE, LEAD, `TEST_NOTICE:mixed:${eventId}`]
  )).id;
  assert.ok(!(await inbox(ATTENDEE)).some((n) => n.notification_id === id));
  assert.ok((await inbox(LEAD)).some((n) => n.notification_id === id));
  await db.query("INSERT INTO public.registration (attendee_id, event_id) VALUES ($1, $2)", [ATTENDEE, eventId]);
  assert.ok((await inbox(ATTENDEE)).some((n) => n.notification_id === id));
});

test("[SPM-192] the owner-notice helpers are not executable by API roles", async () => {
  const granted = await rows(
    `SELECT p.proname FROM pg_proc AS p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('_owner_notice_event', '_event_owner_recipients', '_notify_feasibility_accepted',
                          '_notify_event_rejected_owner', '_notify_event_cancelled_owner', '_notification_visible')
        AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR has_function_privilege('service_role', p.oid, 'EXECUTE'))`
  );
  assert.deepEqual(granted, []);
});
