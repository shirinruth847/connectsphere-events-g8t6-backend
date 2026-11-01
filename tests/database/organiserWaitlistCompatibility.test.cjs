// Organiser persistence and the existing attendee waitlist functions together.
// Isolated PostgreSQL only; no hosted data or attendee functions are changed.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  openWaitlistDatabase, createEvent, one, rows, query, applyMigration,
  A, B, C, registerDirect, join, withdraw, accept, openOfferOf, availabilityOf,
} = require("../fixtures/waitlistDatabase");
const read = (name) => fs.readFileSync(path.join(__dirname, "../../supabase/migrations", name), "utf8");
const functionSql = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, name);
  return match[0];
};

before(async () => {
  await openWaitlistDatabase();
  // Add the organiser columns/tables omitted from the reduced waitlist fixture.
  await query(`ALTER TABLE public.event
    ADD COLUMN purpose text, ADD COLUMN description text, ADD COLUMN technical_support_needs text,
    ADD COLUMN expected_attendance integer, ADD COLUMN preferred_layout_type text,
    ADD COLUMN accessibility_needs text, ADD COLUMN updated_at timestamptz DEFAULT now()`);
  await query("CREATE TABLE public.event_venue_preference (event_id integer, venue_id integer, preference_order integer)");
  await query("CREATE TABLE public.event_equipment_requirement (event_id integer, equipment_id integer, quantity_requested integer)");
  const base = read("20261007024516_atomic_event_submission.sql");
  await query(functionSql(base, "_replace_event_requirements"));
  await query(functionSql(base, "_event_response"));
  const before = await rows("SELECT oid,prosrc FROM pg_proc WHERE proname IN ('join_event_waitlist','accept_waitlist_offer','_waitlist_offer_deadline','_offer_freed_places') ORDER BY oid");
  await applyMigration("20261101124431_organiser_registration_window.sql");
  assert.deepEqual(await rows("SELECT oid,prosrc FROM pg_proc WHERE proname IN ('join_event_waitlist','accept_waitlist_offer','_waitlist_offer_deadline','_offer_freed_places') ORDER BY oid"), before);
});

const withSavedWindow = async (opensIn, closesIn) => {
  const id = await createEvent({ capacity: 1 });
  await query("UPDATE public.event SET status='DRAFT' WHERE event_id=$1", [id]);
  const { fields } = await one(`SELECT jsonb_build_object(
    'registration_open_at',now()+$1::interval,'registration_close_at',now()+$2::interval) AS fields`, [opensIn, closesIn]);
  const saved = await one("SELECT public.save_event_draft(1,$1,$2::jsonb,NULL,NULL,true,NULL,NULL,NULL) AS result", [id, JSON.stringify(fields)]);
  assert.equal(Date.parse(saved.result.event.registration_close_at), Date.parse(fields.registration_close_at));
  // Fixture publishes the saved draft; lifecycle behaviour is covered separately.
  await query("UPDATE public.event SET status='CONFIRMED',is_published=true WHERE event_id=$1", [id]);
  return id;
};

test("saved opening and closing dates gate attendee waitlist joins", async () => {
  const future = await withSavedWindow("1 day", "2 days");
  assert.equal(await availabilityOf(future), "NOT_YET_OPEN");
  await assert.rejects(join(A, future), /REGISTRATION_NOT_YET_OPEN/);
  const closed = await withSavedWindow("-2 days", "-1 day");
  assert.equal(await availabilityOf(closed), "CLOSED");
  await assert.rejects(join(A, closed), /REGISTRATION_CLOSED/);
});

test("saved dates preserve queue priority, offer promotion and acceptance", async () => {
  const id = await withSavedWindow("-1 day", "2 days");
  await registerDirect(A, id);
  assert.equal((await join(B, id)).registration.waitlist_position, 1);
  assert.equal((await join(C, id)).registration.waitlist_position, 2);
  await withdraw(A, id);
  const offer = await openOfferOf(B, id);
  assert.ok(offer);
  assert.equal(await openOfferOf(C, id), undefined);
  assert.equal((await accept(B, id, offer.offer_id)).registration.registration_status, "REGISTERED");
});

test("saved registration close caps an offered place's deadline", async () => {
  const id = await withSavedWindow("-1 day", "1 hour");
  await registerDirect(A, id);
  await join(B, id);
  await withdraw(A, id);
  const offer = await openOfferOf(B, id);
  const event = await one("SELECT registration_close_at FROM public.event WHERE event_id=$1", [id]);
  assert.equal(new Date(offer.expires_at).getTime(), new Date(event.registration_close_at).getTime());
});
