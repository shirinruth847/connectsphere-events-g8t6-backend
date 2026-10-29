// Gives the seed Safety Officer events to review (SPM-243).
//
//   npm run seed:safety-reviews
//   npm run seed:safety-reviews:cleanup
//
// Each event is set up in PLANNING with one approved booking at a core seed
// venue and approved equipment, then goes through the real database functions:
// the seed coordinator submits it for safety review, and for the third event the
// seed Safety Officer claims round 1, requests changes, the coordinator resubmits
// and the officer claims round 2.
//
//   Riverside Community Fair  Awaiting review
//   Harbour Tech Expo         Awaiting review
//   Night Market Showcase     My reviews, round 2, with round 1's requested changes
//
// Requires npm run seed:accounts, the core seed venues and equipment
// (manifests/core-dev.json) and TEST_DATABASE_URL for cleanup, because rounds and
// history can only be removed through the privileged test connection. Re-running
// removes the previous set first. Created IDs are recorded in
// manifests/safety-reviews-<namespace>.json as they are made.
const fs = require("fs");
const path = require("path");
const supabase = require("../../config/supabase");

const namespace = process.env.SEED_NAMESPACE || "dev";
const TITLE_PREFIX = `${namespace} SPM-243 `;
const manifestPath = path.join(__dirname, "manifests", `safety-reviews-${namespace}.json`);

// Core seed venues and equipment, found by name so the IDs need not be known.
// Hours are Singapore time (UTC+8), in November 2028 when these venues are free.
const SCENARIOS = [
  {
    title: "Riverside Community Fair",
    purpose: "Family fair with food stalls and a small stage",
    venue: "[seed:dev] Grand Hall",
    layout: "Theater",
    day: 10,
    hours: [9, 17],
    attendance: 150,
    accessibility: ["Step-free access", "Hearing loop"],
    equipment: [{ name: "[seed:dev] PA Speaker System", quantity: 2, notes: "Either side of the stage, 2 m clear of both fire exits" }],
  },
  {
    title: "Harbour Tech Expo",
    purpose: "Product demonstrations with a keynote",
    venue: "[seed:dev] East Wing Auditorium",
    layout: "Theater",
    day: 12,
    hours: [10, 18],
    attendance: 260,
    accessibility: ["Wheelchair spaces in the front row"],
    equipment: [
      { name: "[seed:dev] Laser Projector", quantity: 1, notes: "Rear of the hall on the control desk" },
      { name: "[seed:dev] Portable Stage Riser", quantity: 4, notes: "Across the front, leaving the side aisles open" },
    ],
  },
  {
    title: "Night Market Showcase",
    purpose: "Evening market with live music",
    venue: "[seed:dev] Rooftop Terrace",
    layout: "Workshop / Clusters",
    day: 14,
    hours: [18, 23],
    attendance: 55,
    accessibility: "Lift access to the roof is required.",
    equipment: [{ name: "[seed:dev] Stage Spotlight Kit", quantity: 1, notes: "Clamped to the north railing" }],
    secondRound: true,
  },
];

const SGT_OFFSET_HOURS = 8;
const FACTORS = ["attendanceCapacity", "layout", "emergencyAccess", "accessibility", "equipmentPlacement", "venueRestrictions"];

const check = ({ data, error }, step) => {
  if (error) throw new Error(`${step} failed: ${error.message}`);
  return data;
};

const loadManifest = () => (fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { eventIds: [] });

const saveManifest = (manifest) => {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
};

const seedUser = async (suffix) => {
  const email = `${namespace}-${suffix}@connectsphere.test`;
  const user = check(await supabase.from("user").select("user_id").eq("email", email).eq("is_active", true).maybeSingle(), `find ${email}`);
  if (!user) throw new Error(`No active profile for ${email}. Run npm run seed:accounts first.`);
  return user.user_id;
};

const findOne = async (table, column, value, select) => {
  const row = check(await supabase.from(table).select(select).eq(column, value).maybeSingle(), `find ${table} ${value}`);
  if (!row) throw new Error(`No ${table} named "${value}". Run the core seed first.`);
  return row;
};

const rpc = async (name, args) => check(await supabase.rpc(name, args), name);

