// SPM-286 / SPM-287 technical requests, run for real on PGlite against the
// 20261031090000 migration (backfill included). No hosted database or network.
// Real concurrency (TC-08, SPM-287 TC-09) is covered by the live integration
// test; here the second of two requests runs after the first commits.
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
const TECH = 4;
const TECH_TWO = 5;
const MEMBER = 6;
const MICS = 100;
const PROJECTORS = 101;
const RETIRED = 102;

let db;
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const rows = async (sql, values = []) => (await db.query(sql, values)).rows;
const rejects = (promise, message) => assert.rejects(promise, (error) => error.message === message);
const at = (hour) => new Date(Date.UTC(2030, 2, 10, hour)).toISOString();

let nextKey = 0;
const key = () => `spm286-key-${++nextKey}`;

const createEvent = async ({ start = at(10), end = at(12), status = "PLANNING", coordinator = COORDINATOR } = {}) =>
  (await one(
    `INSERT INTO public.event (organiser_id, coordinator_id, title, status, start_datetime, end_datetime)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING event_id`,
    [OWNER, coordinator, `spm286 event ${++nextKey}`, status, start, end]
  )).event_id;

const send = async (eventId, items, { actor = COORDINATOR, idempotencyKey = key(), hash = "h".repeat(64) } = {}) =>
  (await one("SELECT public.request_technical_support($1, $2, $3::jsonb, $4, $5) AS r", [actor, eventId, JSON.stringify(items), idempotencyKey, hash])).r;

const decide = async (requestId, decision, { actor = TECH, reason = null, idempotencyKey = key(), hash = "d".repeat(64) } = {}) =>
  (await one("SELECT public.decide_technical_request($1, $2, $3, $4, $5, $6) AS r", [actor, requestId, decision, reason, idempotencyKey, hash])).r;

const available = async (equipmentId, start, end) =>
  (await one("SELECT available_quantity AS n FROM public.equipment_availability($1, $2) WHERE equipment_id = $3", [start, end, equipmentId])).n;

const noticesFor = (userId, eventId) =>
  rows(
    `SELECT n.title, n.message, n.action_key FROM public.notification AS n JOIN public.notification_recipient AS r USING (notification_id)
      WHERE r.recipient_id = $1 AND n.event_id = $2 ORDER BY n.notification_id`,
    [userId, eventId]
  );

const LEGACY = {};

