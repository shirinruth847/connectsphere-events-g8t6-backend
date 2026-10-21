// T28 gallery storage against a local in-memory MongoDB replica set (Master
// M7), never Atlas. The schema validator from migration 0003 is applied, so
// every write here also proves the documents satisfy it.
const { MongoMemoryReplSet } = require("mongodb-memory-server");

jest.setTimeout(120000);

const ORIGINAL_ENV = { ...process.env };
let replSet;
let photos;
let model;
let closeMongoDb;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const VENUE = 4101;
const OTHER_VENUE = 4102;

const add = (caption, venueId = VENUE, data = JPEG) =>
  model.addPhoto({ venueId, contentType: "image/jpeg", data, size: data.length, caption, actorId: 7 });
const captions = async (venueId = VENUE) => (await model.listPhotos(venueId)).map((photo) => photo.caption);

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB_NAME = "spm181_photo_unit";
  model = require("../../model/venuePhotoModel");
  const { applyMigrations } = require("../../mongodb/migrate");
  const mongo = require("../../config/mongodb");
  closeMongoDb = mongo.closeMongoDb;
  const db = await mongo.getMongoDb();
  await applyMigrations(db);
  photos = db.collection("venue_photos");
});

beforeEach(async () => {
  await photos.deleteMany({});
});

afterAll(async () => {
  await closeMongoDb();
  await replSet.stop();
  process.env = ORIGINAL_ENV;
});

describe("venue_photos schema (migration 0003)", () => {
  test("[TC-VENUE-181-102] should_create_the_collection_with_the_venue_position_index", async () => {
    const indexes = await photos.indexes();
    expect(indexes.map((index) => index.name)).toContain("venue_position");
  });

  test("[TC-VENUE-181-103] should_reject_a_document_when_the_type_is_unsupported_or_a_field_is_unknown", async () => {
    const base = { venueId: "1", position: 0, contentType: "image/jpeg", size: 4, data: JPEG, uploadedAt: new Date(), version: 1 };
    await expect(photos.insertOne({ ...base, contentType: "image/svg+xml" })).rejects.toMatchObject({ code: 121 });
    await expect(photos.insertOne({ ...base, url: "http://example.test/x.jpg" })).rejects.toMatchObject({ code: 121 });
  });
});

