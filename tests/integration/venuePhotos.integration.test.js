// T28 photo gallery, live: real Express routes and body parsing, real Supabase
// Auth and roles, the shared development PostgreSQL database (venue checks and
// the append-only audit log), and a local in-memory MongoDB replica set
// (Master 11, M7), never Atlas. Fixtures are namespaced spm32-<run>, recorded in
// the manifest and removed afterwards; photos are deleted before the venues.
const { MongoMemoryReplSet } = require("mongodb-memory-server");

jest.setTimeout(180000);

const ORIGINAL_ENV = { ...process.env };
let replSet;
let request;
let app;
let supabase;
let fixtures;
let fixtureHelpers;
let mongo;
let signInWithPassword;
let runId;
let venueId;
let deletedVenueId;

// Real file headers: an 8-byte PNG signature and a JFIF JPEG start, padded.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(64, 3)]);

const sessions = new Map();
const tokenFor = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed: ${error ? error.message : "no session"}`);
      return session.access_token;
    }));
  }
  return sessions.get(key);
};
// `as` sends the request (supertest requests are thenables); `send` builds one with a body.
const as = async (key, call) => call.set("Authorization", `Bearer ${await tokenFor(key)}`);
const send = async (key, method, path, body, type) =>
  request(app)[method](path).set("Authorization", `Bearer ${await tokenFor(key)}`).set("Content-Type", type).send(body);
const upload = (key, path, body, type) => send(key, "post", path, body, type);
const photosPath = (id = venueId) => `/api/venues/${id}/photos`;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB_NAME = "spm181_photo_integration";

  request = require("supertest");
  app = require("../../server");
  supabase = require("../../config/supabase");
  fixtureHelpers = require("../fixtures/authFixtures");
  ({ signInWithPassword } = require("../fixtures/browserAuthClient"));
  mongo = require("../../config/mongodb");
  const { applyMigrations } = require("../../mongodb/migrate");
  await applyMigrations(await mongo.getMongoDb());

  runId = fixtureHelpers.newRunId();
  fixtures = await fixtureHelpers.createAuthFixtures(runId);
  venueId = fixtures.venue.venueId;

  // A venue deleted as unusable (is_active = false): its gallery must be unreachable.
  const { data, error } = await supabase
    .from("venue")
    .insert({ name: `spm32-${runId} Retired`, address: `spm32-${runId} 9 Test Road`, max_capacity: 20, is_active: false })
    .select("venue_id")
    .single();
  if (error) throw error;
  deletedVenueId = data.venue_id;
  fixtureHelpers.recordFixtureIds(runId, "venueIds", [deletedVenueId]);
});

afterAll(async () => {
  // MongoDB documents go before the PostgreSQL rows (Master 10.4).
  if (mongo) {
    const photos = (await mongo.getMongoDb()).collection("venue_photos");
    await photos.deleteMany({ venueId: { $in: [String(venueId), String(deletedVenueId)] } });
    expect(await photos.countDocuments({ venueId: { $in: [String(venueId), String(deletedVenueId)] } })).toBe(0);
    await mongo.closeMongoDb();
  }
  if (runId) await fixtureHelpers.cleanupAuthFixtures(runId);
  if (replSet) await replSet.stop();
  process.env = ORIGINAL_ENV;
});

const auditActions = async () => {
  const { data, error } = await supabase
    .from("activity_log")
    .select("action,audience,user_id")
    .eq("entity_name", "venue")
    .eq("entity_id", venueId)
    .like("action", "VENUE_PHOTO_%")
    .order("log_id", { ascending: true });
  if (error) throw error;
  return data;
};

describe("venue photo gallery (live, T28)", () => {
  let first;
  let second;

  test("[TC-VENUE-181-140] should_start_with_an_empty_gallery_and_no_cover_on_my_venues", async () => {
    const list = await as("venueStaff", request(app).get(photosPath()));
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ photos: [] });

    const venues = await as("venueStaff", request(app).get(`/api/venues/manage?search=${encodeURIComponent(`spm32-${runId}`)}`));
    expect(venues.body.venues.find((venue) => venue.venueId === venueId).coverPhotoId).toBeNull();
  });

  test("[TC-VENUE-181-141] should_upload_two_photos_and_make_the_first_the_cover_on_my_venues", async () => {
    const one = await upload("venueStaff", `${photosPath()}?caption=Main%20hall`, PNG, "image/png");
    expect(one.status).toBe(201);
    first = one.body.photo;
    expect(first).toMatchObject({ position: 0, caption: "Main hall", contentType: "image/png", size: PNG.length, version: 1 });

    // The type comes from the bytes: a JPEG sent as image/webp is stored as JPEG.
    const two = await upload("venueStaff", photosPath(), JPEG, "image/webp");
    expect(two.status).toBe(201);
    second = two.body.photo;
    expect(second).toMatchObject({ position: 1, caption: null, contentType: "image/jpeg" });

    const venues = await as("venueStaff", request(app).get(`/api/venues/manage?search=${encodeURIComponent(`spm32-${runId}`)}`));
    expect(venues.body.venues.find((venue) => venue.venueId === venueId).coverPhotoId).toBe(first.photoId);
  });

  test("[TC-VENUE-181-142] should_serve_the_exact_bytes_with_nosniff_when_venue_staff_ask", async () => {
    const image = await as("venueStaff", request(app).get(`${photosPath()}/${first.photoId}`).buffer(true).parse((res, done) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    }));

    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.body.equals(PNG)).toBe(true);
  });

  test("[TC-VENUE-181-143] should_reorder_recaption_and_replace_then_show_the_new_cover", async () => {
    const moved = await as("venueStaff", request(app).put(`${photosPath()}/${second.photoId}`).send({ position: 0, caption: "Stage view" }));
    expect(moved.status).toBe(200);
    expect(moved.body.photo).toMatchObject({ position: 0, caption: "Stage view", version: 2 });

    const replaced = await send("venueStaff", "put", `${photosPath()}/${first.photoId}/image`, JPEG, "image/jpeg");
    expect(replaced.status).toBe(200);
    expect(replaced.body.photo).toMatchObject({ caption: "Main hall", contentType: "image/jpeg", position: 1, version: 2 });

    const list = await as("venueStaff", request(app).get(photosPath()));
    expect(list.body.photos.map((photo) => [photo.photoId, photo.position])).toEqual([[second.photoId, 0], [first.photoId, 1]]);
    const venues = await as("venueStaff", request(app).get(`/api/venues/manage?search=${encodeURIComponent(`spm32-${runId}`)}`));
    expect(venues.body.venues.find((venue) => venue.venueId === venueId).coverPhotoId).toBe(second.photoId);
  });

  test("[TC-VENUE-181-144] should_reject_non_images_oversized_files_and_bad_edits_without_storing_anything", async () => {
    const html = await upload("venueStaff", photosPath(), Buffer.from("<html><script>alert(1)</script></html>"), "image/png");
    expect(html.status).toBe(415);
    const svg = await upload("venueStaff", photosPath(), Buffer.from("<svg/>"), "image/svg+xml");
    expect(svg.status).toBe(415);
    const big = await upload("venueStaff", photosPath(), Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]), "image/jpeg");
    expect(big.status).toBe(413);
    const badEdit = await as("venueStaff", request(app).put(`${photosPath()}/${first.photoId}`).send({ position: 20 }));
    expect(badEdit.status).toBe(400);

    const list = await as("venueStaff", request(app).get(photosPath()));
    expect(list.body.photos).toHaveLength(2);
  });

  test("[TC-VENUE-181-145] should_deny_other_roles_and_anonymous_callers_on_read_and_write", async () => {
    for (const key of ["coordinator", "organiserA", "attendee"]) {
      expect((await as(key, request(app).get(photosPath()))).status).toBe(403);
      expect((await as(key, request(app).get(`${photosPath()}/${first.photoId}`))).status).toBe(403);
      expect((await upload(key, photosPath(), PNG, "image/png")).status).toBe(403);
      expect((await as(key, request(app).delete(`${photosPath()}/${first.photoId}`))).status).toBe(403);
    }
    expect((await request(app).get(`${photosPath()}/${first.photoId}`)).status).toBe(401);
    expect((await request(app).post(photosPath()).set("Content-Type", "image/png").send(PNG)).status).toBe(401);

    const list = await as("venueStaff", request(app).get(photosPath()));
    expect(list.body.photos).toHaveLength(2);
  });

  test("[TC-VENUE-181-146] should_return_404_for_a_deleted_venue_and_for_a_photo_of_another_venue", async () => {
    expect((await as("venueStaff", request(app).get(photosPath(deletedVenueId)))).status).toBe(404);
    expect((await upload("venueStaff", photosPath(deletedVenueId), PNG, "image/png")).status).toBe(404);
    // The photo ID exists, but not under the deleted venue.
    expect((await as("venueStaff", request(app).get(`${photosPath(deletedVenueId)}/${first.photoId}`))).status).toBe(404);
    expect((await as("venueStaff", request(app).get(`${photosPath()}/000000000000000000000000`))).status).toBe(404);
  });

  test("[TC-VENUE-181-147] should_delete_the_cover_promote_the_next_photo_and_audit_every_change_as_staff_only", async () => {
    const removed = await as("venueStaff", request(app).delete(`${photosPath()}/${second.photoId}`));
    expect(removed.status).toBe(200);
    expect((await as("venueStaff", request(app).delete(`${photosPath()}/${second.photoId}`))).status).toBe(404);

    const list = await as("venueStaff", request(app).get(photosPath()));
    expect(list.body.photos.map((photo) => [photo.photoId, photo.position])).toEqual([[first.photoId, 0]]);

    const audit = await auditActions();
    expect(audit.map((entry) => entry.action)).toEqual([
      "VENUE_PHOTO_ADDED", "VENUE_PHOTO_ADDED", "VENUE_PHOTO_UPDATED", "VENUE_PHOTO_REPLACED", "VENUE_PHOTO_DELETED",
    ]);
    expect(audit.every((entry) => entry.audience === "STAFF_ONLY" && entry.user_id === fixtures.accounts.venueStaff.userId)).toBe(true);
  });
});
