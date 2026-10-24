// DEV SEED ONLY (SPM-155). Gives the synthetic seed attendee one example of
// each attendee notification so the Notifications page can be checked by hand.
// Never run against production; never used by the application.
//
//   npm run seed:notifications
//   npm run seed:notifications:cleanup
//
// Requires the SPM-155 migrations, the seed accounts (npm run seed:accounts)
// and TEST_DATABASE_URL: the notification helpers are private to the database
// owner, as they are for the workflow functions that will call them.
//
// Creates unpublished "[DEV SEED SPM-155]" events owned by the seed organiser:
//   Registered   registration confirmed, then a date change
//   Waitlisted   waitlist place, then a place offer expiring in 48 hours
//   Cancelled    registration confirmed, then cancellation
//   Tomorrow     registration confirmed; starts in 23 hours, so the reminder
//                job adds its reminder once the server is running
//   Hidden       a notification addressed to the attendee for an event they
//                are not registered for; the inbox must not show it (AC6)
// Everything is written in one transaction and recorded in a manifest;
// cleanup removes exactly those events with their registrations and
// notifications, including the job's reminder.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const namespace = process.env.SEED_NAMESPACE || "dev";
const attendeeEmail = `${namespace}-attendee@connectsphere.test`;
const organiserEmail = `${namespace}-organiser-a@connectsphere.test`;
const TITLE_PREFIX = "[DEV SEED SPM-155]";
const manifestPath = path.join(__dirname, "manifests", `attendee-notifications-${namespace}.json`);

const HOUR_MS = 60 * 60 * 1000;
const at = (hoursFromNow) => new Date(Date.now() + hoursFromNow * HOUR_MS).toISOString();
const plusHours = (iso, hours) => new Date(Date.parse(iso) + hours * HOUR_MS).toISOString();

const withClient = async (operation) => {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required: the notification helpers run only as the database owner.");
  }
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
};

const inTransaction = (client, operation) =>
  client.query("BEGIN")
    .then(() => operation())
    .then(async (result) => { await client.query("COMMIT"); return result; })
    .catch(async (error) => { await client.query("ROLLBACK"); throw error; });

const findSeedUser = async (client, email, role) => {
  const { rows } = await client.query('SELECT user_id FROM public."user" WHERE email = $1 AND role = $2 AND is_active', [email, role]);
  if (!rows.length) throw new Error(`No active ${role} seed profile for ${email}. Run npm run seed:accounts first.`);
  return rows[0].user_id;
};

