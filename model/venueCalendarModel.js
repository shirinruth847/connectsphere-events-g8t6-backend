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
  extendedAt: document.extendedAt ?? null,
  convertedBookingId: document.convertedBookingId ?? null,
  reason: document.reason ?? null,
  note: document.note ?? null,
  version: document.version ?? null,
  writeRecovery: document.writeRecovery ?? null,
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
const updateBlock = async ({ blockId, venueId, expectedVersion, start, end, lift = false, writeToken, writeRecovery }) => {
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
    { $set: { ...set, writeToken, ...(writeRecovery ? { writeRecovery } : {}) }, $inc: { version: 1 } },
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
      $unset: { writeRecovery: "" },
      $inc: { version: 1 },
    }
  );
};

const ownsBlockWrite = async ({ blockId, venueId, writeToken }) =>
  Boolean(await (await calendar()).findOne({ _id: new ObjectId(blockId), venueId: String(venueId), type: "BLOCK", writeToken }, { projection: { _id: 1 }, readPreference: "primary", maxTimeMS: 2000 }));

// Remove only this attempt's recovery metadata, after PostgreSQL commits.
const clearBlockRecovery = async ({ blockId, venueId, writeToken }) => {
  await (await calendar()).updateOne(
    { _id: new ObjectId(blockId), venueId: String(venueId), writeToken },
    { $unset: { writeRecovery: "" } }
  );
};

// ---------- tentative holds (SPM-190) ----------
// Written only by venueModel.js while it holds the venue lock (Master 7.4),
// except the expiry job's status change, which only records what every read
// already treats as expired (Master 5.4.3).

