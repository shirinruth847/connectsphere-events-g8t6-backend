// SPM-41 live integration tests for clarification rounds: the real Express route,
// Supabase Auth and the shared development database. Needs the
// spm41_clarification_rounds migration and TEST_DATABASE_URL: rounds are written
// only by database functions (added with the SPM-173 lifecycle engine), so this
// suite inserts them through the privileged test connection, as those functions
// will, and checks what the table itself guarantees.
const { Client } = require("pg");
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures } = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const runId = newRunId();
let fixtures;
let admin;
const sessions = new Map();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) {
        throw new Error(`Sign-in for ${key} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
      }
      return session;
    }));
  }
  return sessions.get(key);
};

const getRounds = async (eventId, key) =>
  request(app).get(`/api/events/${eventId}/clarifications`).set("Authorization", `Bearer ${(await signIn(key)).access_token}`);

const userId = (key) => fixtures.accounts[key].userId;

const insertRound = (eventId, round) =>
  admin.query(
    `INSERT INTO public.clarifications
       (event_id, round_number, status, message, requested_by, requested_at, response, responded_by, responded_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7, $8, $9)
     RETURNING clarification_id`,
    [eventId, round.round, round.status || "OPEN", round.message, round.requestedBy, round.requestedAt || null,
      round.response || null, round.respondedBy || null, round.respondedAt || null]
  );

// Runs a statement inside a transaction that is always rolled back, and returns
// the Postgres error (or null), so a check that wrongly passes changes nothing.
const attempt = async (sql, params) => {
  await admin.query("BEGIN");
  try {
    await admin.query(sql, params);
    return null;
  } catch (error) {
    return error;
  } finally {
    await admin.query("ROLLBACK");
  }
};

let returnedEvent;
let draftEvent;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required: clarification rounds can only be written through the privileged test connection.");
  }
  admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const { rows } = await admin.query(
    "SELECT has_table_privilege(current_user, 'public.clarifications', 'INSERT') AND has_table_privilege(current_user, 'public.clarifications', 'DELETE') AS allowed"
  );
  if (!rows[0].allowed) throw new Error("The test connection cannot write clarification rounds. No fixtures have been created.");

  fixtures = await createAuthFixtures(runId, { extraAccounts: [{ key: "lead", role: "COORDINATOR_LEAD" }] });
  returnedEvent = fixtures.events.ownSubmitted;
  draftEvent = fixtures.events.ownDraft;
  // Set directly: the request-clarification transition is built on SPM-173.
  await admin.query("UPDATE public.event SET status = 'AWAITING_CLARIFICATION' WHERE event_id = $1", [returnedEvent]);
  await insertRound(returnedEvent, {
    round: 1,
    status: "RESPONDED",
    message: "What is the expected attendance?",
    requestedBy: userId("coordinator"),
    requestedAt: "2026-10-18T02:00:00Z",
    // Answered with amendments only: no written response.
    respondedBy: userId("organiserA"),
    respondedAt: "2026-10-19T02:00:00Z",
  });
  await insertRound(returnedEvent, { round: 2, message: "Please confirm the stage size.", requestedBy: userId("coordinator") });
});

afterAll(async () => {
  try {
    await cleanupAuthFixtures(runId);
  } finally {
    if (admin) await admin.end();
  }
});

describe("GET /api/events/:id/clarifications (SPM-41 AC3, TC-04)", () => {
  const expectBothRounds = (body) => {
    expect(body.clarifications).toHaveLength(2);
    const [open, answered] = body.clarifications;
    expect(open).toEqual(expect.objectContaining({
      round: 2,
      status: "OPEN",
      message: "Please confirm the stage size.",
      requestedBy: { userId: userId("coordinator"), name: expect.any(String) },
      response: null,
      respondedAt: null,
      respondedBy: null,
    }));
    expect(answered).toEqual(expect.objectContaining({
      round: 1,
      status: "RESPONDED",
      message: "What is the expected attendance?",
      response: null,
      respondedBy: { userId: userId("organiserA"), name: expect.any(String) },
    }));
    expect(Date.parse(answered.respondedAt)).toBe(Date.parse("2026-10-19T02:00:00Z"));
  };

  test("[SPM-41-AC3] should_return_every_round_newest_first_when_the_owner_opens_them", async () => {
    const res = await getRounds(returnedEvent, "organiserA");

    expect(res.status).toBe(200);
    expectBothRounds(res.body);
  });

  test("[SPM-41-AC3] should_return_the_rounds_to_a_same_organisation_organiser", async () => {
    const res = await getRounds(returnedEvent, "organiserA2");

    expect(res.status).toBe(200);
    expectBothRounds(res.body);
  });

  test("[SPM-41-AC3] should_return_the_rounds_to_the_assigned_coordinator", async () => {
    const res = await getRounds(returnedEvent, "coordinator");

    expect(res.status).toBe(200);
    expectBothRounds(res.body);
  });

  test.each(["coordinatorTwo", "organiserB", "lead", "attendee"])(
    "[SPM-41-AC3] should_answer_404_without_revealing_the_question_to_%s",
    async (key) => {
      const res = await getRounds(returnedEvent, key);

      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("stage size");
    }
  );

  test("[SPM-41-AC3] should_return_an_empty_list_for_an_event_never_returned", async () => {
    const res = await getRounds(draftEvent, "organiserA");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clarifications: [] });
  });
});

describe("what the clarifications table guarantees (SPM-41)", () => {
  const insertSql = `INSERT INTO public.clarifications (event_id, round_number, message, requested_by) VALUES ($1, $2, $3, $4)`;

  test("[SPM-41] should_refuse_a_second_open_round_for_the_same_event", async () => {
    const error = await attempt(insertSql, [returnedEvent, 3, "Another question.", userId("coordinator")]);

    expect(error && error.code).toBe("23505");
  });

  test("[SPM-41-TC-02] should_refuse_an_empty_or_blank_question", async () => {
    for (const message of ["", "   "]) {
      const error = await attempt(insertSql, [draftEvent, 1, message, userId("coordinator")]);
      expect(error && error.code).toBe("23514");
    }
  });

  test("[SPM-41] should_accept_2000_characters_and_refuse_2001", async () => {
    expect(await attempt(insertSql, [draftEvent, 1, "a".repeat(2000), userId("coordinator")])).toBeNull();
    const error = await attempt(insertSql, [draftEvent, 1, "a".repeat(2001), userId("coordinator")]);
    expect(error && error.code).toBe("23514");
  });

  test("[SPM-41] should_refuse_an_answered_round_without_who_and_when", async () => {
    const error = await attempt(
      "INSERT INTO public.clarifications (event_id, round_number, status, message, requested_by) VALUES ($1, 1, 'RESPONDED', 'Q?', $2)",
      [draftEvent, userId("coordinator")]
    );

    expect(error && error.code).toBe("23514");
  });

  test("[SPM-41-TC-05] should_never_let_a_question_be_rewritten", async () => {
    const error = await attempt(
      "UPDATE public.clarifications SET message = 'Rewritten.' WHERE event_id = $1 AND round_number = 2",
      [returnedEvent]
    );

    expect(error && error.message).toBe("CLARIFICATION_IMMUTABLE");
  });

  test("[SPM-41] should_refuse_to_reopen_or_reanswer_an_answered_round", async () => {
    for (const change of ["status = 'OPEN', responded_by = NULL, responded_at = NULL", "response = 'Changed answer.'"]) {
      const error = await attempt(`UPDATE public.clarifications SET ${change} WHERE event_id = $1 AND round_number = 1`, [returnedEvent]);
      expect(error && error.message).toBe("CLARIFICATION_IMMUTABLE");
    }
  });

  test("[SPM-41] should_allow_the_open_round_to_be_answered_once", async () => {
    const error = await attempt(
      "UPDATE public.clarifications SET status = 'RESPONDED', response = 'A 6m stage.', responded_by = $2, responded_at = now() WHERE event_id = $1 AND round_number = 2",
      [returnedEvent, userId("organiserA")]
    );

    expect(error).toBeNull();
  });

  test("[SPM-41] should_let_the_backend_runtime_read_but_never_write_rounds", async () => {
    const read = await supabase.from("clarifications").select("clarification_id").eq("event_id", returnedEvent);
    expect(read.error).toBeNull();
    expect(read.data).toHaveLength(2);

    const insert = await supabase.from("clarifications").insert({ event_id: draftEvent, round_number: 1, message: "Q?", requested_by: userId("coordinator") });
    const update = await supabase.from("clarifications").update({ message: "Rewritten." }).eq("event_id", returnedEvent);
    const remove = await supabase.from("clarifications").delete().eq("event_id", returnedEvent);
    for (const result of [insert, update, remove]) {
      expect(result.error && result.error.code).toBe("42501");
    }
    const after = await admin.query("SELECT count(*)::int AS n FROM public.clarifications WHERE event_id = $1", [returnedEvent]);
    expect(after.rows[0].n).toBe(2);
  });

  test("[SPM-41] should_refuse_to_delete_an_event_that_has_rounds", async () => {
    // The draft has no other dependent rows, so the round is what blocks it.
    await admin.query("BEGIN");
    let error = null;
    try {
      await admin.query(insertSql, [draftEvent, 1, "Q?", userId("coordinator")]);
      await admin.query("DELETE FROM public.event WHERE event_id = $1", [draftEvent]);
    } catch (caught) {
      error = caught;
    } finally {
      await admin.query("ROLLBACK");
    }

    expect(error && error.code).toBe("23503");
    expect(error.constraint).toBe("clarifications_event_id_fkey");
  });
});
