// SPM-72 follow-up: the coordinator's venue list for the organiser. Venues
// outside the organiser's choices open a clarification (or add a message to
// the open one); the organiser's own choices only notify. Real migration
// functions in a reduced, isolated PostgreSQL fixture; no hosted writes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8");
const functionSql = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, name);
  return match[0];
};
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const COORDINATOR = 2;
const EVENT = 10;

let keyCounter = 0;
const suggest = async (db, venueIds, expected, { note = null, actor = COORDINATOR, key = `spm72-list-${(keyCounter += 1)}` } = {}) =>
  (await one(db, "SELECT public.suggest_event_venues($1,$2,$3::int[],$4::int[],$5,$6,$7) AS result",
    [actor, EVENT, venueIds, expected, note, key, "d".repeat(64)])).result;
const listed = async (db) =>
  (await db.query("SELECT venue_id FROM public.event_suggested_venue WHERE event_id=$1 AND withdrawn_at IS NULL ORDER BY venue_id", [EVENT])).rows.map((row) => row.venue_id);
const status = async (db) => (await one(db, "SELECT status::text AS status FROM public.event WHERE event_id=$1", [EVENT])).status;
const rounds = async (db) => (await db.query("SELECT round_number, status FROM public.clarifications WHERE event_id=$1 ORDER BY round_number", [EVENT])).rows;

async function setup({ eventStatus = "UNDER_REVIEW" } = {}) {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm177DatabaseSchema.sql"), "utf8"));
  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(idempotency.slice(idempotency.indexOf("CREATE TABLE public.idempotency_records"), idempotency.indexOf("-- The signatures change")));
  const base = read("20261007024516_atomic_event_submission.sql");
  await db.exec(functionSql(base, "_event_response"));
  await db.exec("CREATE TABLE public.venue_booking (booking_id integer PRIMARY KEY)");
  await db.exec(read("20261019075314_spm244_safety_reviews.sql"));
  const lifecycle = read("20261019075510_spm173_lifecycle_transitions.sql");
  for (const name of ["_lifecycle_transitions", "_check_event_transition", "_apply_event_transition", "_notify_event_users", "_active_users_with_role"]) {
    await db.exec(functionSql(lifecycle, name));
  }
  await db.exec(functionSql(read("20261012120000_spm33_event_edit_history.sql"), "_bump_event_version"));
  await db.exec("CREATE TRIGGER event_bump_version BEFORE UPDATE ON public.event FOR EACH ROW EXECUTE FUNCTION public._bump_event_version()");
  for (const name of ["20261019171635_spm41_clarification_rounds.sql", "20261024025349_spm41_clarification_lifecycle.sql", "20261024120000_spm41_clarification_threads.sql"]) {
    await db.exec(read(name));
  }
  // The live venue table and notification types carry these; the reduced fixture does not.
  await db.exec(`ALTER TABLE public.venue ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE';
    ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'VENUE_SUGGESTION'`);
  await db.exec(read("20261023041519_spm72_event_venue_suggestion.sql"));
  await db.exec(`INSERT INTO public.venue (venue_id,name,address,max_capacity,is_active,status) VALUES
    (1,'SPM-72 Hall','1 Synthetic Road',300,true,'ACTIVE'),(2,'SPM-72 Breakout','1 Synthetic Road',160,true,'ACTIVE'),
    (3,'SPM-72 Studio','1 Synthetic Road',200,true,'ACTIVE'),(4,'SPM-72 Closed','1 Synthetic Road',500,true,'UNDER_MAINTENANCE'),
    (5,'SPM-72 Booth','1 Synthetic Road',40,true,'ACTIVE')`);
  await db.exec(`INSERT INTO public."user" (user_id,email,name,role,is_active) VALUES
    (1,'spm72-owner@example.test','Owner','ORGANISER',true),
    (2,'spm72-coordinator@example.test','Coordinator','COORDINATOR',true),
    (3,'spm72-other@example.test','Other coordinator','COORDINATOR',true)`);
  await db.exec(`INSERT INTO public.event (event_id,organiser_id,coordinator_id,title,purpose,description,start_datetime,end_datetime,expected_attendance,preferred_layout_type,status)
    VALUES (${EVENT},1,${COORDINATOR},'SPM-72 synthetic request','Forum','Synthetic event','2035-01-01T01:00:00Z','2035-01-01T10:00:00Z',150,'NO_PREFERENCE','${eventStatus}')`);
  await db.exec(`INSERT INTO public.event_venue_preference (event_id,venue_id,preference_order) VALUES (${EVENT},1,1)`);
  // An SPM-72 single suggestion made before the list existed.
  await db.exec(`INSERT INTO public.event_venue_suggestion (event_id,venue_id,suggested_by) VALUES (${EVENT},1,${COORDINATOR})`);
  await db.exec(read("20261101150000_spm72_venue_suggestion_list.sql"));
  return db;
}

