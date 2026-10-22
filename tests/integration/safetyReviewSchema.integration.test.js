// SPM-244: database constraints on safety review rounds (Master 5.9, 6.1, 6.3).
// Every check runs in a transaction that is rolled back, so nothing is left on
// the shared project. Needs TEST_DATABASE_URL.
const { inRolledBackTransaction } = require("../fixtures/lifecycleFixtures");

jest.setTimeout(60000);

// A user and an event that exist only inside the rolled-back transaction.
const insertScaffold = async (client) => {
  const { rows: users } = await client.query(
    `INSERT INTO public."user" (email, name, role, is_active)
     VALUES ('spm244-coordinator@connectsphere.test', 'spm244 coordinator', 'COORDINATOR', true),
            ('spm244-officer@connectsphere.test', 'spm244 officer', 'SAFETY_OFFICER', true)
     RETURNING user_id`
  );
  const { rows: events } = await client.query(
    `INSERT INTO public.event (organiser_id, title, status) VALUES ($1, 'spm244 schema check', 'DRAFT') RETURNING event_id`,
    [users[0].user_id]
  );
  return { coordinatorId: users[0].user_id, officerId: users[1].user_id, eventId: events[0].event_id };
};

const insertRound = (client, values) => {
  const columns = Object.keys(values);
  return client.query(
    `INSERT INTO public.safety_reviews (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING review_id`,
    Object.values(values)
  );
};

// Runs one statement that must fail, inside a savepoint so the transaction stays usable.
const expectRefused = async (client, statement, constraint) => {
  await client.query("SAVEPOINT attempt");
  try {
    await expect(statement()).rejects.toMatchObject({ constraint });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
  }
};

describe("SPM-244 safety review schema", () => {
  test("[SPM-244] an event has at most one OPEN round, while decided rounds stay", async () => {
    await inRolledBackTransaction(async (client) => {
      const { coordinatorId, officerId, eventId } = await insertScaffold(client);
      const base = { event_id: eventId, arrangement_version: 1, submitted_by: coordinatorId };
      await insertRound(client, { ...base, round_number: 1 });
      await expectRefused(client, () => insertRound(client, { ...base, round_number: 2 }), "safety_reviews_one_open_per_event");

      await client.query(
        "UPDATE public.safety_reviews SET status = 'CHANGES_REQUESTED', decided_by = $1, decided_at = now() WHERE event_id = $2",
        [officerId, eventId]
      );
      await insertRound(client, { ...base, round_number: 2 });
      await expectRefused(client, () => insertRound(client, { ...base, round_number: 2, status: "APPROVED", decided_by: officerId, decided_at: new Date() }), "safety_reviews_event_id_round_number_key");
    });
  });

  test("[SPM-244] status, outcome fields and claim fields must agree", async () => {
    await inRolledBackTransaction(async (client) => {
      const { coordinatorId, officerId, eventId } = await insertScaffold(client);
      const base = { event_id: eventId, round_number: 1, arrangement_version: 1, submitted_by: coordinatorId };
      // Decided fields set, so only the status vocabulary can fail.
      await expectRefused(client, () => insertRound(client, { ...base, status: "ACCEPTED", decided_by: officerId, decided_at: new Date() }), "safety_reviews_status_check");
      await expectRefused(client, () => insertRound(client, { ...base, decided_by: officerId, decided_at: new Date() }), "safety_reviews_outcome_check");
      await expectRefused(client, () => insertRound(client, { ...base, status: "APPROVED" }), "safety_reviews_outcome_check");
      await expectRefused(client, () => insertRound(client, { ...base, status: "SUPERSEDED" }), "safety_reviews_outcome_check");
      await expectRefused(client, () => insertRound(client, { ...base, claimed_by: officerId }), "safety_reviews_claim_pair_check");
      await expectRefused(client, () => insertRound(client, { ...base, arrangement_version: 0 }), "safety_reviews_arrangement_version_check");
    });
  });

  test("[SPM-244] the checklist and requested changes are bounded JSON of the right shape", async () => {
    await inRolledBackTransaction(async (client) => {
      const { coordinatorId, eventId } = await insertScaffold(client);
      const base = { event_id: eventId, round_number: 1, arrangement_version: 1, submitted_by: coordinatorId };
      await expectRefused(client, () => insertRound(client, { ...base, checklist: JSON.stringify([{ result: "SATISFACTORY" }]) }), "safety_reviews_checklist_shape_check");
      const oversized = JSON.stringify({ layout: { result: "NOT_SATISFACTORY", comment: "x".repeat(20000) } });
      await expectRefused(client, () => insertRound(client, { ...base, checklist: oversized }), "safety_reviews_checklist_shape_check");
      await expectRefused(client, () => insertRound(client, { ...base, requested_changes: JSON.stringify({ change: "More exits" }) }), "safety_reviews_requested_changes_shape_check");
      await expectRefused(client, () => insertRound(client, { ...base, organiser_comment: "x".repeat(2001) }), "safety_reviews_organiser_comment_check");
      await insertRound(client, { ...base, checklist: JSON.stringify({ layout: { result: "SATISFACTORY", comment: "" } }), requested_changes: JSON.stringify(["More exits"]) });
    });
  });

  test("[SPM-244][SPM-243-AC16] a rejected booking needs a reason, and the backend can never delete or rewrite rounds", async () => {
    await inRolledBackTransaction(async (client) => {
      // Every write goes through the SECURITY DEFINER safety functions; a trigger
      // also refuses changes to closed rounds (20261022123827).
      const { rows } = await client.query(
        `SELECT has_table_privilege('service_role', 'public.safety_reviews', 'DELETE') AS reviews,
                has_table_privilege('service_role', 'public.safety_review_rejected_bookings', 'DELETE') AS rejected,
                has_table_privilege('service_role', 'public.safety_reviews', 'UPDATE') AS update_reviews,
                has_table_privilege('service_role', 'public.safety_review_rejected_bookings', 'UPDATE') AS update_rejected,
                (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('safety_reviews_closed_round_unchanged', 'safety_review_rejected_bookings_unchanged')) AS triggers`
      );
      expect(rows[0]).toEqual({ reviews: false, rejected: false, update_reviews: false, update_rejected: false, triggers: 2 });
      const { rows: checks } = await client.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'public.safety_review_rejected_bookings'::regclass AND contype = 'c'"
      );
      expect(checks.map((check) => check.definition).join(" ")).toMatch(/char_length\(btrim\(reason\)\)/);
    });
  });
});
