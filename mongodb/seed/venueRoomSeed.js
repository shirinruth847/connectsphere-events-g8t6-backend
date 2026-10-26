// Development venues with rooms (developer request of 24 October 2026). Each
// room is its own bookable venue (Master 6.2: one venue, one independently
// bookable space); a hall and its rooms are linked through
// venue_details.relatedVenueIds, in both directions, for display only. A hall's
// capacity is its rooms' capacities plus its common area.
//
//   1. Creates each venue through the Venue Staff create_venue RPC (as the
//      synthetic <namespace>-venue-staff account), then sets its operating
//      hours on exactly the IDs it created (no RPC sets them).
//   2. Saves its venue_details (layouts, facilities, accessibility, setup and
//      turnaround, related venues) through venueDetailModel, tagged
//      fixture: "spm72-rooms", and adds photos tagged the same way. The photos
//      reuse the Unsplash files of venuePhotoSeed.js.
//   3. Fills supportedLayouts on the [seed:dev] venues whose detail has none,
//      from their legacy PostgreSQL room layouts.
// Every ID it touches is recorded in supabase/seed/manifests/venue-rooms-<ns>.json.
// Cleanup takes the created venues out of service (venues are never deleted;
// rows stay for history), deletes the fixture documents and unsets only the
// layouts it filled.
//
// Usage: node mongodb/seed/venueRoomSeed.js [cleanup]
// Reads MONGODB_URI, MONGODB_DB_NAME and the Supabase settings from .env.
const fs = require("fs");
const path = require("path");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const venueModel = require("../../model/venueModel");
const venueDetailModel = require("../../model/venueDetailModel");
const { detectImageType, MAX_PHOTO_BYTES } = require("../../validators/venuePhotoValidator");
const { GALLERIES } = require("./venuePhotoSeed");

const FIXTURE = "spm72-rooms";
const namespace = process.env.SEED_NAMESPACE || "dev";
const staffEmail = `${namespace}-venue-staff@connectsphere.test`;
const manifestPath = path.join(__dirname, "..", "..", "supabase", "seed", "manifests", `venue-rooms-${namespace}.json`);

// A photo already used by venuePhotoSeed.js: [venue gallery, index].
const photo = (venue, index) => GALLERIES[venue][index];