describe("venuePhotoModel (T28)", () => {
  test("[TC-VENUE-181-104] should_append_photos_in_upload_order_when_added_and_return_metadata_without_bytes", async () => {
    const first = await add("Front");
    await add("Stage");

    expect(first).toMatchObject({ position: 0, caption: "Front", contentType: "image/jpeg", size: JPEG.length, version: 1 });
    expect(first).not.toHaveProperty("data");
    expect(first.photoId).toMatch(/^[a-f0-9]{24}$/);
    expect(await captions()).toEqual(["Front", "Stage"]);
    expect(await photos.findOne({ caption: "Front" })).toMatchObject({ venueId: String(VENUE), uploadedBy: 7, updatedBy: 7 });
  });

  test("[TC-VENUE-181-105] should_return_the_stored_bytes_only_when_asked_through_the_owning_venue", async () => {
    const photo = await add("Front", VENUE, PNG);

    const image = await model.getPhotoImage(VENUE, photo.photoId);
    expect(image.data.equals(PNG)).toBe(true);
    expect(await model.getPhotoImage(OTHER_VENUE, photo.photoId)).toBeNull();
  });

  test("[TC-VENUE-181-106] should_refuse_another_photo_when_the_gallery_has_20", async () => {
    for (let index = 0; index < 20; index += 1) await add(`P${index}`);

    await expect(add("One too many")).rejects.toMatchObject({ name: "VenueError", code: "PHOTO_LIMIT_REACHED" });
    expect(await photos.countDocuments({ venueId: String(VENUE) })).toBe(20);
    // Another venue's gallery is counted separately.
    await expect(add("Other", OTHER_VENUE)).resolves.toMatchObject({ position: 0 });
  });

  test("[TC-VENUE-181-107] should_keep_at_most_20_photos_when_uploads_race", async () => {
    for (let index = 0; index < 18; index += 1) await add(`P${index}`);

    const results = await Promise.allSettled([add("A"), add("B"), add("C"), add("D")]);

    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    expect(rejected.every((result) => result.reason.code === "PHOTO_LIMIT_REACHED")).toBe(true);
    const list = await model.listPhotos(VENUE);
    expect(list.length).toBeLessThanOrEqual(20);
    expect(list.map((photo) => photo.position)).toEqual(list.map((_, index) => index));
  });

  test("[TC-VENUE-181-108] should_make_a_photo_the_cover_and_shift_the_others_when_moved_to_position_0", async () => {
    await add("A");
    await add("B");
    const c = await add("C");

    const moved = await model.updatePhoto({ venueId: VENUE, photoId: c.photoId, changes: { position: 0 }, actorId: 8 });

    expect(moved).toMatchObject({ position: 0, version: 2 });
    expect(await captions()).toEqual(["C", "A", "B"]);
    expect((await model.findCoverPhotoIds([VENUE])).get(String(VENUE))).toBe(c.photoId);
  });

  test("[TC-VENUE-181-109] should_place_a_photo_last_when_the_position_is_past_the_end", async () => {
    const a = await add("A");
    await add("B");

    await model.updatePhoto({ venueId: VENUE, photoId: a.photoId, changes: { position: 19 }, actorId: 8 });

    expect(await captions()).toEqual(["B", "A"]);
  });

  test("[TC-VENUE-181-110] should_change_only_the_caption_and_record_the_editor_when_no_position_is_given", async () => {
    const a = await add("A");
    await add("B");

    const updated = await model.updatePhoto({ venueId: VENUE, photoId: a.photoId, changes: { caption: null }, actorId: 9 });

    expect(updated).toMatchObject({ caption: null, position: 0, version: 2 });
    expect(await photos.findOne({ caption: null })).toMatchObject({ updatedBy: 9, uploadedBy: 7 });
  });

  test("[TC-VENUE-181-111] should_keep_caption_and_position_when_the_image_is_replaced", async () => {
    await add("A");
    const b = await add("B");

    const replaced = await model.replacePhotoImage({ venueId: VENUE, photoId: b.photoId, contentType: "image/png", data: PNG, size: PNG.length, actorId: 9 });

    expect(replaced).toMatchObject({ caption: "B", position: 1, contentType: "image/png", version: 2 });
    expect((await model.getPhotoImage(VENUE, b.photoId)).data.equals(PNG)).toBe(true);
  });

  test("[TC-VENUE-181-112] should_close_the_gap_and_promote_the_next_cover_when_the_first_photo_is_deleted", async () => {
    const a = await add("A");
    const b = await add("B");
    await add("C");

    await model.deletePhoto({ venueId: VENUE, photoId: a.photoId });

    expect((await model.listPhotos(VENUE)).map(({ caption, position }) => [caption, position])).toEqual([["B", 0], ["C", 1]]);
    expect((await model.findCoverPhotoIds([VENUE])).get(String(VENUE))).toBe(b.photoId);
  });

  test("[TC-VENUE-181-113] should_report_not_found_when_the_photo_belongs_to_another_venue", async () => {
    const other = await add("Other", OTHER_VENUE);

    for (const call of [
      () => model.updatePhoto({ venueId: VENUE, photoId: other.photoId, changes: { caption: "x" }, actorId: 7 }),
      () => model.replacePhotoImage({ venueId: VENUE, photoId: other.photoId, contentType: "image/jpeg", data: JPEG, size: JPEG.length, actorId: 7 }),
      () => model.deletePhoto({ venueId: VENUE, photoId: other.photoId }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "PHOTO_NOT_FOUND" });
    }
    expect(await captions(OTHER_VENUE)).toEqual(["Other"]);
  });

  test("[TC-VENUE-181-114] should_map_each_venue_to_its_cover_and_leave_out_venues_without_photos", async () => {
    const a = await add("A");
    await add("B");
    const other = await add("Other", OTHER_VENUE);

    const covers = await model.findCoverPhotoIds([VENUE, OTHER_VENUE, 4199]);

    expect(Object.fromEntries(covers)).toEqual({ [String(VENUE)]: a.photoId, [String(OTHER_VENUE)]: other.photoId });
    expect((await model.findCoverPhotoIds([])).size).toBe(0);
  });
});