before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm155DatabaseSchema.sql"), "utf8"));
  // Only the columns these functions read.
  await db.exec(`
    ALTER TABLE public.event ADD COLUMN coordinator_id integer REFERENCES public."user" (user_id),
      ADD COLUMN arrangement_version integer NOT NULL DEFAULT 1;
    CREATE TABLE public.activity_log (
      log_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id integer, entity_name varchar(50), entity_id integer,
      action varchar(100), details text, "timestamp" timestamptz NOT NULL DEFAULT clock_timestamp(),
      actor_role text, changes jsonb, audience text);
    CREATE TABLE public.equipment (
      equipment_id integer PRIMARY KEY, name varchar(150) NOT NULL, category varchar(50), total_quantity integer NOT NULL,
      description text, is_active boolean NOT NULL DEFAULT true, details_pending boolean NOT NULL DEFAULT false);
    CREATE TABLE public.equipment_unavailability (
      unavailability_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, equipment_id integer NOT NULL REFERENCES public.equipment,
      quantity integer NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'ACTIVE');
    CREATE TYPE public.equipment_request_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PARTIALLY_FULFILLED');
    CREATE TABLE public.equipment_request (
      equip_request_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      equipment_id integer NOT NULL REFERENCES public.equipment, event_id integer NOT NULL REFERENCES public.event ON DELETE CASCADE,
      requested_by integer REFERENCES public."user", reviewed_by integer REFERENCES public."user",
      quantity_requested integer, start_datetime timestamptz, end_datetime timestamptz,
      status public.equipment_request_status NOT NULL DEFAULT 'PENDING', technical_notes text,
      request_datetime timestamptz DEFAULT now());
    CREATE FUNCTION public._event_primary_venue(p_event_id integer)
      RETURNS TABLE (venue_id integer, name text, address text, max_capacity integer)
      LANGUAGE sql AS $$ SELECT 10, 'Synthetic Hall'::text, '1 Test Road'::text, 100 $$;
    INSERT INTO public."user" (user_id, email, name, role, is_active) VALUES
      (1, 'spm286-1@connectsphere.test', 'Owner', 'ORGANISER', true),
      (2, 'spm286-2@connectsphere.test', 'Coordinator C', 'COORDINATOR', true),
      (3, 'spm286-3@connectsphere.test', 'Coordinator C2', 'COORDINATOR', true),
      (4, 'spm286-4@connectsphere.test', 'Tech T', 'TECH_SUPPORT', true),
      (5, 'spm286-5@connectsphere.test', 'Tech T2', 'TECH_SUPPORT', true),
      (6, 'spm286-6@connectsphere.test', 'Same-org Organiser', 'ORGANISER', true);
    INSERT INTO public.equipment (equipment_id, name, category, total_quantity, is_active) VALUES
      (100, 'Wireless Mic', 'AUDIO', 12, true), (101, 'Projector', 'VISUAL', 2, true), (102, 'Retired Mixer', 'AUDIO', 5, false);`);

  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(functionSql(idempotency, "_claim_idempotency_key") + functionSql(idempotency, "_store_idempotent_response"));
  await db.exec(functionSql(read("20261028162013_spm179_request_venue_bookings.sql"), "_require_booking_coordinator"));
  await db.exec(read("20261020161808_spm155_notification_types.sql"));
  await db.exec(read("20261020161837_spm156_notification_foundation.sql"));
  await db.exec(read("20261020161912_spm155_attendee_notifications.sql"));
  await db.exec(read("20261026043658_spm192_organiser_notifications.sql"));
  await db.exec(read("20261027051734_spm193_assignment_ended_type.sql"));
  await db.exec(read("20261027090100_spm193_coordinator_notifications.sql"));

  // Legacy lines the backfill must group: mixed PENDING/APPROVED/PARTIALLY_FULFILLED,
  // a REJECTED line, and an all-APPROVED event.
  LEGACY.mixed = await createEvent({ start: at(1), end: at(2) });
  LEGACY.approved = await createEvent({ start: at(3), end: at(4), status: "CONFIRMED" });
  await db.query(
    `INSERT INTO public.equipment_request (equipment_id, event_id, requested_by, quantity_requested, start_datetime, end_datetime, status) VALUES
       (100, $1, 2, 1, $3, $4, 'APPROVED'), (101, $1, 2, 1, $3, $4, 'PARTIALLY_FULFILLED'), (102, $1, 2, 1, $3, $4, 'REJECTED'),
       (100, $2, 2, 2, $5, $6, 'APPROVED'), (101, $2, 2, 1, $5, $6, 'APPROVED')`,
    [LEGACY.mixed, LEGACY.approved, at(1), at(2), at(3), at(4)]
  );

  // The live operation allow-list (stand-in with one earlier operation): keys
  // for the new operations are refused until 20261031090100 extends it.
  await db.exec(`ALTER TABLE public.idempotency_records
    ADD CONSTRAINT idempotency_records_operation_check CHECK (operation = 'event.create_draft')`);
  await db.exec(read("20261031090000_spm286_287_technical_requests.sql"));
  await db.exec(read("20261031090100_spm286_287_idempotency_operations.sql"));
  await db.exec(read("20261031090200_spm286_temp_reset_where.sql"));
});

after(async () => {
  await db.close();
});

// ---------- backfill ----------

test("[SPM-286-BACKFILL] mixed legacy lines get one active header and one rejected header", async () => {
  const headers = await rows("SELECT event_id, status FROM public.technical_request ORDER BY event_id, status");
  assert.deepEqual(headers, [
    { event_id: LEGACY.mixed, status: "PENDING" },
    { event_id: LEGACY.mixed, status: "REJECTED" },
    { event_id: LEGACY.approved, status: "APPROVED" },
  ]);
  const lines = await rows(
    `SELECT line.status::text AS line, header.status AS header FROM public.equipment_request AS line
       JOIN public.technical_request AS header USING (technical_request_id)`
  );
  assert.equal(lines.length, 5);
  for (const line of lines) assert.equal(line.line, line.header);
});

// ---------- SPM-286 availability ----------

test("[SPM-286-TC-01][SPM-286-TC-02] overlap holds stock; a window starting as another ends does not", async () => {
  const eventA = await createEvent({ start: at(10), end: at(12) });
  await send(eventA, [{ equipmentId: MICS, quantity: 4 }]);
  assert.equal(await available(MICS, at(11), at(13)), 8);
  assert.equal(await available(MICS, at(12), at(14)), 12);
});

