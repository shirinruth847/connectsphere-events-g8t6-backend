const { getMongoDb } = require("../config/mongodb");

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

module.exports = { findCalendarEntries, findEventHolds };
