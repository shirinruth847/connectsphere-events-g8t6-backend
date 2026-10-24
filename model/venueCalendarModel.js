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
const findCalendarEntries = async (venueIds, from, to) => {
  if (!venueIds.length) return [];
  const db = await getMongoDb();
  const documents = await db
    .collection("venue_calendar")
    .find({
      venueId: { $in: venueIds.map(String) },
      occupiedStart: { $lt: new Date(to) },
      occupiedEnd: { $gt: new Date(from) },
      status: { $in: ["ACTIVE", "EXPIRED"] },
    })
    .sort({ occupiedStart: 1 })
    .toArray();
  return documents.map(toEntry);
};

module.exports = { findCalendarEntries };