test("[SPM-286-AC1] availability is peak concurrent use, not the sum of every overlap", async () => {
  const early = await createEvent({ start: at(14), end: at(15) });
  const late = await createEvent({ start: at(16), end: at(17) });
  await send(early, [{ equipmentId: MICS, quantity: 5 }]);
  await send(late, [{ equipmentId: MICS, quantity: 6 }]);
  // 14:00-17:00 overlaps both, but they never run together: peak is 6.
  assert.equal(await available(MICS, at(14), at(17)), 6);
  await db.query(
    "INSERT INTO public.equipment_unavailability (equipment_id, quantity, starts_at, ends_at) VALUES ($1, 2, $2, $3)",
    [MICS, at(16), at(18)]
  );
  assert.equal(await available(MICS, at(14), at(17)), 4);
});

test("[SPM-286-AC2] without a window, usable stock is shown; inactive items are not offered", async () => {
  const options = await rows("SELECT equipment_id, available_quantity FROM public.equipment_availability(NULL, NULL)");
  assert.deepEqual(options.find((row) => row.equipment_id === MICS), { equipment_id: MICS, available_quantity: 12 });
  assert.equal(options.some((row) => row.equipment_id === RETIRED), false);
  const chosen = await rows("SELECT equipment_id, name FROM public.equipment_availability(NULL, NULL, $1)", [[PROJECTORS, RETIRED]]);
  assert.deepEqual(chosen, [{ equipment_id: PROJECTORS, name: "Projector" }]);
});

// ---------- SPM-286 coordinator sends a technical request ----------

test("[SPM-286-TC-06] PLANNING: PENDING request, quantities held, Technical Support notified, history entry", async () => {
  const eventId = await createEvent({ start: at(20), end: at(22) });
  const result = await send(eventId, [{ equipmentId: PROJECTORS, quantity: 2 }, { equipmentId: MICS, quantity: 4 }]);
  assert.equal(result.status, "PENDING");
  assert.deepEqual(result.items.map((item) => [item.equipmentId, item.quantity]), [[PROJECTORS, 2], [MICS, 4]]);
  assert.equal(await available(PROJECTORS, at(21), at(23)), 0);
  for (const tech of [TECH, TECH_TWO]) assert.equal((await noticesFor(tech, eventId)).length, 1);
  const history = await one("SELECT action, audience FROM public.activity_log WHERE entity_id = $1 AND action = 'TECHNICAL_REQUEST_SENT'", [eventId]);
  assert.deepEqual(history, { action: "TECHNICAL_REQUEST_SENT", audience: "STAFF_ONLY" });
});

test("[SPM-286-TC-07] refused outside PLANNING, and for anyone but the assigned coordinator", async () => {
  const underReview = await createEvent({ status: "UNDER_REVIEW" });
  await rejects(send(underReview, [{ equipmentId: MICS, quantity: 1 }]), "EVENT_NOT_IN_PLANNING");
  const planning = await createEvent({ start: at(1), end: at(2) });
  await rejects(send(planning, [{ equipmentId: MICS, quantity: 1 }], { actor: COORDINATOR_TWO }), "FORBIDDEN");
});

test("[SPM-286-TC-05][SPM-286-AC7] invalid items are refused before anything is written", async () => {
  const eventId = await createEvent({ start: at(5), end: at(6) });
  for (const items of [[{ equipmentId: MICS, quantity: 0 }], [{ equipmentId: MICS, quantity: 1.5 }], [], [{ equipmentId: MICS, quantity: 1 }, { equipmentId: MICS, quantity: 2 }]]) {
    await rejects(send(eventId, items), "INVALID_TECHNICAL_REQUEST");
  }
  await rejects(send(eventId, [{ equipmentId: RETIRED, quantity: 1 }]), "UNKNOWN_EQUIPMENT");
  await rejects(send(eventId, [{ equipmentId: 999, quantity: 1 }]), "UNKNOWN_EQUIPMENT");
  assert.equal((await one("SELECT count(*)::int AS n FROM public.technical_request WHERE event_id = $1", [eventId])).n, 0);
});