const submitForReview = async (eventId, coordinatorId) => {
  const { version } = check(await supabase.from("event").select("version").eq("event_id", eventId).single(), "read event version");
  await rpc("submit_event_for_safety_review", {
    p_event_id: eventId, p_actor_id: coordinatorId, p_expected_version: version, p_idempotency_key: null, p_request_hash: null,
  });
  return check(await supabase.from("safety_reviews").select("review_id").eq("event_id", eventId).eq("status", "OPEN").single(), "read open round");
};

const createScenario = async (scenario, people, manifest) => {
  const venue = await findOne("venue", "name", scenario.venue, "venue_id");
  const room = check(
    await supabase.from("room").select("room_id").eq("venue_id", venue.venue_id).eq("layout_type", scenario.layout).limit(1).single(),
    `find a ${scenario.layout} room at ${scenario.venue}`,
  );
  const [startHour, endHour] = scenario.hours;
  const start = new Date(Date.UTC(2028, 10, scenario.day, startHour - SGT_OFFSET_HOURS)).toISOString();
  const end = new Date(Date.UTC(2028, 10, scenario.day, endHour - SGT_OFFSET_HOURS)).toISOString();

  const event = check(await supabase.from("event").insert({
    title: `${TITLE_PREFIX}${scenario.title}`,
    purpose: scenario.purpose,
    description: "Development-only event created by the SPM-243 safety review seed.",
    organiser_id: people.organiser,
    coordinator_id: people.coordinator,
    status: "PLANNING",
    start_datetime: start,
    end_datetime: end,
    expected_attendance: scenario.attendance,
    preferred_layout_type: scenario.layout,
    accessibility_needs: Array.isArray(scenario.accessibility) ? JSON.stringify(scenario.accessibility) : scenario.accessibility,
    is_registration_enabled: false,
    is_published: false,
  }).select("event_id").single(), `create ${scenario.title}`);
  manifest.eventIds.push(event.event_id);
  saveManifest(manifest);

  check(await supabase.from("event_assignments").insert({
    event_id: event.event_id, coordinator_id: people.coordinator, assigned_by: people.lead,
  }), "assignment history");
  check(await supabase.from("venue_booking").insert({
    event_id: event.event_id, room_id: room.room_id, requested_by: people.coordinator, reviewed_by: people.venueStaff,
    start_datetime: start, end_datetime: end, status: "APPROVED", expected_attendance: scenario.attendance, layout_type: scenario.layout,
    // The event's only booking is its primary venue (Master 5.4.2, SPM-179).
    is_primary: true,
  }), "approved venue booking");
  for (const item of scenario.equipment) {
    const equipment = await findOne("equipment", "name", item.name, "equipment_id");
    check(await supabase.from("equipment_request").insert({
      event_id: event.event_id, equipment_id: equipment.equipment_id, requested_by: people.coordinator, reviewed_by: people.techSupport,
      quantity_requested: item.quantity, start_datetime: start, end_datetime: end, status: "APPROVED", technical_notes: item.notes,
    }), `approved ${item.name}`);
  }

  let round = await submitForReview(event.event_id, people.coordinator);
  if (scenario.secondRound) {
    await rpc("claim_safety_review", { p_review_id: round.review_id, p_actor_id: people.officer });
    const { arrangement_version: arrangementVersion } = check(
      await supabase.from("event").select("arrangement_version").eq("event_id", event.event_id).single(), "read arrangement version",
    );
    await rpc("decide_safety_review", {
      p_review_id: round.review_id,
      p_actor_id: people.officer,
      p_decision: {
        outcome: "CHANGES_REQUESTED",
        checklist: Object.fromEntries(FACTORS.map((factor) => [factor, factor === "emergencyAccess"
          ? { result: "NOT_SATISFACTORY", comment: "Only one stair exit from the roof for 55 people." }
          : { result: "SATISFACTORY", comment: "" }])),
        requestedChanges: ["Add a second stewarded exit route from the roof", "Keep the lift lobby clear during the event"],
        organiserComment: "Please arrange a second stewarded exit from the roof.",
        internalNotes: "Seeded round 1 for testing.",
      },
      p_expected_arrangement_version: arrangementVersion,
      p_idempotency_key: null,
      p_request_hash: null,
    });
    round = await submitForReview(event.event_id, people.coordinator);
    await rpc("claim_safety_review", { p_review_id: round.review_id, p_actor_id: people.officer });
  }
  return { eventId: event.event_id, reviewId: round.review_id, title: scenario.title };
};

