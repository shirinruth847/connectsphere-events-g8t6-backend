// Creates one reproducible submitted request with no coordinator for SPM-174.
//
//   npm run seed:unassigned
//   npm run seed:unassigned:cleanup
//
// Requires the migration 20261007121500_allow_unassigned_submitted_events.sql
// and an existing seed organiser profile.
const fs = require("fs");
const path = require("path");
const supabase = require("../../config/supabase");

const namespace = process.env.SEED_NAMESPACE || "dev";
const organiserEmail = `${namespace}-organiser-a@connectsphere.test`;
const manifestPath = path.join(__dirname, "manifests", `unassigned-event-${namespace}.json`);

const check = ({ data, error }, step) => {
  if (error) throw new Error(`${step} failed: ${error.message}`);
  return data;
};

const loadManifest = () => (
  fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : { eventIds: [] }
);

const saveManifest = (manifest) => {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
};

const seed = async () => {
  const profile = check(
    await supabase.from("user").select("user_id").eq("email", organiserEmail).maybeSingle(),
    `find organiser ${organiserEmail}`,
  );
  if (!profile) {
    throw new Error(`No organiser profile found for ${organiserEmail}. Run npm run seed:accounts first.`);
  }

  const existing = check(
    await supabase
      .from("event")
      .select("event_id")
      .eq("title", `${namespace} SPM-174 Unassigned Demo Request`)
      .maybeSingle(),
    "find existing unassigned demo event",
  );
  const event = existing
    ? check(
      await supabase
        .from("event")
        .update({ coordinator_id: null, status: "SUBMITTED", is_published: false })
        .eq("event_id", existing.event_id)
        .select("event_id")
        .single(),
      "reset existing unassigned demo event",
    )
    : check(
    await supabase.from("event").insert({
      title: `${namespace} SPM-174 Unassigned Demo Request`,
      purpose: "Synthetic request for coordinator assignment walkthrough",
      description: "Development-only event request created by the SPM-174 seed.",
      accessibility_needs: "None",
      organiser_id: profile.user_id,
      organisation_id: null,
      coordinator_id: null,
      status: "SUBMITTED",
      start_datetime: "2026-10-21T07:00:00Z",
      end_datetime: "2026-10-21T09:00:00Z",
      expected_attendance: 60,
      preferred_layout_type: "THEATRE",
      is_registration_enabled: false,
      is_published: false,
    }).select("event_id").single(),
    "create unassigned demo event",
  );

  const manifest = loadManifest();
  if (!manifest.eventIds.includes(event.event_id)) manifest.eventIds.push(event.event_id);
  saveManifest(manifest);
  console.log(`Unassigned demo event ready: ${event.event_id} (${namespace}).`);
};

const cleanup = async () => {
  const manifest = loadManifest();
  if (manifest.eventIds.length) {
    check(
      await supabase.from("event").delete().in("event_id", manifest.eventIds),
      "delete unassigned demo events",
    );
  }
  fs.rmSync(manifestPath, { force: true });
  console.log(`Removed unassigned demo events for namespace "${namespace}".`);
};

(process.argv[2] === "cleanup" ? cleanup() : seed()).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