const insertHold = async ({ holdId, venueId, eventId, label, start, end, occupiedStart, occupiedEnd, holdExpiresAt, createdBy, writeToken }) => {
  const document = {
    _id: new ObjectId(holdId),
    venueId: String(venueId),
    type: "HOLD",
    start: new Date(start),
    end: new Date(end),
    occupiedStart: new Date(occupiedStart),
    occupiedEnd: new Date(occupiedEnd),
    status: "ACTIVE",
    eventId,
    label,
    holdExpiresAt: new Date(holdExpiresAt),
    extendedAt: null,
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

// Internal placement-recovery read. Write identity never enters API views.
const findHoldPlacementWrite = async (holdId) => {
  const document = await (await calendar()).findOne(
    { _id: new ObjectId(holdId) },
    { readPreference: "primary", maxTimeMS: 3000 }
  );
  return document ? { ...toEntry(document), createdBy: document.createdBy, writeToken: document.writeToken } : null;
};

// Extends (once) or releases an active hold read under the venue lock; matches
// only that version. Returns the updated entry, or null when nothing matched.
const changeHold = async ({ holdId, venueId, expectedVersion, holdExpiresAt = null, release = false, writeToken }) => {
  const filter = { _id: new ObjectId(holdId), venueId: String(venueId), type: "HOLD", status: "ACTIVE", version: expectedVersion };
  const set = release
    ? { status: "RELEASED", updatedAt: new Date(), writeToken }
    : { holdExpiresAt: new Date(holdExpiresAt), extendedAt: new Date(), updatedAt: new Date(), writeToken };
  if (!release) filter.extendedAt = null;
  const document = await (await calendar()).findOneAndUpdate(filter, { $set: set, $inc: { version: 1 } }, { returnDocument: "after" });
  return document ? toEntry(document) : null;
};

// Undo steps, run only when PostgreSQL certainly did not commit; each matches
// the exact state this attempt left (writeToken), so nothing newer is touched.
const deleteHold = async ({ holdId, venueId, writeToken }) => {
  await (await calendar()).deleteOne({
    _id: new ObjectId(holdId), venueId: String(venueId), type: "HOLD", status: "ACTIVE", version: 1, writeToken,
  });
};

const revertHold = async ({ holdId, venueId, version, holdExpiresAt, extendedAt, writeToken }) => {
  await (await calendar()).updateOne(
    { _id: new ObjectId(holdId), venueId: String(venueId), type: "HOLD", version, writeToken },
    {
      $set: { status: "ACTIVE", holdExpiresAt: new Date(holdExpiresAt), extendedAt: extendedAt ? new Date(extendedAt) : null, updatedAt: new Date() },
      $inc: { version: 1 },
    }
  );
};

const ownsHoldWrite = async ({ holdId, venueId, writeToken }) =>
  Boolean(await (await calendar()).findOne(
    { _id: new ObjectId(holdId), venueId: String(venueId), type: "HOLD", writeToken },
    { projection: { _id: 1 }, readPreference: "primary", maxTimeMS: 2000 }
  ));

// Active holds expiring by `until`, soonest first, for the expiry job.
const findHoldsExpiringBy = async (until, { limit = 100, now } = {}) => {
  const documents = await (await calendar())
    .find({ type: "HOLD", status: "ACTIVE", holdExpiresAt: { $lte: new Date(until) },
      $or: [
        { holdExpiresAt: { $lte: new Date(now) } },
        { $expr: { $ne: [{ $ifNull: ["$remindedForExpiry", null] }, "$holdExpiresAt"] } },
      ],
    })
    .sort({ holdExpiresAt: 1, _id: 1 })
    .limit(limit)
    .toArray();
  return documents.map(toEntry);
};

// SPM-188 AC9/AC10: an active, unexpired hold becomes CONVERTED, naming its
// booking. It runs under the same event and venue locks as the expiry job and
// with database time, and it needs the version it read and an expiry still
// ahead, so a hold is converted or expired, never both. Null when the hold was
// no longer active, had expired or had changed version.
const convertHold = async ({ holdId, venueId, expectedVersion, bookingId, now, writeToken }) => {
  const document = await (await calendar()).findOneAndUpdate(
    {
      _id: new ObjectId(holdId), venueId: String(venueId), type: "HOLD", status: "ACTIVE",
      version: expectedVersion, holdExpiresAt: { $gt: new Date(now) },
    },
    { $set: { status: "CONVERTED", convertedBookingId: bookingId, updatedAt: new Date(), writeToken }, $inc: { version: 1 } },
    { returnDocument: "after" }
  );
  return document ? toEntry(document) : null;
};

// Undo for convertHold when the PostgreSQL transaction rolls back; only this
// write's own conversion (same token and version) is put back.
const revertConvertedHold = async ({ holdId, venueId, version, writeToken }) => {
  await (await calendar()).updateOne(
    { _id: new ObjectId(holdId), venueId: String(venueId), type: "HOLD", status: "CONVERTED", version, writeToken },
    { $set: { status: "ACTIVE", convertedBookingId: null, updatedAt: new Date() }, $inc: { version: 1 } }
  );
};

// Post-commit acknowledgement only. A concurrent extension changes version
// and expiry, so an old reminder/expiry acknowledgement cannot touch it.
const acknowledgeHoldNotice = async ({ holdId, expectedVersion, expiresAt, kind }) => {
  const result = await (await calendar()).updateOne(
    { _id: new ObjectId(holdId), type: "HOLD", status: "ACTIVE", version: expectedVersion, holdExpiresAt: new Date(expiresAt) },
    kind === "EXPIRED"
      ? { $set: { status: "EXPIRED", updatedAt: new Date() }, $inc: { version: 1 } }
      : { $set: { remindedForExpiry: new Date(expiresAt) } }
  );
  return result.modifiedCount === 1;
};

// Reminder-only progress helper: an extension changes expiry, so an old
// acknowledgement cannot suppress a reminder for the new expiry.
const markHoldReminded = async ({ holdId, expiresAt }) => {
  const result = await (await calendar()).updateOne(
    { _id: new ObjectId(holdId), type: "HOLD", status: "ACTIVE", holdExpiresAt: new Date(expiresAt) },
    { $set: { remindedForExpiry: new Date(expiresAt) } }
  );
  return result.modifiedCount === 1;
};

module.exports = {
  findHoldPlacementWrite,
  insertHold,
  changeHold,
  deleteHold,
  revertHold,
  ownsHoldWrite,
  findHoldsExpiringBy,
  markHoldReminded,
  acknowledgeHoldNotice,
  convertHold,
  revertConvertedHold,
  clearBlockRecovery,
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
