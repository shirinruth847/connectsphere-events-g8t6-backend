// SPM-243 fixture helpers on top of authFixtures and lifecycleFixtures: Safety
// Officer accounts, events in SAFETY_REVIEW with rounds in any state, and
// registrations. Everything is recorded in the run's manifest; rounds are removed
// by cleanupLifecycleRows through the privileged test connection.
const supabase = require("../../config/supabase");
const { recordFixtureIds } = require("./authFixtures");
const { createLifecycleEvent } = require("./lifecycleFixtures");

const SAFETY_ACCOUNTS = Object.freeze([
  { key: "safetyOfficer", role: "SAFETY_OFFICER" },
  { key: "safetyOfficerTwo", role: "SAFETY_OFFICER" },
]);

const check = ({ data, error }, step) => {
  if (error) throw new Error(`Fixture step "${step}" failed: ${error.message}`);
  return data;
};

// A round with the fields its status requires (safety_reviews_outcome_check).
const createRound = async (event, {
  status = "OPEN",
  roundNumber = 1,
  submittedBy,
  submittedAt = new Date().toISOString(),
  claimedBy = null,
  decidedBy = null,
  arrangementVersion = event.arrangement_version,
  checklist = null,
} = {}) => {
  const decided = !["OPEN", "SUPERSEDED"].includes(status);
  return check(
    await supabase
      .from("safety_reviews")
      .insert({
        event_id: event.event_id,
        round_number: roundNumber,
        arrangement_version: arrangementVersion,
        status,
        submitted_by: submittedBy,
        submitted_at: submittedAt,
        claimed_by: claimedBy,
        claimed_at: claimedBy ? new Date().toISOString() : null,
        checklist,
        decided_by: decided ? decidedBy : null,
        decided_at: decided ? new Date().toISOString() : null,
        superseded_at: status === "SUPERSEDED" ? new Date().toISOString() : null,
      })
      .select("*")
      .single(),
    "safety round"
  );
};

// An event in SAFETY_REVIEW (or "status") assigned to the fixture coordinator by
// the "supervisedBy" Lead (none for null or a draft), with one round;
// "eventIds" collects it for cleanupLifecycleRows.
const createReviewEvent = async (fixtures, eventIds, { status = "SAFETY_REVIEW", round = {}, event = {}, supervisedBy = "coordinatorLead" } = {}) => {
  const row = await createLifecycleEvent(fixtures, { status, ...event });
  eventIds.push(row.event_id);
  if (supervisedBy && status !== "DRAFT") {
    check(await supabase.from("event_assignments").insert({
      event_id: row.event_id,
      coordinator_id: row.coordinator_id,
      assigned_by: fixtures.accounts[supervisedBy].userId,
    }), "assignment history");
  }
  const review = round === null ? null : await createRound(row, { submittedBy: fixtures.accounts.coordinator.userId, ...round });
  return { event: row, review };
};

const registerAttendees = async (fixtures, event, attendeeKeys) => {
  const rows = check(
    await supabase
      .from("registration")
      .insert(attendeeKeys.map((key) => ({
        attendee_id: fixtures.accounts[key].userId,
        event_id: event.event_id,
        registration_status: "REGISTERED",
      })))
      .select("registration_id"),
    "registrations"
  );
  recordFixtureIds(fixtures.runId, "registrationIds", rows.map((row) => row.registration_id));
  return rows;
};

module.exports = { SAFETY_ACCOUNTS, createRound, createReviewEvent, registerAttendees };
