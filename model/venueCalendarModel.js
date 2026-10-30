const { ObjectId } = require("mongodb");
const { getMongoDb } = require("../config/mongodb");

const DUPLICATE_KEY = 11000;
const OBJECT_ID = /^[0-9a-f]{24}$/;

// MongoDB venue_calendar access: tentative holds and operational blocks
// (Master 5.4.3, 5.4.4, 6.4, T27). Field names follow
// mongodb/schemas/venue_calendar.json. Rules that use the entries live in
// venueConflictModel.js.

const toEntry = (document) => ({
  id: document._id.toString(),
  venueId: Number(document.venueId),
  type: document.type,
  status: document.status,
  start: document.start,
  end: document.end,
  occupiedStart: document.occupiedStart,
  occupiedEnd: document.occupiedEnd,
  eventId: document.eventId ?? null,
  label: document.label ?? null,
  holdExpiresAt: document.holdExpiresAt ?? null,
  reason: document.reason ?? null,
  note: document.note ?? null,
  version: document.version ?? null,
  createdAt: document.createdAt ?? null,
  updatedAt: document.updatedAt ?? null,
});

// Every hold and block whose occupied range overlaps [from, to), whatever its
// status: expired holds are still shown, as expired (SPM-74 TC7).
// maxTimeMS bounds the read when a caller holds a PostgreSQL lock meanwhile
// (SPM-179 venue booking requests, Master 7.4).
const findCalendarEntries = async (venueIds, from, to, { maxTimeMS } = {}) => {
  if (!venueIds.length) return [];
  const db = await getMongoDb();
  const documents = await db
    .collection("venue_calendar")
    .find({
      venueId: { $in: venueIds.map(String) },
      occupiedStart: { $lt: new Date(to) },
      occupiedEnd: { $gt: new Date(from) },
      status: { $in: ["ACTIVE", "EXPIRED"] },
    }, maxTimeMS ? { maxTimeMS } : {})
    .sort({ occupiedStart: 1 })
    .toArray();
  return documents.map(toEntry);
};

// SPM-199: only this event's holds, including expired/converted/released ones.
// Staff notes, creator IDs and other events never leave this read projection.
const findEventHolds = async (eventId) => {
  const db = await getMongoDb();
  const documents = await db.collection("venue_calendar")
    .find({ eventId, type: "HOLD" }, { projection: {
      venueId: 1, type: 1, status: 1, start: 1, end: 1, occupiedStart: 1,
      occupiedEnd: 1, eventId: 1, label: 1, holdExpiresAt: 1,
    } })
    .sort({ start: 1, _id: 1 }).toArray();
  return documents.map(toEntry);
};

// ---------- operational blocks (SPM-195) ----------
// Written only by venueModel.js while it holds the venue lock (Master 7.4).

const calendar = async () => (await getMongoDb()).collection("venue_calendar");

const findCalendarEntry = async (entryId, { maxTimeMS, readPreference } = {}) => {
  if (!OBJECT_ID.test(entryId || "")) return null;
  const document = await (await calendar()).findOne({ _id: new ObjectId(entryId) }, { ...(maxTimeMS ? { maxTimeMS } : {}), ...(readPreference ? { readPreference } : {}) });
  return document ? toEntry(document) : null;
};

// The venue's blocks still in effect or yet to come (end after `from`), newest
// start last; lifted ones are included so the venue page can show them. At most
// `limit` are returned; hasMore says whether later ones were left out.
const findVenueBlocks = async (venueId, from, { limit = 200 } = {}) => {
  const documents = await (await calendar())
    .find({ venueId: String(venueId), type: "BLOCK", end: { $gt: new Date(from) } })
    .sort({ start: 1, _id: 1 })
    .limit(limit + 1)
    .toArray();
  return { blocks: documents.slice(0, limit).map(toEntry), hasMore: documents.length > limit };
};

