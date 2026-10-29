// Venue conflict detection and the availability calendar (Master 5.4, 5.4.5,
// 7.2, 7.4; SPM-74). Pure functions: the callers load PostgreSQL bookings and
// MongoDB holds and blocks and pass them in. Ranges are half-open [start, end):
// adjacent ranges never conflict; any overlap, even one millisecond, does.

// Operating hours are recorded in venue local time. Singapore has no daylight
// saving, so a fixed offset is exact.
const VENUE_UTC_OFFSET_MINUTES = 8 * 60;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const ENTRY_TYPES = Object.freeze({ BOOKING: "BOOKING", HOLD: "HOLD", BLOCK: "BLOCK" });

const AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  AVAILABLE_WITH_WARNING: "AVAILABLE_WITH_WARNING",
  UNAVAILABLE_BOOKING: "UNAVAILABLE_BOOKING",
  UNAVAILABLE_HOLD: "UNAVAILABLE_HOLD",
  UNAVAILABLE_BLOCK: "UNAVAILABLE_BLOCK",
});

// Display labels belong to the backend (Master 3.5 principle).
const AVAILABILITY_LABELS = Object.freeze({
  AVAILABLE: "Available",
  AVAILABLE_WITH_WARNING: "Potentially suitable – operating-hours warning",
  UNAVAILABLE_BOOKING: "Unavailable – booking",
  UNAVAILABLE_HOLD: "Unavailable – active hold",
  UNAVAILABLE_BLOCK: "Unavailable – operational block",
});

const ENTRY_LABELS = Object.freeze({
  BOOKING_APPROVED: "Confirmed booking",
  BOOKING_PENDING: "Pending booking request",
  HOLD_ACTIVE: "Active hold",
  HOLD_EXPIRED: "Expired hold",
  BLOCK_ACTIVE: "Operational block",
});

const BLOCK_REASON_LABELS = Object.freeze({
  MAINTENANCE: "Maintenance",
  EQUIPMENT_FAILURE: "Equipment failure",
  RENOVATION: "Renovation",
  SAFETY: "Safety",
  OTHER: "Other",
});

const UNAVAILABLE_BY_TYPE = Object.freeze({
  BOOKING: AVAILABILITY.UNAVAILABLE_BOOKING,
  HOLD: AVAILABILITY.UNAVAILABLE_HOLD,
  BLOCK: AVAILABILITY.UNAVAILABLE_BLOCK,
});

const toTime = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

const overlaps = (a, b) => toTime(a.start) < toTime(b.end) && toTime(b.start) < toTime(a.end);

// [start − setup, end + turnaround) (Master 5.4.1). Missing minutes count as zero.
const occupiedRange = (start, end, setupMinutes, turnaroundMinutes) => ({
  start: new Date(toTime(start) - (setupMinutes || 0) * MINUTE_MS),
  end: new Date(toTime(end) + (turnaroundMinutes || 0) * MINUTE_MS),
});

// A hold past its expiry is expired whatever its stored status (Master 5.4.3).
const isHoldActive = (hold, now) =>
  hold.status === "ACTIVE" && hold.holdExpiresAt != null && toTime(hold.holdExpiresAt) > toTime(now);

// "08:00-22:00" or "08:00 - 22:00" → { open: 480, close: 1320 } in minutes from
// local midnight; null when absent or unreadable (no warning can be computed).
const parseOperatingHours = (text) => {
  const match = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-4]):([0-5]\d)\s*$/.exec(text || "");
  if (!match) return null;
  const open = Number(match[1]) * 60 + Number(match[2]);
  const close = Number(match[3]) * 60 + Number(match[4]);
  return close > open && close <= 24 * 60 ? { open, close } : null;
};

