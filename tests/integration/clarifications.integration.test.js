// SPM-41 live integration tests for clarification rounds: the real Express routes,
// Supabase Auth and the shared development database. Needs the
// spm41_clarification_rounds and spm41_clarification_lifecycle migrations and
// TEST_DATABASE_URL. The read tests insert rounds through the privileged test
// connection to check what the table itself guarantees; the action tests write
// them through POST /clarifications and /resubmit, as the application does.
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

// ---------- request clarification and resubmit (SPM-41 AC1-AC5) ----------
// One event goes through the whole loop in order: each test starts from the
// state the previous one left, so they must run in this file's order.
describe("request clarification and resubmit through the API (SPM-41)", () => {
  let eventId;
  const key = (name) => `spm41-${runId}-${name}`;

  const call = async (method, path, account, body, idempotencyKey) => {
    let req = request(app)[method](path).set("Authorization", `Bearer ${(await signIn(account)).access_token}`);
    if (idempotencyKey) req = req.set("Idempotency-Key", idempotencyKey);
    return body === undefined ? req : req.send(body);
  };
  const requestClarification = (account, body, idempotencyKey) =>
    call("post", `/api/events/${eventId}/clarifications`, account, body, idempotencyKey);
  const resubmit = (account, body, idempotencyKey) => call("post", `/api/events/${eventId}/resubmit`, account, body, idempotencyKey);

  const eventState = async (id = eventId) =>
    (await admin.query(
      "SELECT status::text AS status, version, coordinator_id, title, expected_attendance FROM public.event WHERE event_id = $1",
      [id]
    )).rows[0];
  const storedRounds = async () =>
    (await admin.query(
      "SELECT round_number, status, message, response, requested_by, responded_by FROM public.clarifications WHERE event_id = $1 ORDER BY round_number",
      [eventId]
    )).rows;
  const notificationsFor = async (account) =>
    (await admin.query(
      `SELECT n.title, n.message FROM public.notification AS n
         JOIN public.notification_recipient AS r ON r.notification_id = n.notification_id
        WHERE n.event_id = $1 AND r.recipient_id = $2 ORDER BY n.notification_id`,
      [eventId, userId(account)]
    )).rows;
  const historyEntries = async (action) =>
    (await admin.query(
      "SELECT log_id, user_id, action, details, actor_role, changes, audience, \"timestamp\" FROM public.activity_log WHERE entity_name = 'event' AND entity_id = $1 AND action = $2 ORDER BY log_id",
      [eventId, action]
    )).rows;

  const QUESTION = "Please confirm the stage size and whether you need a lectern.";

  beforeAll(async () => {
    // Owner organiserA2; organiserA is the same-organisation colleague.
    eventId = fixtures.events.colleagueSubmitted;
    await admin.query("UPDATE public.event SET status = 'UNDER_REVIEW' WHERE event_id = $1", [eventId]);
  });

  test("[SPM-41-TC-02] should_refuse_an_empty_message_and_leave_the_event_under_review", async () => {
    const before = await eventState();

    const res = await requestClarification("coordinator", { message: "   ", version: before.version }, key("empty"));

    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("message");
    expect(await eventState()).toEqual(before);
    expect(await storedRounds()).toEqual([]);
  });

  test("[SPM-41-AC1] should_answer_404_to_a_coordinator_who_is_not_assigned", async () => {
    const before = await eventState();

    const res = await requestClarification("coordinatorTwo", { message: QUESTION, version: before.version }, key("wrong"));

    expect(res.status).toBe(404);
    expect(await eventState()).toEqual(before);
    expect(await storedRounds()).toEqual([]);
  });

  test("[SPM-41-AC1] should_answer_409_with_the_current_event_for_a_stale_version", async () => {
    const before = await eventState();

    const res = await requestClarification("coordinator", { message: QUESTION, version: before.version - 1 }, key("stale"));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_VERSION_CONFLICT");
    expect(res.body.event).toEqual(expect.objectContaining({ eventId, version: before.version }));
    expect(await eventState()).toEqual(before);
    expect(await storedRounds()).toEqual([]);
  });

  test("[SPM-41-TC-01] should_return_the_event_store_the_round_and_notify_the_owner", async () => {
    const before = await eventState();

    const res = await requestClarification("coordinator", { message: QUESTION, version: before.version }, key("request-1"));

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual(expect.objectContaining({ status: "AWAITING_CLARIFICATION", version: before.version + 1 }));
    expect(res.body.event.permissions).toEqual(expect.objectContaining({ canRequestClarification: false, canResubmit: false }));
    expect(res.body.clarification).toEqual(expect.objectContaining({
      round: 1,
      status: "OPEN",
      message: QUESTION,
      requestedBy: { userId: userId("coordinator"), name: expect.any(String) },
    }));
    expect(await eventState()).toEqual(expect.objectContaining({ status: "AWAITING_CLARIFICATION", coordinator_id: userId("coordinator") }));
    expect(await storedRounds()).toEqual([expect.objectContaining({ round_number: 1, status: "OPEN", message: QUESTION })]);
    const notes = await notificationsFor("organiserA2");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Clarification requested");
    expect(notes[0].message).toContain(QUESTION);
  });

  test("[SPM-41-TC-05] should_keep_an_immutable_timestamped_audit_entry_with_the_coordinator_and_full_question", async () => {
    const [entry] = await historyEntries("CLARIFICATION_REQUESTED");

    expect(entry).toEqual(expect.objectContaining({
      user_id: userId("coordinator"),
      actor_role: "COORDINATOR",
      audience: "ORGANISER_SAFE",
      changes: { status: { before: "UNDER_REVIEW", after: "AWAITING_CLARIFICATION" } },
    }));
    expect(entry.details).toContain(QUESTION);
    expect(entry.timestamp).toBeInstanceOf(Date);

    const updated = await supabase.from("activity_log").update({ details: "Tampered." }).eq("log_id", entry.log_id);
    const deleted = await supabase.from("activity_log").delete().eq("log_id", entry.log_id);
    expect(updated.error).toEqual(expect.objectContaining({ code: "42501" }));
    expect(deleted.error).toEqual(expect.objectContaining({ code: "42501" }));
    expect((await historyEntries("CLARIFICATION_REQUESTED"))[0].details).toBe(entry.details);

    // The owner reads the same entry in their history.
    const history = await call("get", `/api/events/${eventId}/history`, "organiserA2");
    expect(JSON.stringify(history.body)).toContain(QUESTION);
  });

  test("[SPM-41-AC1] should_replay_a_retried_request_without_a_second_round_or_notification", async () => {
    const res = await requestClarification("coordinator", { message: QUESTION, version: (await eventState()).version - 1 }, key("request-1"));
    const reused = await requestClarification("coordinator", { message: "A different question.", version: 1 }, key("request-1"));

    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await storedRounds()).toHaveLength(1);
    expect(await notificationsFor("organiserA2")).toHaveLength(1);
  });

  test("[SPM-41-TC-03] should_block_planning_actions_and_direct_edits_while_the_event_is_returned", async () => {
    const before = await eventState();

    const action = await call("post", `/api/events/${eventId}/submit-for-safety-review`, "coordinator", { version: before.version });
    const edit = await call("put", `/api/events/${eventId}`, "coordinator", { title: "Coordinator edit", version: before.version }, key("edit"));

    expect(action.status).toBe(403);
    expect(action.body).toEqual(expect.objectContaining({ code: "TRANSITION_NOT_ALLOWED", currentStatus: "AWAITING_CLARIFICATION" }));
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe("EVENT_NOT_EDITABLE_IN_STATUS");
    expect(await eventState()).toEqual(before);
  });

  test("[SPM-41-AC3] should_offer_resubmit_to_the_owner_only", async () => {
    const owner = await call("get", `/api/events/${eventId}`, "organiserA2");
    const colleague = await call("get", `/api/events/${eventId}`, "organiserA");

    expect(owner.body.event.permissions.canResubmit).toBe(true);
    expect(colleague.body.event.permissions.canResubmit).toBe(false);
  });

  test("[SPM-41-AC3] should_answer_403_when_a_same_organisation_organiser_resubmits", async () => {
    const before = await eventState();

    const res = await resubmit("organiserA", { response: "Answering for them.", version: before.version }, key("colleague"));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EVENT_READ_ONLY");
    expect(await eventState()).toEqual(before);
    expect((await storedRounds())[0].status).toBe("OPEN");
  });

  test("[SPM-41-AC3] should_roll_back_everything_when_the_amended_dates_clash_with_the_coordinators_schedule", async () => {
    const before = await eventState();

    // "reassignable" holds the same coordinator on 2027-03-10 10:00-12:00.
    const res = await resubmit("organiserA2", {
      response: "Moved to the 10th.",
      changes: { title: "Should not be saved", startDatetime: "2027-03-10T10:30:00Z", endDatetime: "2027-03-10T11:30:00Z" },
      version: before.version,
    }, key("clash"));

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "COORDINATOR_CONFLICT",
      error: "The new dates clash with your coordinator's schedule. Choose different dates or contact your coordinator.",
    });
    expect(await eventState()).toEqual(before);
    expect(await storedRounds()).toEqual([expect.objectContaining({ status: "OPEN", response: null })]);
    expect(await historyEntries("CLARIFICATION_AMENDED")).toEqual([]);
    expect(await notificationsFor("coordinator")).toEqual([]);
  });

  test("[SPM-41-AC3] should_roll_back_the_amended_fields_when_a_later_step_of_the_resubmit_fails", async () => {
    const before = await eventState();

    // The title update succeeds inside the function; the venue preference write
    // after it fails its foreign key, so the whole call must leave nothing behind.
    let error = null;
    try {
      await admin.query(
        "SELECT public.resubmit_event_after_clarification($1, $2, $3, 'Answer.', $4::jsonb, '[2147483000]'::jsonb, NULL, NULL, NULL)",
        [eventId, userId("organiserA2"), before.version, JSON.stringify({ title: "Should roll back" })]
      );
    } catch (caught) {
      error = caught;
    }

    expect(error && error.code).toBe("23503");
    expect(await eventState()).toEqual(before);
    expect(await storedRounds()).toEqual([expect.objectContaining({ status: "OPEN", response: null })]);
    expect(await historyEntries("CLARIFICATION_AMENDED")).toEqual([]);
    expect(await historyEntries("EVENT_RESUBMITTED")).toEqual([]);
  });

  test("[SPM-41-AC3] should_refuse_a_resubmit_that_neither_answers_nor_changes_anything", async () => {
    const before = await eventState();

    const res = await resubmit("organiserA2", { changes: { expectedAttendance: before.expected_attendance }, version: before.version }, key("same"));

    expect(res.status).toBe(400);
    expect(res.body.fields.response).toBe("Add a response or change at least one detail before resubmitting.");
    expect(await eventState()).toEqual(before);
  });

  test("[SPM-41-TC-04] should_return_the_event_to_review_with_the_same_coordinator_and_keep_the_round_visible", async () => {
    const before = await eventState();

    const res = await resubmit("organiserA2", {
      response: "The stage is 6m wide; no lectern needed.",
      changes: { title: `${before.title} (amended)`, expectedAttendance: 80 },
      version: before.version,
    }, key("resubmit-1"));

    expect(res.status).toBe(200);
    expect(res.body.event.permissions.canResubmit).toBe(false);
    expect(res.body.clarification).toEqual(expect.objectContaining({
      round: 1,
      status: "RESPONDED",
      response: "The stage is 6m wide; no lectern needed.",
      respondedBy: { userId: userId("organiserA2"), name: expect.any(String) },
    }));
    expect(await eventState()).toEqual(expect.objectContaining({
      status: "UNDER_REVIEW",
      coordinator_id: userId("coordinator"),
      title: `${before.title} (amended)`,
      expected_attendance: 80,
    }));

    const [amended] = await historyEntries("CLARIFICATION_AMENDED");
    expect(amended).toEqual(expect.objectContaining({ user_id: userId("organiserA2"), audience: "ORGANISER_SAFE" }));
    expect(amended.changes).toEqual({
      title: { before: before.title, after: `${before.title} (amended)` },
      expectedAttendance: { before: before.expected_attendance, after: 80 },
    });
    const [resubmitted] = await historyEntries("EVENT_RESUBMITTED");
    expect(resubmitted.details).toContain("no lectern needed");

    const notes = await notificationsFor("coordinator");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Event request resubmitted");

    const rounds = await getRounds(eventId, "coordinator");
    expect(rounds.body.clarifications).toEqual([expect.objectContaining({ round: 1, status: "RESPONDED", message: QUESTION })]);
  });

  test("[SPM-41-AC3] should_replay_a_retried_resubmit_without_a_second_notification", async () => {
    const before = await eventState();
    const [round] = await storedRounds();

    // The same body as the first attempt, made against the version it loaded.
    const res = await resubmit("organiserA2", {
      response: round.response,
      changes: { title: before.title, expectedAttendance: 80 },
      version: before.version - 2,
    }, key("resubmit-1"));

    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(await eventState()).toEqual(before);
    expect(await notificationsFor("coordinator")).toHaveLength(1);
  });

  test("[SPM-41-AC1] should_keep_every_round_when_the_event_is_returned_again", async () => {
    const question = "Thanks. Can you also confirm catering numbers?";
    const asked = await requestClarification("coordinator", { message: question, version: (await eventState()).version }, key("request-2"));
    expect(asked.status).toBe(200);
    expect(asked.body.clarification).toEqual(expect.objectContaining({ round: 2, status: "OPEN" }));

    // Answered with amendments only.
    const answered = await resubmit("organiserA2", { changes: { expectedAttendance: 90 }, version: (await eventState()).version }, key("resubmit-2"));
    expect(answered.status).toBe(200);
    expect(answered.body.clarification).toEqual(expect.objectContaining({ round: 2, status: "RESPONDED", response: null }));

    expect(await storedRounds()).toEqual([
      expect.objectContaining({ round_number: 1, status: "RESPONDED", message: QUESTION }),
      expect.objectContaining({ round_number: 2, status: "RESPONDED", message: question, response: null, responded_by: userId("organiserA2") }),
    ]);
    const rounds = await getRounds(eventId, "organiserA");
    expect(rounds.body.clarifications.map(({ round }) => round)).toEqual([2, 1]);
    expect(await eventState()).toEqual(expect.objectContaining({ status: "UNDER_REVIEW", coordinator_id: userId("coordinator"), expected_attendance: 90 }));
  });

  test("[SPM-41-AC3] should_answer_409_when_a_returned_event_has_no_open_round", async () => {
    const soloEvent = fixtures.events.soloSubmitted;
    await admin.query("UPDATE public.event SET status = 'AWAITING_CLARIFICATION' WHERE event_id = $1", [soloEvent]);
    const before = await eventState(soloEvent);

    const res = await call("post", `/api/events/${soloEvent}/resubmit`, "organiserSolo", { response: "Answer.", version: before.version }, key("no-round"));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CLARIFICATION_NOT_OPEN");
    expect(await eventState(soloEvent)).toEqual(before);
  });
});
