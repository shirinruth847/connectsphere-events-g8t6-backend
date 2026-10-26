const { ObjectId } = require("mongodb");
const { getMongoDb } = require("../config/mongodb");
const { MAX_PHOTOS_PER_VENUE } = require("../validators/venuePhotoValidator");

// MongoDB venue_photos access (T28, SPM-181). Field names follow
// mongodb/schemas/venue_photos.json. Gallery order is position, then upload
// time, then ID; positions are renumbered 0..n-1 after every change, so
// position 0 is always the cover photo.

const GALLERY_ORDER = { position: 1, uploadedAt: 1, _id: 1 };
const METADATA = { data: 0 };

const photoError = (code) => Object.assign(new Error(code), { name: "VenueError", code });

const toPhoto = (document) => ({
  photoId: document._id.toString(),
  position: document.position,
  caption: document.caption ?? null,
  contentType: document.contentType,
  size: document.size,
  uploadedAt: document.uploadedAt.toISOString(),
  updatedAt: document.updatedAt ? document.updatedAt.toISOString() : null,
  version: document.version,
});

const collection = async () => (await getMongoDb()).collection("venue_photos");

const orderedPhotos = async (photos, venueId, session) =>
  photos.find({ venueId: String(venueId) }, { projection: METADATA, session }).sort(GALLERY_ORDER).toArray();

// Writes positions 0..n-1 under the same gallery transaction.
const renumber = async (photos, ordered, session) => {
  const updates = ordered
    .slice(0, MAX_PHOTOS_PER_VENUE)
    .map((document, index) => ({ document, index }))
    .filter(({ document, index }) => document.position !== index)
    .map(({ document, index }) => ({ updateOne: { filter: { _id: document._id }, update: { $set: { position: index } } } }));
  if (updates.length) await photos.bulkWrite(updates, { ordered: false, session });
};

const listPhotos = async (venueId) => (await orderedPhotos(await collection(), venueId)).map((document, index) => ({ ...toPhoto(document), position: index }));

// The image bytes, or null when the photo does not belong to the venue.
const getPhotoImage = async (venueId, photoId) => {
  const document = await (await collection()).findOne({ _id: new ObjectId(photoId), venueId: String(venueId) });
  return document ? { contentType: document.contentType, data: Buffer.from(document.data.buffer) } : null;
};

// Every writer touches the same guard before reading the gallery. Concurrent
// transactions conflict here and the driver retries with a fresh snapshot.
// Readers see committed photo changes only; no temporary overflow is published.
const withGalleryWrite = async (venueId, write) => {
  const db = await getMongoDb();
  const galleries = db.collection("venue_photo_galleries");
  const id = String(venueId);
  try {
    await galleries.updateOne({ _id: id }, { $setOnInsert: { version: 0 } }, { upsert: true });
  } catch (error) {
    // Another process created this guard concurrently.
    if (error.code !== 11000) throw error;
  }
  const session = db.client.startSession();
  try {
    return await session.withTransaction(async () => {
      await galleries.updateOne({ _id: id }, { $inc: { version: 1 } }, { session });
      return write(db.collection("venue_photos"), session);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, timeoutMS: 10000 });
  } finally {
    await session.endSession();
  }
};

const addPhoto = async ({ venueId, contentType, data, size, caption, actorId }) =>
  withGalleryWrite(venueId, async (photos, session) => {
    const existing = await photos.countDocuments({ venueId: String(venueId) }, { session });
    if (existing >= MAX_PHOTOS_PER_VENUE) throw photoError("PHOTO_LIMIT_REACHED");
    const now = new Date();
    const document = {
      _id: new ObjectId(), venueId: String(venueId), position: existing,
      caption, contentType, size, data, uploadedBy: actorId, uploadedAt: now,
      updatedBy: actorId, updatedAt: now, version: 1,
    };
    await photos.insertOne(document, { session });
    await renumber(photos, await orderedPhotos(photos, venueId, session), session);
    return toPhoto(await photos.findOne({ _id: document._id }, { projection: METADATA, session }));
  });

const findOwnPhoto = async (photos, venueId, photoId, session) => {
  const document = await photos.findOne({ _id: new ObjectId(photoId), venueId: String(venueId) }, { projection: METADATA, session });
  if (!document) throw photoError("PHOTO_NOT_FOUND");
  return document;
};

// Caption and/or a new position (0 is the cover); the others shift to make room.
const updatePhoto = async ({ venueId, photoId, changes, actorId }) => withGalleryWrite(venueId, async (photos, session) => {
  const current = await findOwnPhoto(photos, venueId, photoId, session);
  const set = { updatedBy: actorId, updatedAt: new Date() };
  if (Object.prototype.hasOwnProperty.call(changes, "caption")) set.caption = changes.caption;
  await photos.updateOne({ _id: current._id }, { $set: set, $inc: { version: 1 } }, { session });

  if (Object.prototype.hasOwnProperty.call(changes, "position")) {
    const ordered = (await orderedPhotos(photos, venueId, session)).filter((document) => !document._id.equals(current._id));
    ordered.splice(Math.min(changes.position, ordered.length), 0, current);
    await renumber(photos, ordered, session);
  }
  return toPhoto(await photos.findOne({ _id: current._id }, { projection: METADATA, session }));
});

const replacePhotoImage = async ({ venueId, photoId, contentType, data, size, actorId }) => withGalleryWrite(venueId, async (photos, session) => {
  const current = await findOwnPhoto(photos, venueId, photoId, session);
  await photos.updateOne(
    { _id: current._id },
    { $set: { contentType, data, size, updatedBy: actorId, updatedAt: new Date() }, $inc: { version: 1 } },
    { session },
  );
  return toPhoto(await photos.findOne({ _id: current._id }, { projection: METADATA, session }));
});

const deletePhoto = async ({ venueId, photoId }) => withGalleryWrite(venueId, async (photos, session) => {
  const current = await findOwnPhoto(photos, venueId, photoId, session);
  await photos.deleteOne({ _id: current._id }, { session });
  await renumber(photos, await orderedPhotos(photos, venueId, session), session);
  return toPhoto(current);
});

// The first photo of each venue's gallery, as a Map of venue ID string → photo ID.
const findCoverPhotoIds = async (venueIds) => {
  if (!venueIds.length) return new Map();
  const covers = await (await collection())
    .aggregate([
      { $match: { venueId: { $in: venueIds.map(String) } } },
      { $sort: { venueId: 1, ...GALLERY_ORDER } },
      { $group: { _id: "$venueId", photoId: { $first: "$_id" } } },
    ])
    .toArray();
  return new Map(covers.map((cover) => [cover._id, cover.photoId.toString()]));
};

module.exports = {
  listPhotos,
  getPhotoImage,
  addPhoto,
  updatePhoto,
  replacePhotoImage,
  deletePhoto,
  findCoverPhotoIds,
};