// Whole minutes since local midnight.
const localMinutes = (time) => (((Math.floor(time / MINUTE_MS) + VENUE_UTC_OFFSET_MINUTES) % 1440) + 1440) % 1440;
const formatLocal = (time) => {
  const minutes = localMinutes(time);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

// "12:45pm" in venue local time (SGT), as conflict messages show it (SPM-185 AC2, AC6).
const formatClock = (time) => {
  const minutes = localMinutes(time);
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")}${hour < 12 ? "am" : "pm"}`;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const localDay = (time) => Math.floor((time + VENUE_UTC_OFFSET_MINUTES * MINUTE_MS) / DAY_MS);

// The clock time alone on the request's first day; with the date on any other
// day, so multi-day conflicts stay unambiguous.
const formatMoment = (time, requestDay) => {
  if (localDay(time) === requestDay) return formatClock(time);
  const date = new Date(time + VENUE_UTC_OFFSET_MINUTES * MINUTE_MS);
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${formatClock(time)}`;
};

// The parts of an occupied range outside operating hours, as instant ranges.
// A warning, never a block (Master 5.4, Q8).
const outsideOperatingHours = (range, hours) => {
  if (!hours) return [];
  const start = toTime(range.start);
  const end = toTime(range.end);
  const outside = [];
  // Local midnight of the day the range starts, as an instant.
  const startMinute = Math.floor(start / MINUTE_MS) * MINUTE_MS;
  let dayStart = startMinute - localMinutes(startMinute) * MINUTE_MS;
  for (; dayStart < end; dayStart += DAY_MS) {
    const openAt = dayStart + hours.open * MINUTE_MS;
    const closeAt = dayStart + hours.close * MINUTE_MS;
    for (const [from, to] of [[dayStart, openAt], [closeAt, dayStart + DAY_MS]]) {
      const segmentStart = Math.max(from, start);
      const segmentEnd = Math.min(to, end);
      if (segmentStart >= segmentEnd) continue;
      // Time after closing joins the next morning's time before opening.
      const previous = outside[outside.length - 1];
      if (previous && previous.end.getTime() === segmentStart) previous.end = new Date(segmentEnd);
      else outside.push({ start: new Date(segmentStart), end: new Date(segmentEnd) });
    }
  }
  return outside;
};

const operatingHoursWarning = (range, operatingHoursText) => {
  const hours = parseOperatingHours(operatingHoursText);
  const outside = outsideOperatingHours(range, hours);
  if (!outside.length) return null;
  const parts = outside.map((part) => `${formatLocal(toTime(part.start))}–${formatLocal(toTime(part.end))}`);
  return {
    message: `Occupied time ${parts.join(", ")} is outside operating hours (${operatingHoursText.trim()}).`,
    outside: outside.map((part) => ({ start: part.start.toISOString(), end: part.end.toISOString() })),
  };
};

// ---------- building calendar entries ----------

const bookingEntry = (booking, venue) => {
  const range = occupiedRange(booking.start, booking.end, venue.setupMinutes, venue.turnaroundMinutes);
  const approved = booking.status === "APPROVED";
  return {
    entryId: `booking-${booking.bookingId}`,
    type: ENTRY_TYPES.BOOKING,
    status: booking.status,
    label: approved ? ENTRY_LABELS.BOOKING_APPROVED : ENTRY_LABELS.BOOKING_PENDING,
    blocking: true,
    start: new Date(toTime(booking.start)).toISOString(),
    end: new Date(toTime(booking.end)).toISOString(),
    occupiedStart: range.start.toISOString(),
    occupiedEnd: range.end.toISOString(),
    bookingId: booking.bookingId,
    eventId: booking.eventId,
    requestId: booking.requestId,
    eventTitle: booking.eventTitle ?? null,
    holdExpiresAt: null,
    reason: null,
    reasonLabel: null,
    note: null,
  };
};

const calendarEntry = (entry, now) => {
  const isHold = entry.type === ENTRY_TYPES.HOLD;
  const active = isHold ? isHoldActive(entry, now) : entry.status === "ACTIVE";
  let label = ENTRY_LABELS.BLOCK_ACTIVE;
  if (isHold) label = active ? ENTRY_LABELS.HOLD_ACTIVE : ENTRY_LABELS.HOLD_EXPIRED;
  return {
    entryId: `${entry.type.toLowerCase()}-${entry.id}`,
    type: entry.type,
    status: isHold && !active && entry.status === "ACTIVE" ? "EXPIRED" : entry.status,
    label,
    blocking: active,
    start: new Date(toTime(entry.start)).toISOString(),
    end: new Date(toTime(entry.end)).toISOString(),
    occupiedStart: new Date(toTime(entry.occupiedStart)).toISOString(),
    occupiedEnd: new Date(toTime(entry.occupiedEnd)).toISOString(),
    bookingId: null,
    eventId: entry.eventId ?? null,
    requestId: entry.requestId ?? null,
    eventTitle: entry.eventTitle ?? null,
    holdExpiresAt: entry.holdExpiresAt ? new Date(toTime(entry.holdExpiresAt)).toISOString() : null,
    reason: entry.reason ?? null,
    reasonLabel: entry.reason ? BLOCK_REASON_LABELS[entry.reason] || entry.reason : null,
    note: entry.note ?? null,
  };
};

const occupied = (entry) => ({ start: entry.occupiedStart, end: entry.occupiedEnd });

const CONFLICT_PART_LABELS = Object.freeze({ BOOKING: "booking", HOLD: "active hold", BLOCK: "operational block" });

// Explains a refused request (SPM-185 AC2): the part of the existing entry it
// hits (the entry's own time first, then its turnaround, then its setup) and
// whether the request's own setup or turnaround causes it. `request` carries
// the requested window and its occupied range.
const conflictMessage = (entry, request) => {
  const requested = occupied(request);
  const parts = [
    { label: CONFLICT_PART_LABELS[entry.type] || "booking", start: entry.start, end: entry.end },
    { label: "turnaround period", start: entry.end, end: entry.occupiedEnd },
    { label: "setup period", start: entry.occupiedStart, end: entry.start },
  ];
  const part = parts.find((candidate) => toTime(candidate.start) < toTime(candidate.end) && overlaps(candidate, requested)) || parts[0];

  const requestDay = localDay(toTime(request.start));
  const setupMinutes = (toTime(request.start) - toTime(request.occupiedStart)) / MINUTE_MS;
  const turnaroundMinutes = (toTime(request.occupiedEnd) - toTime(request.end)) / MINUTE_MS;
  const own = [];
  if (setupMinutes > 0 && overlaps({ start: request.occupiedStart, end: request.start }, occupied(entry))) {
    own.push(`its ${setupMinutes}-minute setup from ${formatMoment(toTime(request.occupiedStart), requestDay)}`);
  }
  if (turnaroundMinutes > 0 && overlaps({ start: request.end, end: request.occupiedEnd }, occupied(entry))) {
    own.push(`its ${turnaroundMinutes}-minute turnaround until ${formatMoment(toTime(request.occupiedEnd), requestDay)}`);
  }
  const period = `${formatMoment(toTime(part.start), requestDay)}–${formatMoment(toTime(part.end), requestDay)}`;
  return `Venue's ${part.label} (${period}) overlaps with your requested booking${own.length ? `, including ${own.join(" and ")}` : ""}.`;
};

// Pairs of blocking entries whose occupied ranges overlap (SPM-74 AC).
const findOverlaps = (entries) => {
  const blocking = entries.filter((entry) => entry.blocking);
  const pairs = [];
  for (let i = 0; i < blocking.length; i += 1) {
    for (let j = i + 1; j < blocking.length; j += 1) {
      if (overlaps(occupied(blocking[i]), occupied(blocking[j]))) {
        pairs.push({ entryIds: [blocking[i].entryId, blocking[j].entryId] });
      }
    }
  }
  return pairs;
};

// Free periods inside [from, to): the gaps between blocking occupied ranges.
const freePeriods = (entries, from, to) => {
  const ranges = entries
    .filter((entry) => entry.blocking)
    .map((entry) => [Math.max(toTime(entry.occupiedStart), toTime(from)), Math.min(toTime(entry.occupiedEnd), toTime(to))])
    .filter(([start, end]) => start < end)
    .sort((a, b) => a[0] - b[0]);
  const free = [];
  let cursor = toTime(from);
  for (const [start, end] of ranges) {
    if (start > cursor) free.push({ start: new Date(cursor).toISOString(), end: new Date(start).toISOString() });
    cursor = Math.max(cursor, end);
  }
  if (cursor < toTime(to)) free.push({ start: new Date(cursor).toISOString(), end: new Date(toTime(to)).toISOString() });
  return free;
};

// Checks a proposed booking window at one venue (SPM-74 TC3–TC5, TC9, TC10).
// Booking conflicts come first, then holds, then blocks, for the summary status.
const checkRequestedPeriod = (venue, entries, requested) => {
  const range = occupiedRange(requested.start, requested.end, venue.setupMinutes, venue.turnaroundMinutes);
  const request = { start: requested.start, end: requested.end, occupiedStart: range.start, occupiedEnd: range.end };
  const conflicts = entries
    .filter((entry) => entry.blocking && overlaps(range, occupied(entry)))
    .map((entry) => ({
      entryId: entry.entryId,
      type: entry.type,
      occupiedStart: entry.occupiedStart,
      occupiedEnd: entry.occupiedEnd,
      message: conflictMessage(entry, request),
    }));
  const warning = operatingHoursWarning(range, venue.operatingHours);
  const firstType = ["BOOKING", "HOLD", "BLOCK"].find((type) => conflicts.some((conflict) => conflict.type === type));
  let availability = AVAILABILITY.AVAILABLE;
  if (firstType) availability = UNAVAILABLE_BY_TYPE[firstType];
  else if (warning) availability = AVAILABILITY.AVAILABLE_WITH_WARNING;
  return {
    start: new Date(toTime(requested.start)).toISOString(),
    end: new Date(toTime(requested.end)).toISOString(),
    occupiedStart: range.start.toISOString(),
    occupiedEnd: range.end.toISOString(),
    availability,
    availabilityLabel: AVAILABILITY_LABELS[availability],
    canRequest: !firstType,
    conflicts,
    operatingHoursWarning: warning,
  };
};

// One venue's calendar for [from, to). `venue` carries operatingHours and the
// MongoDB setup/turnaround minutes; bookings come from PostgreSQL and
// calendarEntries (holds, blocks) from MongoDB.
const buildVenueCalendar = ({ venue, bookings, calendarEntries, from, to, now, requested = null }) => {
  const window = { start: from, end: to };
  const entries = [
    ...bookings.map((booking) => bookingEntry(booking, venue)),
    ...calendarEntries.map((entry) => calendarEntry(entry, now)),
  ]
    .filter((entry) => overlaps(occupied(entry), window))
    .map((entry) => ({ ...entry, operatingHoursWarning: entry.blocking ? operatingHoursWarning(occupied(entry), venue.operatingHours) : null }))
    .sort((a, b) => toTime(a.occupiedStart) - toTime(b.occupiedStart) || a.entryId.localeCompare(b.entryId));

  const blockingTypes = new Set(entries.filter((entry) => entry.blocking).map((entry) => entry.type));
  const firstType = ["BOOKING", "HOLD", "BLOCK"].find((type) => blockingTypes.has(type));
  const summary = firstType ? UNAVAILABLE_BY_TYPE[firstType] : AVAILABILITY.AVAILABLE;

  return {
    entries,
    overlaps: findOverlaps(entries),
    freePeriods: freePeriods(entries, from, to),
    // "Available" only when nothing blocks any part of the range.
    summary,
    summaryLabel: firstType ? "Partly unavailable" : AVAILABILITY_LABELS.AVAILABLE,
    check: requested ? checkRequestedPeriod(venue, entries, requested) : null,
  };
};

module.exports = {
  ENTRY_TYPES,
  AVAILABILITY,
  AVAILABILITY_LABELS,
  BLOCK_REASON_LABELS,
  VENUE_UTC_OFFSET_MINUTES,
  overlaps,
  occupiedRange,
  isHoldActive,
  parseOperatingHours,
  outsideOperatingHours,
  operatingHoursWarning,
  findOverlaps,
  freePeriods,
  checkRequestedPeriod,
  conflictMessage,
  buildVenueCalendar,
};
