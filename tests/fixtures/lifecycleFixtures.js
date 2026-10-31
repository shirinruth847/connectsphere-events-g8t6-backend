// SPM-173 fixture helpers on top of authFixtures (which stays unchanged, because
// other branches edit it too). Rows that the backend role may not delete
// (safety review rounds, confirmation snapshots, history written by "System")
// are removed through the privileged test connection, before the shared
// cleanup deletes the events they reference.
const { Client } = require("pg");
const supabase = require("../../config/supabase");
const { recordFixtureIds } = require("./authFixtures");

const withPrivilegedDb = async (operation) => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for the SPM-173 integration tests.");
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
};

// Runs "operation" in a transaction that is always rolled back, so state-machine
// checks leave nothing behind on the shared project.
const inRolledBackTransaction = (operation) =>
  withPrivilegedDb(async (client) => {
    await client.query("BEGIN");
    try {
      return await operation(client);
    } finally {
      await client.query("ROLLBACK");
    }
  });

const check = ({ data, error }, step) => {
  if (error) throw new Error(`Fixture step "${step}" failed: ${error.message}`);
  return data;
};

// A committed fixture event, recorded in the run's manifest for cleanup. Each
// one gets its own day unless the caller sets the times, because one coordinator
// may not hold overlapping active events (SPM-174 schedule guard).
let nextFixtureDay = 0;
const nextFixtureSlot = () => {
  const day = new Date(Date.UTC(2027, 4, 1 + nextFixtureDay++));
  const at = (hour) => new Date(day.getTime() + hour * 3600000).toISOString();
  return { start_datetime: at(1), end_datetime: at(3) };
};

const createLifecycleEvent = async (fixtures, overrides = {}) => {
  const row = check(
    await supabase
      .from("event")
      .insert({
        title: `spm32-${fixtures.runId} lifecycle`,
        description: "Synthetic lifecycle event",
        purpose: "SPM-173 integration test",
        organiser_id: fixtures.accounts.organiserA.userId,
        organisation_id: fixtures.organisations.A,
        coordinator_id: fixtures.accounts.coordinator.userId,
        status: "PLANNING",
        expected_attendance: 50,
        ...nextFixtureSlot(),
        preferred_layout_type: "THEATRE",
        ...overrides,
      })
      .select("*")
      .single(),
    "lifecycle event"
  );
  recordFixtureIds(fixtures.runId, "eventIds", [row.event_id]);
  return row;
};

const createSafetyRound = async (event, { status = "APPROVED", submittedBy, decidedBy = null, claimedBy = null, arrangementVersion } = {}) =>
  check(
    await supabase
      .from("safety_reviews")
      .insert({
        event_id: event.event_id,
        round_number: 1,
        arrangement_version: arrangementVersion ?? event.arrangement_version,
        status,
        submitted_by: submittedBy,
        claimed_by: claimedBy,
        claimed_at: claimedBy ? new Date().toISOString() : null,
        decided_by: status === "OPEN" ? null : decidedBy,
        decided_at: status === "OPEN" ? null : new Date().toISOString(),
      })
      .select("*")
      .single(),
    "safety round"
  );

// Removes what the shared cleanup cannot, for this run's events only.
const cleanupLifecycleRows = async (runId, eventIds) => {
  if (!eventIds.length) return;
  if (!/^[a-z0-9]+$/.test(runId)) throw new Error("Invalid fixture run ID.");
  await withPrivilegedDb(async (client) => {
    await client.query("BEGIN");
    try {
      const { rows } = await client.query("SELECT event_id, title FROM public.event WHERE event_id = ANY($1::integer[])", [eventIds]);
      if (rows.some((event) => !event.title.startsWith(`spm32-${runId}`))) throw new Error("Refusing cleanup of a non-fixture event.");
      await client.query(
        "DELETE FROM public.safety_review_rejected_bookings WHERE review_id IN (SELECT review_id FROM public.safety_reviews WHERE event_id = ANY($1::integer[]))",
        [eventIds]
      );
      await client.query("DELETE FROM public.safety_reviews WHERE event_id = ANY($1::integer[])", [eventIds]);
      await client.query("DELETE FROM public.event_confirmation_snapshots WHERE event_id = ANY($1::integer[])", [eventIds]);
      await client.query(
        "DELETE FROM public.activity_log WHERE entity_name = 'event' AND entity_id = ANY($1::integer[]) AND user_id IS NULL AND actor_role = 'SYSTEM'",
        [eventIds]
      );
      // Tables from the Master resource migration, when it has been applied.
      for (const table of ["resource_incidents", "technical_requests", "venue_hold_notice_claim", "venue_hold_request"]) {
        const { rows: exists } = await client.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
        if (exists[0].name) await client.query(`DELETE FROM public.${table} WHERE event_id = ANY($1::integer[])`, [eventIds]);
      }
      await client.query("DELETE FROM public.event_change_request WHERE event_id = ANY($1::integer[])", [eventIds]);
      await client.query("DELETE FROM public.equipment_request WHERE event_id = ANY($1::integer[])", [eventIds]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
};

module.exports = {
  withPrivilegedDb,
  inRolledBackTransaction,
  createLifecycleEvent,
  createSafetyRound,
  cleanupLifecycleRows,
};