// Halls first; each room lists its hall. Capacity of a hall = its rooms +
// commonArea. Layout names match the room layouts events can request.
const BUILDINGS = [
  {
    hall: {
      name: "[seed:dev] Harbourfront Convention Centre",
      address: "10 Harbourfront Walk",
      commonArea: 50,
      operatingHours: "07:00-23:00",
      setupMinutes: 60,
      turnaroundMinutes: 60,
      supportedLayouts: ["Theater", "Banquet", "Reception"],
      facilities: ["Stage", "Projector", "PA system", "Cloakroom", "Catering kitchen"],
      accessibilityFeatures: ["Wheelchair access", "Lift to all floors", "Accessible toilets", "Hearing loop"],
      photos: [photo("[seed:dev] Grand Hall", 0), photo("[seed:dev] Grand Hall", 1), photo("[seed:dev] East Wing Auditorium", 1)],
    },
    rooms: [
      {
        name: "[seed:dev] Harbourfront Hall A",
        capacity: 300,
        operatingHours: "07:00-23:00",
        setupMinutes: 45,
        turnaroundMinutes: 30,
        supportedLayouts: ["Theater", "Classroom", "Banquet"],
        facilities: ["Stage", "Projector", "PA system", "Livestream booth"],
        accessibilityFeatures: ["Wheelchair access", "Hearing loop"],
        photos: [photo("[seed:dev] East Wing Auditorium", 0), photo("[seed:dev] East Wing Auditorium", 2)],
      },
      {
        name: "[seed:dev] Harbourfront Hall B",
        capacity: 180,
        operatingHours: "07:00-23:00",
        setupMinutes: 30,
        turnaroundMinutes: 30,
        supportedLayouts: ["Classroom", "Workshop / Clusters", "Banquet"],
        facilities: ["Projector", "Whiteboard", "PA system"],
        accessibilityFeatures: ["Wheelchair access"],
        photos: [photo("[seed:dev] Grand Hall", 2), photo("[seed:dev] Seminar Centre", 1)],
      },
      {
        name: "[seed:dev] Harbourfront Meeting Room 1",
        capacity: 40,
        operatingHours: "08:00-20:00",
        setupMinutes: 15,
        turnaroundMinutes: 15,
        supportedLayouts: ["Boardroom", "Classroom"],
        facilities: ["Video conferencing", "Whiteboard", "TV screen"],
        accessibilityFeatures: ["Wheelchair access"],
        photos: [photo("[seed:dev] Seminar Centre", 0), photo("[seed:dev] Conflict Lab", 1)],
      },
      {
        name: "[seed:dev] Harbourfront Meeting Room 2",
        capacity: 30,
        operatingHours: "08:00-20:00",
        setupMinutes: 15,
        turnaroundMinutes: 10,
        supportedLayouts: ["Boardroom"],
        facilities: ["TV screen", "Whiteboard"],
        accessibilityFeatures: [],
        photos: [photo("[seed:dev] Conflict Lab", 0)],
      },
    ],
  },
  {
    hall: {
      name: "[seed:dev] Riverside Learning Hub",
      address: "22 Riverside Crescent",
      commonArea: 30,
      operatingHours: "08:00-22:00",
      setupMinutes: 30,
      turnaroundMinutes: 30,
      supportedLayouts: ["Reception", "Workshop / Clusters"],
      facilities: ["Wi-Fi", "Breakout lounge", "Coffee station"],
      accessibilityFeatures: ["Wheelchair access", "Accessible toilets"],
      photos: [photo("Innovation Hub", 0), photo("Innovation Hub", 1)],
    },
    rooms: [
      {
        name: "[seed:dev] Riverside Lecture Theatre",
        capacity: 150,
        operatingHours: "08:00-22:00",
        setupMinutes: 20,
        turnaroundMinutes: 20,
        supportedLayouts: ["Theater"],
        facilities: ["Projector", "Lectern", "Lecture capture", "PA system"],
        accessibilityFeatures: ["Wheelchair spaces", "Hearing loop"],
        photos: [photo("Campus Central Hall", 0), photo("Campus Central Hall", 1)],
      },
      {
        name: "[seed:dev] Riverside Seminar Room A",
        capacity: 40,
        operatingHours: "08:00-22:00",
        setupMinutes: 15,
        turnaroundMinutes: 15,
        supportedLayouts: ["Classroom", "Workshop / Clusters"],
        facilities: ["Projector", "Whiteboard"],
        accessibilityFeatures: ["Wheelchair access"],
        photos: [photo("[seed:dev] Seminar Centre", 2)],
      },
      {
        name: "[seed:dev] Riverside Seminar Room B",
        capacity: 40,
        operatingHours: "08:00-18:00",
        setupMinutes: 15,
        turnaroundMinutes: 15,
        supportedLayouts: ["Classroom", "Boardroom"],
        facilities: ["TV screen", "Video conferencing"],
        accessibilityFeatures: [],
        photos: [photo("Innovation Hub", 2)],
      },
    ],
  },
  {
    hall: {
      name: "[seed:dev] Garden Pavilion",
      address: "5 Botanic Lane",
      commonArea: 75,
      operatingHours: "09:00-23:00",
      setupMinutes: 45,
      turnaroundMinutes: 45,
      supportedLayouts: ["Reception", "Banquet"],
      facilities: ["Garden lawn", "Outdoor lighting", "Catering kitchen"],
      accessibilityFeatures: ["Step-free access", "Accessible toilets"],
      photos: [photo("[seed:dev] Rooftop Terrace", 0), photo("[seed:dev] Rooftop Terrace", 2)],
    },
    rooms: [
      {
        name: "[seed:dev] Garden Pavilion Orchid Room",
        capacity: 60,
        operatingHours: "09:00-23:00",
        setupMinutes: 20,
        turnaroundMinutes: 20,
        supportedLayouts: ["Banquet", "Workshop / Clusters"],
        facilities: ["Projector", "Garden view"],
        accessibilityFeatures: ["Step-free access"],
        photos: [photo("The Unforeseen Future", 0)],
      },
      {
        name: "[seed:dev] Garden Pavilion Fern Room",
        capacity: 45,
        operatingHours: "09:00-21:00",
        setupMinutes: 15,
        turnaroundMinutes: 15,
        supportedLayouts: ["Boardroom", "Classroom"],
        facilities: ["TV screen", "Whiteboard"],
        accessibilityFeatures: ["Step-free access"],
        photos: [photo("[seed:dev] Rooftop Terrace", 1)],
      },
    ],
  },
];

// A hall's capacity is its rooms plus its common area.
const hallCapacity = (building) => building.rooms.reduce((sum, room) => sum + room.capacity, 0) + building.hall.commonArea;

