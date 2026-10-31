// Hosted writes: run only in an authorized test environment after the SPM-39
// migration. Auth fixtures own a manifest; cleanup checks the run's namespace.
const crypto = require("crypto");
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { newRunId, createAuthFixtures, cleanupAuthFixtures } = require("../fixtures/authFixtures");
const { createLifecycleEvent, cleanupLifecycleRows, withPrivilegedDb } = require("../fixtures/lifecycleFixtures");
const { signInWithPassword } = require("../fixtures/browserAuthClient");

jest.setTimeout(180000);
const runId = newRunId();
const eventIds = [];
let fixtures;
let token;

const createEvent = async () => {
  const event = await createLifecycleEvent(fixtures, { status: "UNDER_REVIEW", purpose: "SPM-39 feasibility integration" });
  eventIds.push(event.event_id);
  const { error } = await supabase.from("event_venue_preference").insert({ event_id: event.event_id, venue_id: fixtures.venue.venueId, preference_order: 1 });
  if (error) throw new Error("SPM-39 venue fixture failed.");
  return event;
};
const approve = (event, key) => request(app).post(`/api/events/${event.event_id}/accept-feasibility`)
  .set("Authorization", `Bearer ${token}`).set("Idempotency-Key", key).send({ version: event.version });
const effects = (eventId) => withPrivilegedDb(async (client) => (await client.query(`SELECT
  (SELECT count(*)::int FROM activity_log WHERE entity_name='event' AND entity_id=$1 AND action='FEASIBILITY_ACCEPTED') AS activity,
  (SELECT count(*)::int FROM notification WHERE event_id=$1 AND title='Event request approved for planning') AS notifications`, [eventId])).rows[0]);

beforeAll(async () => {
  await require("../fixtures/adminCleanup").assertAuditCleanupAvailable();
  // Fail before creating any fixture if the reviewed migration is absent.
  await withPrivilegedDb(async (client) => {
    const { rows } = await client.query("SELECT to_regprocedure('public.accept_event_feasibility(integer,integer,integer,text,text)') AS name");
    if (!rows[0].name) throw new Error("Apply the reviewed SPM-39 migration in the authorized environment first.");
  });
  fixtures = await createAuthFixtures(runId);
  const account = fixtures.accounts.coordinator;
  const { session, error } = await signInWithPassword(account.email, account.password);
  if (error || !session) throw new Error("SPM-39 fixture sign-in failed.");
  token = session.access_token;
});

afterAll(async () => {
  try {
    if (fixtures) await cleanupLifecycleRows(runId, [...Object.values(fixtures.events), ...eventIds]);
  } finally {
    await cleanupAuthFixtures(runId);
  }
});

test("[SPM-39 TC1/5] authenticates, persists approval and replays without duplicate effects", async () => {
  const event = await createEvent();
  const key = crypto.randomUUID();
  const first = await approve(event, key);
  expect(first.status).toBe(200);
  expect(first.body.event).toMatchObject({ eventId: event.event_id, status: "PLANNING", statusLabel: "Approved & Planning", version: event.version + 1 });
  const replay = await approve(event, key);
  expect(replay.status).toBe(200);
  expect(replay.headers["idempotent-replayed"]).toBe("true");
  expect(await effects(event.event_id)).toEqual({ activity: 1, notifications: 1 });
  const { data, error } = await supabase.from("event").select("status,version").eq("event_id", event.event_id).single();
  expect(error).toBeNull();
  expect(data).toEqual({ status: "PLANNING", version: event.version + 1 });
});

test.each([true, false])("[SPM-39 concurrency] two database connections serialize commands, same key=%s", async (sameKey) => {
  const event = await createEvent();
  const key = crypto.randomUUID();
  const hash = crypto.createHash("sha256").update(`spm39:${event.event_id}`).digest("hex");
  await withPrivilegedDb(async (first) => withPrivilegedDb(async (second) => {
    const query = "SELECT public.accept_event_feasibility($1,$2,$3,$4,$5) AS result";
    const args = [event.event_id, fixtures.accounts.coordinator.userId, event.version, key, hash];
    // Hold the row before starting the second connection, so it must wait for
    // the first commit and recheck the resulting version/state.
    await first.query("BEGIN");
    let waiting;
    try {
      await first.query("SELECT event_id FROM public.event WHERE event_id=$1 FOR UPDATE", [event.event_id]);
      const otherArgs = [...args];
      if (!sameKey) otherArgs[3] = crypto.randomUUID();
      waiting = second.query(query, otherArgs).then((result) => ({ result }), (error) => ({ error }));
      const accepted = await first.query(query, args);
      expect(accepted.rows[0].result.replayed).toBe(false);
      await first.query("COMMIT");
      const other = await waiting;
      if (sameKey) expect(other.result.rows[0].result.replayed).toBe(true);
      else expect(other.error.message).toBe("EVENT_VERSION_CONFLICT");
    } finally {
      await first.query("ROLLBACK");
      if (waiting) await waiting;
    }
  }));
  expect(await effects(event.event_id)).toEqual({ activity: 1, notifications: 1 });
});