// Everything this seed made, in one transaction, after checking that each
// manifest event is one of this seed's. Rounds, notifications and history can
// only be removed through the privileged test connection.
const removeSeedRows = async (client, ids) => {
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT event_id, title FROM public.event WHERE event_id = ANY($1::integer[])", [ids]);
    if (rows.some((row) => !row.title.startsWith(TITLE_PREFIX))) throw new Error("Refusing to remove an event this seed did not create.");
    const statements = [
      "DELETE FROM public.notification_recipient WHERE notification_id IN (SELECT notification_id FROM public.notification WHERE event_id = ANY($1::integer[]))",
      "DELETE FROM public.notification WHERE event_id = ANY($1::integer[])",
      "DELETE FROM public.safety_review_rejected_bookings WHERE review_id IN (SELECT review_id FROM public.safety_reviews WHERE event_id = ANY($1::integer[]))",
      "DELETE FROM public.safety_reviews WHERE event_id = ANY($1::integer[])",
      "DELETE FROM public.activity_log WHERE entity_name = 'event' AND entity_id = ANY($1::integer[])",
      "DELETE FROM public.equipment_request WHERE event_id = ANY($1::integer[])",
      "DELETE FROM public.venue_booking WHERE event_id = ANY($1::integer[])",
      "DELETE FROM public.event_assignments WHERE event_id = ANY($1::integer[])",
      "DELETE FROM public.event WHERE event_id = ANY($1::integer[])",
    ];
    for (const statement of statements) await client.query(statement, [ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

// Master 10.4: verify the cleanup and report anything left.
const verifySeedRowsGone = async (client, ids) => {
  const { rows: [left] } = await client.query(
    `SELECT (SELECT count(*) FROM public.event WHERE event_id = ANY($1::integer[])) AS events,
            (SELECT count(*) FROM public.safety_reviews WHERE event_id = ANY($1::integer[])) AS rounds,
            (SELECT count(*) FROM public.venue_booking WHERE event_id = ANY($1::integer[])) AS bookings,
            (SELECT count(*) FROM public.equipment_request WHERE event_id = ANY($1::integer[])) AS equipment,
            (SELECT count(*) FROM public.notification WHERE event_id = ANY($1::integer[])) AS notifications,
            (SELECT count(*) FROM public.activity_log WHERE entity_name = 'event' AND entity_id = ANY($1::integer[])) AS history`,
    [ids],
  );
  const remaining = Object.entries(left).filter(([, count]) => Number(count) > 0);
  if (remaining.length) {
    throw new Error(`Cleanup left rows behind: ${remaining.map(([table, count]) => `${table} ${count}`).join(", ")}. The manifest is kept.`);
  }
};

const cleanup = async () => {
  const manifest = loadManifest();
  if (manifest.eventIds.length) {
    if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is needed to remove the seeded safety reviews.");
    const { Client } = require("pg");
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
    try {
      await removeSeedRows(client, manifest.eventIds);
      await verifySeedRowsGone(client, manifest.eventIds);
    } finally {
      await client.end();
    }
  }
  fs.rmSync(manifestPath, { force: true });
  console.log(`Removed the SPM-243 safety review events for namespace "${namespace}".`);
};

const seed = async () => {
  await cleanup();
  const people = {
    organiser: await seedUser("organiser-a"),
    coordinator: await seedUser("coordinator"),
    lead: await seedUser("coordinator-lead"),
    venueStaff: await seedUser("venue-staff"),
    techSupport: await seedUser("tech-support"),
    officer: await seedUser("safety-officer"),
  };
  const manifest = { namespace, eventIds: [] };
  saveManifest(manifest);
  for (const scenario of SCENARIOS) {
    const created = await createScenario(scenario, people, manifest);
    console.log(`${created.title}: event ${created.eventId}, review ${created.reviewId}`);
  }
  console.log(`Safety review events ready for ${namespace}-safety-officer@connectsphere.test.`);
};

(process.argv[2] === "cleanup" ? cleanup() : seed()).catch((error) => {
  console.error(error.message);
  console.error("Anything created so far is listed in the manifest; run npm run seed:safety-reviews:cleanup to remove it.");
  process.exitCode = 1;
});