test("[SPM-286-AC6][SPM-286-TC-08] the second request for the last units is refused with the available quantity", async () => {
  const first = await createEvent({ start: at(7), end: at(9) });
  const second = await createEvent({ start: at(8), end: at(9), coordinator: COORDINATOR_TWO });
  await send(first, [{ equipmentId: PROJECTORS, quantity: 2 }]);
  await assert.rejects(send(second, [{ equipmentId: PROJECTORS, quantity: 2 }], { actor: COORDINATOR_TWO }), (error) => {
    assert.equal(error.message, "EQUIPMENT_NOT_AVAILABLE");
    assert.deepEqual(JSON.parse(error.detail).items, [{ equipmentId: PROJECTORS, name: "Projector", requested: 2, available: 0 }]);
    return true;
  });
});

test("[SPM-286-TC-09] a retried request with the same key creates one request; a second active request is refused", async () => {
  const eventId = await createEvent({ start: at(13), end: at(14) });
  const idempotencyKey = key();
  const first = await send(eventId, [{ equipmentId: MICS, quantity: 1 }], { idempotencyKey });
  const replay = await send(eventId, [{ equipmentId: MICS, quantity: 1 }], { idempotencyKey });
  assert.equal(replay.replayed, true);
  assert.equal(replay.technicalRequestId, first.technicalRequestId);
  await rejects(send(eventId, [{ equipmentId: MICS, quantity: 1 }], { idempotencyKey, hash: "x".repeat(64) }), "IDEMPOTENCY_KEY_REUSED");
  await rejects(send(eventId, [{ equipmentId: MICS, quantity: 1 }]), "TECHNICAL_REQUEST_EXISTS");
  assert.equal((await one("SELECT count(*)::int AS n FROM public.technical_request WHERE event_id = $1", [eventId])).n, 1);
});

// ---------- SPM-287 dashboard ----------

test("[SPM-287-TC-01][SPM-287-TC-02] Pending first, oldest first; status filter and title search", async () => {
  const list = (await one("SELECT public.list_technical_requests(NULL, NULL, 100, 0) AS r")).r;
  const statuses = list.items.map((item) => item.status);
  assert.equal(statuses.indexOf("APPROVED") > statuses.lastIndexOf("PENDING"), true);
  const pending = list.items.filter((item) => item.status === "PENDING").map((item) => item.createdAt);
  assert.deepEqual(pending, [...pending].sort());
  const first = list.items[0];
  assert.ok(first.event.title && first.event.start && first.event.venue.name && first.requestedBy.name && first.items.length);

  const approved = (await one("SELECT public.list_technical_requests('APPROVED', NULL, 100, 0) AS r")).r;
  assert.ok(approved.items.every((item) => item.status === "APPROVED"));
  const title = approved.items[0].event.title;
  const searched = (await one("SELECT public.list_technical_requests('APPROVED', $1, 100, 0) AS r", [title.toUpperCase()])).r;
  assert.deepEqual(searched.items.map((item) => item.event.title), [title]);
  const wildcard = (await one("SELECT public.list_technical_requests(NULL, '%', 100, 0) AS r")).r;
  assert.equal(wildcard.total, 0);
});

test("[SPM-287-TC-03][SPM-287-TC-04] detail, then approval: blocked, history, coordinator and owner notified once", async () => {
  const eventId = await createEvent({ start: at(18), end: at(19) });
  const { technicalRequestId } = await send(eventId, [{ equipmentId: MICS, quantity: 3 }]);
  const detail = (await one("SELECT public.get_technical_request($1) AS r", [technicalRequestId])).r;
  assert.deepEqual(detail.items.map((item) => [item.equipmentId, item.quantity]), [[MICS, 3]]);
  assert.equal(typeof detail.items[0].availableQuantity, "number");
  assert.equal(detail.event.venue.name, "Synthetic Hall");
  assert.deepEqual(detail.history.map((entry) => entry.action), ["TECHNICAL_REQUEST_SENT"]);

  const idempotencyKey = key();
  const result = await decide(technicalRequestId, "APPROVE", { idempotencyKey });
  assert.equal(result.status, "APPROVED");
  const replay = await decide(technicalRequestId, "APPROVE", { idempotencyKey });
  assert.equal(replay.replayed, true);

  assert.equal(await available(MICS, at(18), at(19)), 9);
  const lines = await rows("SELECT status::text AS status, reviewed_by FROM public.equipment_request WHERE technical_request_id = $1", [technicalRequestId]);
  assert.deepEqual(lines, [{ status: "APPROVED", reviewed_by: TECH }]);
  assert.deepEqual((await noticesFor(COORDINATOR, eventId)).map((n) => n.title), ["Technical request approved"]);
  assert.deepEqual((await noticesFor(OWNER, eventId)).map((n) => n.title), ["Equipment approved"]);
  assert.deepEqual(await noticesFor(MEMBER, eventId), []);
  const after = (await one("SELECT public.get_technical_request($1) AS r", [technicalRequestId])).r;
  assert.deepEqual(after.history.map((entry) => entry.action), ["TECHNICAL_REQUEST_SENT", "TECHNICAL_REQUEST_APPROVED"]);
});