const check = ({ data, error }, step) => {
  if (error) throw new Error(`${step} failed: ${error.message}`);
  return data;
};
const loadManifest = () => (fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  : { venueIds: [], layoutsFilled: [] });
const saveManifest = (manifest) => {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
};

const download = async (photoId, file) => {
  const response = await fetch(`https://images.unsplash.com/${file}?w=1600&q=75&fm=jpg`);
  if (!response.ok) throw new Error(`Unsplash ${photoId}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const contentType = detectImageType(data);
  if (!contentType) throw new Error(`Unsplash ${photoId}: not a JPEG/PNG/WebP image`);
  if (data.length > MAX_PHOTO_BYTES) throw new Error(`Unsplash ${photoId}: ${data.length} bytes is over 2 MB`);
  return { data, contentType };
};

const findActor = async () => {
  const profile = check(await supabase.from("user").select("user_id,role").eq("email", staffEmail).maybeSingle(), `find ${staffEmail}`);
  if (!profile || profile.role !== "VENUE_STAFF") throw new Error(`No Venue Staff profile for ${staffEmail}. Run npm run seed:accounts first.`);
  return profile.user_id;
};

// The venue's row: created through the RPC, or the one an earlier run created.
const ensureVenue = async (actorId, manifest, spec, capacity) => {
  const existing = check(await supabase.from("venue").select("venue_id,name,address,version").eq("name", spec.name).maybeSingle(), `find ${spec.name}`);
  if (existing) {
    if (!manifest.venueIds.includes(existing.venue_id)) throw new Error(`${spec.name} exists but was not created by this seed; skipping it is unsafe.`);
    return existing;
  }
  const { venue } = await venueModel.createVenue(actorId, {
    name: spec.name,
    address: spec.address,
    max_capacity: capacity,
    contact_person: "Seed Venue Staff",
    contact_email: staffEmail,
    contact_number: null,
    status: "ACTIVE",
  });
  manifest.venueIds.push(venue.venueId);
  saveManifest(manifest);
  check(await supabase.from("venue").update({ operating_hours: spec.operatingHours }).eq("venue_id", venue.venueId).select("venue_id"), `operating hours of ${spec.name}`);
  return { venue_id: venue.venueId, name: spec.name, address: spec.address, version: venue.version };
};

const seedDetails = async (db, actorId, row, spec, relatedIds) => {
  // The model's projection leaves out the fixture tag, so read it here.
  const existing = await db.collection("venue_details").findOne({ _id: String(row.venue_id) }, { projection: { version: 1, fixture: 1 } });
  if (existing && existing.fixture !== FIXTURE) throw new Error(`${row.name} has detail not made by this seed.`);
  await venueDetailModel.saveVenueDetails({
    venueId: row.venue_id,
    expectedVersion: existing?.version ?? 0,
    fields: {
      description: null,
      facilities: spec.facilities,
      accessibilityFeatures: spec.accessibilityFeatures,
      supportedLayouts: spec.supportedLayouts,
      knownRestrictions: [],
      emergencyAccess: null,
      setupMinutes: spec.setupMinutes,
      turnaroundMinutes: spec.turnaroundMinutes,
      relatedVenueIds: relatedIds.map(String),
      fixture: FIXTURE,
    },
    name: row.name,
    location: row.address,
    pgVersion: row.version,
    actorId,
  });

  const photos = db.collection("venue_photos");
  if (await photos.countDocuments({ venueId: String(row.venue_id) })) return;
  const documents = [];
  for (const [index, [photoId, file, caption]] of spec.photos.entries()) {
    const { data, contentType } = await download(photoId, file);
    const now = new Date();
    documents.push({ venueId: String(row.venue_id), position: index, caption, contentType, size: data.length, data, uploadedBy: null, uploadedAt: now, updatedBy: null, updatedAt: now, version: 1, fixture: FIXTURE });
  }
  if (documents.length) await photos.insertMany(documents);
};

// supportedLayouts for the existing [seed:dev] venues whose detail has none,
// from their legacy PostgreSQL room layouts.
const fillSeedLayouts = async (db, actorId, manifest) => {
  const rows = check(await supabase.from("venue").select("venue_id,name,rooms:room(layout_type)").like("name", "[seed:dev] %").eq("is_active", true), "find [seed:dev] venues");
  for (const row of rows) {
    if (manifest.venueIds.includes(row.venue_id)) continue;
    const layouts = [...new Set((row.rooms || []).map((room) => room.layout_type).filter(Boolean))];
    // Read directly: the model's projection leaves out the display copies.
    const document = await db.collection("venue_details").findOne({ _id: String(row.venue_id) }, { projection: { name: 1, location: 1, pg_version: 1, version: 1, supportedLayouts: 1 } });
    if (!layouts.length || !document || document.supportedLayouts?.length) continue;
    // Cleanup needs both a confirmed seed write and unchanged values/version.
    // If the process stops before confirmation, preserve the document.
    const record = {
      venueId: row.venue_id,
      layouts,
      version: document.version + 1,
      previousLayouts: document.supportedLayouts ?? null,
      applied: false,
    };
    manifest.layoutsFilled.push(record);
    saveManifest(manifest);
    await venueDetailModel.saveVenueDetails({
      venueId: row.venue_id,
      expectedVersion: document.version,
      fields: { supportedLayouts: layouts },
      name: document.name,
      location: document.location,
      pgVersion: document.pg_version,
      actorId,
    });
    record.applied = true;
    saveManifest(manifest);
    console.log(`Filled layouts of ${row.name}: ${layouts.join(", ")}`);
  }
};

const seed = async (db) => {
  const actorId = await findActor();
  const manifest = loadManifest();
  for (const building of BUILDINGS) {
    const hall = await ensureVenue(actorId, manifest, building.hall, hallCapacity(building));
    const rooms = [];
    for (const room of building.rooms) rooms.push(await ensureVenue(actorId, manifest, { ...room, address: building.hall.address }, room.capacity));
    const all = [hall, ...rooms];
    // Each venue links to every other venue of its building.
    const others = (row) => all.filter((item) => item.venue_id !== row.venue_id).map((item) => item.venue_id);
    await seedDetails(db, actorId, hall, building.hall, others(hall));
    for (const [index, room] of rooms.entries()) await seedDetails(db, actorId, room, building.rooms[index], others(room));
    console.log(`Seeded ${hall.name} (${hallCapacity(building)}) with ${rooms.length} rooms.`);
  }
  await fillSeedLayouts(db, actorId, manifest);
};

// Restore only an unchanged seed write. Legacy manifests contain numeric IDs
// without values/version evidence; leave those documents alone.
const restoreSeedLayouts = async (db, records) => {
  let restored = 0;
  for (const record of records) {
    if (!record || record.applied !== true || !Array.isArray(record.layouts) || !Number.isInteger(record.version)) continue;
    const update = record.previousLayouts === null
      ? { $unset: { supportedLayouts: "" } }
      : { $set: { supportedLayouts: record.previousLayouts } };
    const result = await db.collection("venue_details").updateOne(
      { _id: String(record.venueId), version: record.version, supportedLayouts: record.layouts },
      { ...update, $inc: { version: 1 }, $currentDate: { updatedAt: true } },
    );
    restored += result.modifiedCount;
  }
  return restored;
};

const cleanup = async (db) => {
  const manifest = loadManifest();
  const actorId = manifest.venueIds.length ? await findActor() : null;
  for (const venueId of manifest.venueIds) {
    const row = check(await supabase.from("venue").select("venue_id,version,status").eq("venue_id", venueId).maybeSingle(), `find venue ${venueId}`);
    if (row && row.status !== "INACTIVE") await venueModel.setVenueStatus(actorId, venueId, { version: row.version, status: "INACTIVE", reason: null, confirmUpcomingBookings: true });
  }
  const ids = manifest.venueIds.map(String);
  const details = await db.collection("venue_details").deleteMany({ _id: { $in: ids }, fixture: FIXTURE });
  const photos = await db.collection("venue_photos").deleteMany({ venueId: { $in: ids }, fixture: FIXTURE });
  const restored = await restoreSeedLayouts(db, manifest.layoutsFilled);
  console.log(`Took ${manifest.venueIds.length} seeded venues out of service; removed ${details.deletedCount} details and ${photos.deletedCount} photos; restored layouts on ${restored} venues; preserved ${manifest.layoutsFilled.length - restored} changed or unverified entries.`);
  saveManifest({ venueIds: manifest.venueIds, layoutsFilled: [] });
};

if (require.main === module) {
  getMongoDb()
    .then((db) => (process.argv[2] === "cleanup" ? cleanup(db) : seed(db)))
    .catch((error) => {
      console.error("Venue room seed failed:", error.message);
      // A validator refusal says which schema rule failed.
      if (error.errInfo) console.error(JSON.stringify(error.errInfo.details));
      process.exitCode = 1;
    })
    .finally(closeMongoDb);
}

module.exports = { BUILDINGS, FIXTURE, hallCapacity, restoreSeedLayouts };
