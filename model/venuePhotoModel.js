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

const orderedPhotos = async (photos, venueId) =>
  photos.find({ venueId: String(venueId) }, { projection: METADATA }).sort(GALLERY_ORDER).toArray();

// Writes positions 0..n-1 in the order given. Photos past the limit are left
// alone: they are racing uploads about to back out (see addPhoto).
const renumber = async (photos, ordered) => {
  const updates = ordered
    .slice(0, MAX_PHOTOS_PER_VENUE)
    .map((document, index) => ({ document, index }))
    .filter(({ document, index }) => document.position !== index)
    .map(({ document, index }) => ({ updateOne: { filter: { _id: document._id }, update: { $set: { position: index } } } }));
  if (updates.length) await photos.bulkWrite(updates, { ordered: false });
};

const listPhotos = async (venueId) => (await orderedPhotos(await collection(), venueId)).map((document, index) => ({ ...toPhoto(document), position: index }));

// The image bytes, or null when the photo does not belong to the venue.
const getPhotoImage = async (venueId, photoId) => {
  const document = await (await collection()).findOne({ _id: new ObjectId(photoId), venueId: String(venueId) });
  return document ? { contentType: document.contentType, data: Buffer.from(document.data.buffer) } : null;
};

const addPhoto = async ({ venueId, contentType, data, size, caption, actorId }) => {
  const photos = await collection();
  const existing = await photos.countDocuments({ venueId: String(venueId) });
  if (existing >= MAX_PHOTOS_PER_VENUE) throw photoError("PHOTO_LIMIT_REACHED");

  const now = new Date();
  const { insertedId } = await photos.insertOne({
    venueId: String(venueId),
    position: existing,
    caption,
    contentType,
    size,
    data,
    uploadedBy: actorId,
    uploadedAt: now,
    updatedBy: actorId,
    updatedAt: now,
    version: 1,
  });
  // Two uploads at once can both pass the count; the later one backs out.
  const ordered = await orderedPhotos(photos, venueId);
  if (ordered.length > MAX_PHOTOS_PER_VENUE && ordered.slice(MAX_PHOTOS_PER_VENUE).some((document) => document._id.equals(insertedId))) {
    await photos.deleteOne({ _id: insertedId });
    throw photoError("PHOTO_LIMIT_REACHED");
  }
  await renumber(photos, ordered);
  return toPhoto({ ...(await photos.findOne({ _id: insertedId }, { projection: METADATA })) });
};

const findOwnPhoto = async (photos, venueId, photoId) => {
  const document = await photos.findOne({ _id: new ObjectId(photoId), venueId: String(venueId) }, { projection: METADATA });
  if (!document) throw photoError("PHOTO_NOT_FOUND");
  return document;
};

// Caption and/or a new position (0 is the cover); the others shift to make room.
const updatePhoto = async ({ venueId, photoId, changes, actorId }) => {
  const photos = await collection();
  const current = await findOwnPhoto(photos, venueId, photoId);
  const set = { updatedBy: actorId, updatedAt: new Date() };
  if (Object.prototype.hasOwnProperty.call(changes, "caption")) set.caption = changes.caption;
  await photos.updateOne({ _id: current._id }, { $set: set, $inc: { version: 1 } });

  if (Object.prototype.hasOwnProperty.call(changes, "position")) {
    const ordered = (await orderedPhotos(photos, venueId)).filter((document) => !document._id.equals(current._id));
    ordered.splice(Math.min(changes.position, ordered.length), 0, current);
    await renumber(photos, ordered);
  }
  return toPhoto(await photos.findOne({ _id: current._id }, { projection: METADATA }));
};

const replacePhotoImage = async ({ venueId, photoId, contentType, data, size, actorId }) => {
  const photos = await collection();
  const current = await findOwnPhoto(photos, venueId, photoId);
  await photos.updateOne(
    { _id: current._id },
    { $set: { contentType, data, size, updatedBy: actorId, updatedAt: new Date() }, $inc: { version: 1 } },
  );
  return toPhoto(await photos.findOne({ _id: current._id }, { projection: METADATA }));
};

const deletePhoto = async ({ venueId, photoId }) => {
  const photos = await collection();
  const current = await findOwnPhoto(photos, venueId, photoId);
  await photos.deleteOne({ _id: current._id });
  await renumber(photos, await orderedPhotos(photos, venueId));
  return toPhoto(current);
};

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
