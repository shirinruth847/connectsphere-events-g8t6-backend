// Minimal live fixtures for event registration (SPM-134): login-capable
// accounts, one organisation and, per event, the primary venue that sets its
// registration capacity (Master 5.6). Nothing else: the suite does not depend
// on the shared builder's event, booking and equipment set. Each suite creates
// its own events.
// Accounts are created through Auth Admin, never raw SQL (Master 10.4), and
// use the shared spm32-<run> naming and manifest, so cleanupAuthFixtures and
// npm run test:cleanup remove them like any other run.
const crypto = require("crypto");
const supabase = require("../../config/supabase");
const { startFixtureManifest, recordFixtureIds } = require("./authFixtures");

const TEST_EMAIL_DOMAIN = "connectsphere.test";

const check = ({ data, error }, step) => {
  if (error) throw new Error(`Fixture step "${step}" failed: ${error.message}`);
  return data;
};

// accounts: [{ key, role, organisation? }]; organisation "A" is the only one created.
const createRegistrationFixtures = async (runId, accounts) => {
  const password = `Spm134-${crypto.randomBytes(12).toString("base64url")}`;
  startFixtureManifest(runId);

  const organisationId = check(
    await supabase.from("organisation").insert({ name: `spm32-${runId} Organisation A` }).select("organisation_id").single(),
    "organisation A"
  ).organisation_id;
  recordFixtureIds(runId, "organisationIds", [organisationId]);

  const created = {};
  for (const account of accounts) {
    const email = `spm32-${runId}-${account.key.toLowerCase()}@${TEST_EMAIL_DOMAIN}`;
    const authUser = check(await supabase.auth.admin.createUser({ email, password, email_confirm: true }), `auth user ${account.key}`).user;
    recordFixtureIds(runId, "authUserIds", [authUser.id]);

    const userId = check(
      await supabase
        .from("user")
        .insert({ email, name: `spm32 ${account.key}`, role: account.role, auth_user_id: authUser.id, is_active: true })
        .select("user_id")
        .single(),
      `profile ${account.key}`
    ).user_id;
    recordFixtureIds(runId, "userIds", [userId]);

    if (account.organisation === "A") {
      check(await supabase.from("organisation_membership").insert({ organisation_id: organisationId, user_id: userId }), `membership ${account.key}`);
    }
    created[account.key] = { email, password, authUserId: authUser.id, userId, role: account.role };
  }

  return { runId, accounts: created, organisations: { A: organisationId } };
};

// Gives an event its own synthetic venue and one approved primary booking
// covering the whole event, so the venue's max_capacity is the event's venue
// capacity. A venue per event keeps bookings from ever overlapping.
const bookPrimaryVenue = async (runId, { eventId, requestedBy, startDatetime, endDatetime, capacity }) => {
  const venueId = check(
    await supabase
      .from("venue")
      .insert({ name: `spm32-${runId} Venue ${eventId}`, address: "1 Synthetic Street", max_capacity: capacity })
      .select("venue_id")
      .single(),
    `venue for event ${eventId}`
  ).venue_id;
  recordFixtureIds(runId, "venueIds", [venueId]);

  const roomId = check(
    await supabase.from("room").insert({ venue_id: venueId, layout_type: "THEATRE", capacity }).select("room_id").single(),
    `room for event ${eventId}`
  ).room_id;
  recordFixtureIds(runId, "roomIds", [roomId]);

  const bookingId = check(
    await supabase
      .from("venue_booking")
      .insert({
        event_id: eventId,
        room_id: roomId,
        requested_by: requestedBy,
        start_datetime: startDatetime,
        end_datetime: endDatetime,
        status: "APPROVED",
        is_primary: true,
        reviewed_at: new Date().toISOString(),
      })
      .select("booking_id")
      .single(),
    `primary booking for event ${eventId}`
  ).booking_id;
  recordFixtureIds(runId, "bookingIds", [bookingId]);
  return { venueId, roomId, bookingId };
};

module.exports = { createRegistrationFixtures, bookPrimaryVenue };