test("[SPM-72] the earlier single suggestion is carried into the list", async () => {
  const db = await setup();
  try {
    assert.deepEqual(await listed(db), [1]);
  } finally { await db.close(); }
});

test("[SPM-72] selecting one of the organiser's choices notifies them without a clarification", async () => {
  const db = await setup();
  try {
    await db.exec(`DELETE FROM public.event_suggested_venue WHERE event_id=${EVENT}`);
    const result = await suggest(db, [1], []);
    assert.equal(result.clarification, null);
    assert.deepEqual(result.suggestions.map((item) => [item.venueId, item.fromOrganiserChoices]), [[1, true]]);
    assert.equal(await status(db), "UNDER_REVIEW");
    const notice = await one(db, "SELECT title, message FROM public.notification WHERE event_id=$1 ORDER BY notification_id DESC LIMIT 1", [EVENT]);
    assert.equal(notice.title, "Venue selected");
    assert.match(notice.message, /SPM-72 Hall/);
  } finally { await db.close(); }
});

test("[SPM-72] suggesting other venues opens one clarification naming them, with the note", async () => {
  const db = await setup();
  try {
    const result = await suggest(db, [1, 3, 2], [1], { note: "The studio has a stage." });
    assert.equal(result.clarification.round_number, 1);
    assert.deepEqual(await listed(db), [1, 2, 3]);
    assert.equal(await status(db), "AWAITING_CLARIFICATION");
    const message = await one(db, "SELECT body FROM public.clarification_messages ORDER BY message_id DESC LIMIT 1");
    assert.match(message.body, /^Suggested venues: SPM-72 Studio, SPM-72 Breakout\./);
    assert.match(message.body, /The studio has a stage\.$/);
    const log = await one(db, "SELECT changes FROM public.activity_log WHERE action='VENUE_SUGGESTED' ORDER BY log_id DESC LIMIT 1");
    assert.deepEqual(log.changes.suggestedVenue, { before: "SPM-72 Hall", after: "SPM-72 Hall, SPM-72 Studio, SPM-72 Breakout" });
  } finally { await db.close(); }
});

test("[SPM-72] a later suggestion during the clarification adds a message to the open thread", async () => {
  const db = await setup();
  try {
    await suggest(db, [1, 3], [1]);
    await suggest(db, [1, 3, 2], [1, 3]);
    assert.deepEqual((await rounds(db)).map((round) => round.round_number), [1]);
    const count = await one(db, "SELECT count(*)::int AS n FROM public.clarification_messages");
    assert.equal(count.n, 2);
  } finally { await db.close(); }
});

test("[SPM-72] taking a venue off the list withdraws it and a stale list is refused", async () => {
  const db = await setup();
  try {
    await suggest(db, [1, 3], [1]);
    await assert.rejects(suggest(db, [1], [1]), /VENUE_SUGGESTION_VERSION_CONFLICT/);
    const result = await suggest(db, [3], [3, 1]);
    assert.deepEqual(result.suggestions.map((item) => item.venueId), [3]);
    assert.deepEqual(await listed(db), [3]);
    // Withdrawn, not deleted: the row stays for the record.
    const kept = await one(db, "SELECT withdrawn_at IS NOT NULL AS withdrawn FROM public.event_suggested_venue WHERE event_id=$1 AND venue_id=1", [EVENT]);
    assert.equal(kept.withdrawn, true);
  } finally { await db.close(); }
});

test("[SPM-72] unavailable, too small or repeated venues, other coordinators and planning are refused", async () => {
  const db = await setup();
  try {
    await assert.rejects(suggest(db, [1, 4], [1]), /VENUE_NOT_SELECTABLE/);
    await assert.rejects(suggest(db, [1, 5], [1]), /VENUE_CAPACITY_TOO_SMALL/);
    await assert.rejects(suggest(db, [3, 3], [1]), /INVALID_VENUE_SUGGESTION/);
    await assert.rejects(suggest(db, [3], [1], { actor: 3 }), /EVENT_NOT_FOUND/);
    await db.exec(`UPDATE public.event SET status='PLANNING' WHERE event_id=${EVENT}`);
    await assert.rejects(suggest(db, [3], [1]), /VENUE_SUGGESTION_NOT_ALLOWED_IN_STATUS/);
    assert.deepEqual(await listed(db), [1]);
  } finally { await db.close(); }
});

test("[SPM-72] a repeated request with the same key is answered once", async () => {
  const db = await setup();
  try {
    const first = await suggest(db, [1, 3], [1], { key: "spm72-list-replay" });
    const again = await suggest(db, [1, 3], [1], { key: "spm72-list-replay" });
    assert.deepEqual(again.suggestions, first.suggestions);
    assert.equal((await rounds(db)).length, 1);
  } finally { await db.close(); }
});