test("[SPM-287-TC-05][SPM-287-TC-06] rejection needs a reason, releases stock and tells the coordinator why", async () => {
  const eventId = await createEvent({ start: at(1), end: at(3) });
  const { technicalRequestId } = await send(eventId, [{ equipmentId: PROJECTORS, quantity: 1 }]);
  await rejects(decide(technicalRequestId, "REJECT", { reason: "  " }), "REJECTION_REASON_INVALID");

  const before = await available(PROJECTORS, at(2), at(3));
  await decide(technicalRequestId, "REJECT", { reason: "Projector unavailable" });
  assert.equal(await available(PROJECTORS, at(2), at(3)), before + 1);
  const [notice] = await noticesFor(COORDINATOR, eventId);
  assert.match(notice.message, /Reason: Projector unavailable\./);
  assert.deepEqual(await noticesFor(OWNER, eventId), []);
  const detail = (await one("SELECT public.get_technical_request($1) AS r", [technicalRequestId])).r;
  assert.equal(detail.rejectionReason, "Projector unavailable");
  assert.ok(detail.history.some((entry) => entry.rejectionReason === "Projector unavailable"));
  // A rejected request no longer blocks a new one for the event.
  assert.equal((await send(eventId, [{ equipmentId: PROJECTORS, quantity: 1 }])).status, "PENDING");
});

test("[SPM-287-TC-08][SPM-287-TC-09] a decided request is read-only; the second decider is told it was decided", async () => {
  const eventId = await createEvent({ start: at(4), end: at(5) });
  const { technicalRequestId } = await send(eventId, [{ equipmentId: MICS, quantity: 1 }]);
  await decide(technicalRequestId, "APPROVE");
  await assert.rejects(decide(technicalRequestId, "REJECT", { actor: TECH_TWO, reason: "Late" }), (error) => {
    assert.equal(error.message, "TECHNICAL_REQUEST_ALREADY_DECIDED");
    assert.equal(JSON.parse(error.detail).status, "APPROVED");
    return true;
  });
  assert.equal((await noticesFor(COORDINATOR, eventId)).length, 1);
});

test("[SPM-287-TC-07][SPM-287-AC6] only active Technical Support can decide", async () => {
  const eventId = await createEvent({ start: at(6), end: at(7) });
  const { technicalRequestId } = await send(eventId, [{ equipmentId: MICS, quantity: 1 }]);
  for (const actor of [COORDINATOR, OWNER]) await rejects(decide(technicalRequestId, "APPROVE", { actor }), "FORBIDDEN");
  await rejects(decide(999999, "APPROVE"), "TECHNICAL_REQUEST_NOT_FOUND");
});

test("[SPM-287-AC4] approval rechecks stock: unavailability recorded after sending fails every line", async () => {
  const eventId = await createEvent({ start: at(22), end: at(23) });
  const { technicalRequestId } = await send(eventId, [{ equipmentId: MICS, quantity: 2 }, { equipmentId: PROJECTORS, quantity: 2 }]);
  await db.query(
    "INSERT INTO public.equipment_unavailability (equipment_id, quantity, starts_at, ends_at) VALUES ($1, 1, $2, $3)",
    [PROJECTORS, at(22), at(23)]
  );
  await rejects(decide(technicalRequestId, "APPROVE"), "EQUIPMENT_NOT_AVAILABLE");
  const statuses = await rows("SELECT DISTINCT status::text AS status FROM public.equipment_request WHERE technical_request_id = $1", [technicalRequestId]);
  assert.deepEqual(statuses, [{ status: "PENDING" }]);
});
