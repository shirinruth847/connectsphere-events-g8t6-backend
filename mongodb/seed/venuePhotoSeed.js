// Development photos for the T28 venue galleries (SPM-181). Downloads free
// Unsplash photos (Unsplash License: free to use, no attribution required;
// Unsplash+ photos are refused by the download link, so none are used) and
// stores them in venue_photos, tagged fixture: "spm181-unsplash" so cleanup
// removes only them. A venue that already has any photo is skipped.
// Usage: node mongodb/seed/venuePhotoSeed.js [cleanup]
// Reads MONGODB_URI, MONGODB_DB_NAME and the Supabase settings from .env.
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { detectImageType, MAX_PHOTO_BYTES } = require("../../validators/venuePhotoValidator");

const FIXTURE = "spm181-unsplash";

// Venue name → [Unsplash photo ID, image file on images.unsplash.com,
// caption]; the first photo is the cover. Source page:
// https://unsplash.com/photos/<photo ID>. The image file is used because the
// unsplash.com download link puts scripted clients through a bot check.
const GALLERIES = {
  "[seed:dev] Grand Hall": [
    ["iblAaJVKopI", "photo-1790501028651-b62b529c4e1d", "Grand hall with marble columns and crystal chandeliers"],
    ["T5v5i67QYGk", "photo-1780542900375-0cf459e38fbb", "Banquet layout with long tables under the chandeliers"],
    ["FKLXn1mw3Bg", "photo-1759519238029-689e99c6d19e", "Theatre-style seating for a formal ceremony"],
  ],
  "[seed:dev] Seminar Centre": [
    ["GWe0dlVD9e0", "photo-1431540015161-0bf868a2d407", "Boardroom with an oval conference table"],
    ["1oefhxwrgP4", "photo-1758270705087-76e81a5117bd", "Seminar in progress, classroom layout"],
    ["0sT9YhNgSEs", "photo-1462826303086-329426d1aef5", "Long workshop table for breakout sessions"],
  ],
  "[seed:dev] Studio Room": [
    ["GzMNrGthWns", "photo-1786325492030-0f073cc1b550", "Industrial studio with concrete walls and a mezzanine"],
    ["yxRLYkmhTVg", "photo-1768818928341-3b31b8965c6d", "Studio lighting rig ready for a shoot"],
    ["XoQs9im605s", "photo-1779539197812-5b364df848c6", "Open studio floor with wooden flooring"],
  ],
  "[seed:dev] Conflict Lab": [
    ["zoCDWPuiRuA", "photo-1512758017271-d7b84c2113f1", "Brainstorm wall for design sprints"],
    ["s-KphF10sWM", "photo-1637665662134-db459c1bbb46", "Meeting room with a white table and black chairs"],
    ["HNtgzXa8dc8", "photo-1783454975251-8baeadeb91f7", "Lab bench for hands-on demonstrations"],
  ],
  "[seed:dev] East Wing Auditorium": [
    ["GenlGZhrmnM", "photo-1632012773667-b68d7bd59cc4", "Auditorium with tiered red seats"],
    ["_96edJ8IVC4", "photo-1773828755374-0ee802d9f44b", "Keynote to a full auditorium"],
    ["e_RpjNyMgEM", "photo-1526045004414-3e7ed02f9ca1", "Rows of theatre chairs facing the stage"],
  ],
  "[seed:dev] Rooftop Terrace": [
    ["xQWLtlQb7L0", "photo-1493246318656-5bfd4cfb29b8", "Terrace seating overlooking the city"],
    ["6Iif8DpllLw", "photo-1705095605806-4b2936e90471", "Lounge sofas on the open-air deck"],
    ["vZ7glA2uShs", "photo-1727478594764-c5a0168ac8fc", "Skyline view from the rooftop"],
  ],
  "Campus Central Hall": [
    ["F8t2VGnI47I", "photo-1541829070764-84a7d30dd3f3", "Tiered lecture hall with wooden desks"],
    ["Z_Z_2-GMD9E", "photo-1758270703878-de80505b6714", "Lecture with students taking part"],
    ["viY-ACkx2iE", "photo-1724315069759-3bac28f679f6", "Hall set with rows of desks for exams"],
  ],
  "Innovation Hub": [
    ["6Z5BezrEsEk", "photo-1772723822651-d2161754d61b", "Coworking lounge with plants"],
    ["sXYBmejEK8U", "photo-1760611656615-db3fad24a314", "Open-plan workspace with hot desks"],
    ["U2BI3GMnSSE", "photo-1531973576160-7125cd663d86", "Team collaborating in the open office"],
  ],
  "McDonald's Basement": [
    ["BuMVDXZTGn0", "photo-1417816491410-d61e1546e539", "Small basement room with a table"],
    ["dQWofbpgQdY", "photo-1771943074690-90a0e730a47e", "Storage corner with exposed pipes (under maintenance)"],
  ],
  "The Unforeseen Future": [
    ["UhJFE_ZcosM", "photo-1789217564401-cccb06b67001", "Futuristic lounge under skylights"],
    ["3O1Hw6HwdsY", "photo-1789217564386-68baa000cf1c", "Curved lounge overlooking the city"],
    ["_mCcHJzBknw", "photo-1758369637013-352ed7636c33", "Glass atrium with bridges"],
  ],
};

// 1600 px wide JPEG at quality 75 keeps each photo well under 2 MB.
const download = async (photoId, file) => {
  const response = await fetch(`https://images.unsplash.com/${file}?w=1600&q=75&fm=jpg`);
  if (!response.ok) throw new Error(`Unsplash ${photoId}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const contentType = detectImageType(data);
  if (!contentType) throw new Error(`Unsplash ${photoId}: not a JPEG/PNG/WebP image`);
  if (data.length > MAX_PHOTO_BYTES) throw new Error(`Unsplash ${photoId}: ${data.length} bytes is over 2 MB`);
  return { data, contentType };
};

const seed = async (photos) => {
  const { data: venues, error } = await supabase
    .from("venue")
    .select("venue_id,name")
    .eq("is_active", true)
    .in("name", Object.keys(GALLERIES));
  if (error) throw error;

  for (const venue of venues) {
    const venueId = String(venue.venue_id);
    if (await photos.countDocuments({ venueId })) {
      console.log(`Skipped ${venue.name}: it already has photos.`);
      continue;
    }
    const documents = [];
    for (const [index, [photoId, file, caption]] of GALLERIES[venue.name].entries()) {
      const { data, contentType } = await download(photoId, file);
      const now = new Date();
      documents.push({ venueId, position: index, caption, contentType, size: data.length, data, uploadedBy: null, uploadedAt: now, updatedBy: null, updatedAt: now, version: 1, fixture: FIXTURE });
    }
    await photos.insertMany(documents);
    console.log(`Added ${documents.length} photos to ${venue.name}.`);
  }
  const missing = Object.keys(GALLERIES).filter((name) => !venues.some((venue) => venue.name === name));
  if (missing.length) console.log(`Not found or deleted, skipped: ${missing.join(", ")}`);
};

const cleanup = async (photos) => {
  const { deletedCount } = await photos.deleteMany({ fixture: FIXTURE });
  console.log(`Removed ${deletedCount} seeded photos.`);
};

if (require.main === module) {
  getMongoDb()
    .then(async (db) => {
      const photos = db.collection("venue_photos");
      await (process.argv[2] === "cleanup" ? cleanup(photos) : seed(photos));
    })
    .catch((error) => {
      console.error("Venue photo seed failed:", error.message);
      process.exitCode = 1;
    })
    .finally(closeMongoDb);
}

module.exports = { GALLERIES, FIXTURE };