// Holds and blocks by ID, for incident cards and restorability.
const findEntriesByIds = async (entryIds) => {
  const ids = [...new Set(entryIds)].filter((id) => OBJECT_ID.test(id || ""));
  if (!ids.length) return new Map();
  const documents = await (await calendar())
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } })
    .toArray();
  return new Map(documents.map((document) => [document._id.toString(), toEntry(document)]));
};

// A block has no setup or turnaround time, so its occupied range is its
// interval (T4). The ID is chosen by the caller, so a retried request that
// already wrote its document finds it instead of writing a second one: the
// existing entry is returned with `existing: true`.
const insertBlock = async ({ blockId, venueId, reason, note, start, end, createdBy, writeToken }) => {
  const document = {
    _id: new ObjectId(blockId),
    venueId: String(venueId),
    type: "BLOCK",
    start: new Date(start),
    end: new Date(end),
    occupiedStart: new Date(start),
    occupiedEnd: new Date(end),
    status: "ACTIVE",
    eventId: null,
    reason,
    note,
    createdBy,
    writeToken,
    createdAt: new Date(),
    updatedAt: null,
    version: 1,
  };
  const collection = await calendar();
  try {
    await collection.insertOne(document);
    return { ...toEntry(document), existing: false };
  } catch (error) {
    if (error?.code !== DUPLICATE_KEY) throw error;
    const current = await collection.findOne({ _id: document._id });
    if (!current) throw error;
    return { ...toEntry(current), existing: true };
  }
};

// Shortens or lifts an active block. Matches only the version the caller read
// under the venue lock; returns the updated entry, or null when nothing matched.
const updateBlock = async ({ blockId, venueId, expectedVersion, start, end, lift = false, writeToken }) => {
  const set = lift
    ? { status: "LIFTED", updatedAt: new Date() }
    : {
      start: new Date(start),
      end: new Date(end),
      occupiedStart: new Date(start),
      occupiedEnd: new Date(end),
      updatedAt: new Date(),
    };
  const document = await (await calendar()).findOneAndUpdate(
    { _id: new ObjectId(blockId), venueId: String(venueId), type: "BLOCK", status: "ACTIVE", version: expectedVersion },
    { $set: { ...set, writeToken }, $inc: { version: 1 } },
    { returnDocument: "after" }
  );
  return document ? toEntry(document) : null;
};

// Undo steps, run only when the PostgreSQL side certainly did not commit
// (venueModel.withVenueLockTransaction). Each matches the exact document state
// the operation left, so nothing written since is touched.
const deleteBlock = async ({ blockId, venueId, writeToken }) => {
  await (await calendar()).deleteOne({
    _id: new ObjectId(blockId), venueId: String(venueId), type: "BLOCK", status: "ACTIVE", version: 1, writeToken,
  });
};

const revertBlock = async ({ blockId, venueId, version, start, end, writeToken }) => {
  await (await calendar()).updateOne(
    { _id: new ObjectId(blockId), venueId: String(venueId), type: "BLOCK", version, writeToken },
    {
      $set: {
        status: "ACTIVE",
        start: new Date(start),
        end: new Date(end),
        occupiedStart: new Date(start),
        occupiedEnd: new Date(end),
        updatedAt: new Date(),
      },
      $inc: { version: 1 },
    }
  );
};

const ownsBlockWrite = async ({ blockId, venueId, writeToken }) =>
  Boolean(await (await calendar()).findOne({ _id: new ObjectId(blockId), venueId: String(venueId), type: "BLOCK", writeToken }, { projection: { _id: 1 }, readPreference: "primary", maxTimeMS: 2000 }));

module.exports = {
  ownsBlockWrite,
  deleteBlock,
  revertBlock,
  findCalendarEntries,
  findEventHolds,
  findCalendarEntry,
  findVenueBlocks,
  findEntriesByIds,
  insertBlock,
  updateBlock,
};