const seed = async () => {
  if (fs.existsSync(manifestPath)) {
    throw new Error(`Already seeded (${path.basename(manifestPath)}). Run npm run seed:notifications:cleanup first.`);
  }
  const manifest = await withClient(async (client) => {
    const attendeeId = await findSeedUser(client, attendeeEmail, "ATTENDEE");
    const organiserId = await findSeedUser(client, organiserEmail, "ORGANISER");
    const one = async (sql, values) => (await client.query(sql, values)).rows[0];

    return inTransaction(client, async () => {
      const created = { namespace, attendeeId, eventIds: [], registrationIds: [] };
      const createEvent = async (label, start) => {
        const { event_id: eventId } = await one(
          `INSERT INTO public.event (organiser_id, title, description, status, start_datetime, end_datetime, is_published)
           VALUES ($1, $2, 'Synthetic development data for SPM-155. Safe to delete.', 'CONFIRMED', $3, $4, false)
           RETURNING event_id`,
          [organiserId, `${TITLE_PREFIX} ${label}`, start, plusHours(start, 2)]
        );
        created.eventIds.push(eventId);
        return eventId;
      };
      const register = async (eventId, status, registeredAt = new Date().toISOString()) => {
        const { registration_id: registrationId } = await one(
          `INSERT INTO public.registration (attendee_id, event_id, registration_status, registration_datetime)
           VALUES ($1, $2, $3, $4) RETURNING registration_id`,
          [attendeeId, eventId, status, registeredAt]
        );
        created.registrationIds.push(registrationId);
        await client.query("SELECT public._notify_registration_recorded($1)", [registrationId]);
        return registrationId;
      };

      const registeredStart = at(24 * 7);
      const registered = await createEvent("Registered", registeredStart);
      await register(registered, "REGISTERED");
      await client.query("UPDATE public.event SET start_datetime = $2, end_datetime = $3 WHERE event_id = $1", [registered, plusHours(registeredStart, 24), plusHours(registeredStart, 26)]);
      await client.query(
        "SELECT public._notify_event_changed_attendees($1, $2::jsonb, $3::jsonb)",
        [registered, JSON.stringify({ start_datetime: registeredStart }), JSON.stringify({ start_datetime: plusHours(registeredStart, 24) })]
      );

      const waitlisted = await createEvent("Waitlisted", at(24 * 10));
      const waitlistedRegistration = await register(waitlisted, "WAITLISTED");
      // No offers table yet (SPM-163); the registration ID stands in for the offer ID.
      await client.query("SELECT public._notify_place_offered($1, $2, $3)", [waitlistedRegistration, waitlistedRegistration, at(48)]);

      const cancelled = await createEvent("Cancelled", at(24 * 14));
      await register(cancelled, "REGISTERED");
      await client.query("SELECT public._notify_event_cancelled_attendees($1)", [cancelled]);
      await client.query("UPDATE public.event SET status = 'CANCELLED' WHERE event_id = $1", [cancelled]);

      const tomorrow = await createEvent("Tomorrow", at(23));
      await register(tomorrow, "REGISTERED", at(-72));

      const hidden = await createEvent("Hidden (not registered)", at(24 * 20));
      await client.query(
        "SELECT public._notify_event_users($1, $2, $3, ARRAY[$4]::integer[], 'STATUS_CHANGE', NULL, NULL)",
        [hidden, `${TITLE_PREFIX} Must stay hidden`, "If you can see this, AC6 filtering is broken.", attendeeId]
      );
      return created;
    });
  });

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Seeded ${manifest.eventIds.length} events for ${attendeeEmail}: ${manifest.eventIds.join(", ")}.`);
  console.log("Expect 7 visible notifications now, plus 1 reminder once the server's reminder job runs; 1 more must stay hidden.");
};

const cleanup = async () => {
  if (!fs.existsSync(manifestPath)) {
    console.log("Nothing to clean up.");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const remaining = await withClient(async (client) => {
    await inTransaction(client, async () => {
      // Only events this seed created, and only while they still carry its label.
      const { rows } = await client.query(
        "SELECT event_id FROM public.event WHERE event_id = ANY($1::integer[]) AND title LIKE $2 FOR UPDATE",
        [manifest.eventIds, `${TITLE_PREFIX}%`]
      );
      const eventIds = rows.map((row) => row.event_id);
      await client.query("DELETE FROM public.notification WHERE event_id = ANY($1::integer[])", [eventIds]);
      await client.query("DELETE FROM public.registration WHERE registration_id = ANY($1::integer[]) AND event_id = ANY($2::integer[])", [manifest.registrationIds, eventIds]);
      await client.query("DELETE FROM public.event WHERE event_id = ANY($1::integer[])", [eventIds]);
    });
    const { rows } = await client.query(
      `SELECT (SELECT count(*) FROM public.event WHERE event_id = ANY($1::integer[]))::int AS events,
              (SELECT count(*) FROM public.registration WHERE registration_id = ANY($2::integer[]))::int AS registrations,
              (SELECT count(*) FROM public.notification WHERE event_id = ANY($1::integer[]))::int AS notifications`,
      [manifest.eventIds, manifest.registrationIds]
    );
    return rows[0];
  });
  if (remaining.events || remaining.registrations || remaining.notifications) {
    throw new Error(`Cleanup incomplete: ${JSON.stringify(remaining)}. The manifest was kept.`);
  }
  fs.rmSync(manifestPath, { force: true });
  console.log(`Removed ${manifest.eventIds.length} seed events with their registrations and notifications.`);
};

(process.argv[2] === "cleanup" ? cleanup() : seed()).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
