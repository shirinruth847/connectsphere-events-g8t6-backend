// SPM-248 (SPM-243 AC6, AC11; TC-09, TC-20): the review panel and the venue
// detail guard, reading MongoDB venue_details from an in-memory replica set
// (Master M7), never Atlas. PostgreSQL reads are mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn() }));

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const safetyModel = require("../../model/safetyModel");

jest.setTimeout(120000);

const OFFICER_ID = 31;

const ROUND = {
  review_id: 7, event_id: 42, round_number: 2, arrangement_version: 3, status: "OPEN",
  submitted_at: "2026-10-20T01:00:00Z", claimed_by: OFFICER_ID, claimed_at: "2026-10-20T02:00:00Z",
  checklist: null, organiser_comment: null, internal_notes: null, requested_changes: null,
  decided_by: null, decided_at: null, superseded_at: null, safety_review_rejected_bookings: [],
};
const EARLIER_ROUND = { ...ROUND, review_id: 6, round_number: 1, status: "CHANGES_REQUESTED", claimed_by: 32, decided_by: 32, decided_at: "2026-10-19T03:00:00Z", requested_changes: ["Wider aisles"] };
const EVENT = {
  event_id: 42, title: "Open day", status: "SAFETY_REVIEW", start_datetime: "2027-05-01T01:00:00Z", end_datetime: "2027-05-01T05:00:00Z",
  expected_attendance: 180, accessibility_needs: '["Wheelchair access"]', preferred_layout_type: "THEATRE", arrangement_version: 3,
  registration: [{ count: 3 }],
};
const BOOKINGS = [
  { booking_id: 5, label: "Main hall", status: "APPROVED", start_datetime: EVENT.start_datetime, end_datetime: EVENT.end_datetime, expected_attendance: 150, layout_type: null, room: { room_id: 1, layout_type: "THEATRE", capacity: 200, venue: { venue_id: 1, name: "Hall", address: "1 Road", max_capacity: 200 } } },
  { booking_id: 6, label: "Breakout", status: "PENDING", start_datetime: EVENT.start_datetime, end_datetime: EVENT.end_datetime, expected_attendance: 30, layout_type: "CLASSROOM", room: { room_id: 2, layout_type: "BANQUET", capacity: 60, venue: { venue_id: 2, name: "Annex", address: "2 Road", max_capacity: 60 } } },
];
const EQUIPMENT = [
  { equip_request_id: 9, quantity_requested: 2, start_datetime: EVENT.start_datetime, end_datetime: EVENT.end_datetime, status: "APPROVED", technical_notes: "Stage left, clear of exits", equipment: { equipment_id: 1, name: "Speaker", category: "AV" } },
];

// A query builder that accepts any chain of calls and answers with the table's rows.
const queryFor = (rows) => {
  const result = { data: rows, error: null };
  const chain = new Proxy({}, {
    get: (_target, method) => {
      if (method === "then") return (resolve) => resolve(result);
      if (method === "single" || method === "maybeSingle") return async () => ({ data: rows[0] ?? null, error: null });
      return () => chain;
    },
  });
  return chain;
};

const TABLES = {
  safety_reviews: [ROUND, EARLIER_ROUND],
  event: [EVENT],
  venue_booking: BOOKINGS,
  equipment_request: EQUIPMENT,
  activity_log: [],
};

let replSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB_NAME = "spm243_panel_test";
  const db = await getMongoDb();
  await db.collection("venue_details").insertOne({
    _id: "1", pg_version: 1, name: "Hall", location: "1 Road",
    emergencyAccess: "Two exits on the east wall; assembly point in car park B.",
    knownRestrictions: ["No open flames", "Max 200 standing"],
  });
});

afterAll(async () => {
  await closeMongoDb();
  if (replSet) await replSet.stop();
});

beforeEach(() => {
  supabase.from.mockImplementation((table) => queryFor(TABLES[table] || []));
});

describe("findReviewPanel (AC6)", () => {
  test("[SPM-243-TC-09] should_show_bookings_equipment_rounds_and_each_venue's_safety_detail", async () => {
    const panel = await safetyModel.findReviewPanel(7, OFFICER_ID);
    expect(panel.review).toMatchObject({ reviewId: 7, roundNumber: 2, claimedBy: OFFICER_ID });
    expect(panel.event).toMatchObject({ requestId: "REQ-000042", expectedAttendance: 180, registeredCount: 3, accessibilityNeeds: ["Wheelchair access"], arrangementVersion: 3 });
    expect(panel.bookings.map((booking) => [booking.bookingId, booking.venue.name, booking.layoutType, booking.venue.capacity])).toEqual([
      [5, "Hall", "THEATRE", 200],
      [6, "Annex", "CLASSROOM", 60],
    ]);
    expect(panel.equipment).toEqual([expect.objectContaining({ name: "Speaker", quantity: 2, placement: "Stage left, clear of exits" })]);
    expect(panel.rounds.map((round) => [round.roundNumber, round.status])).toEqual([[2, "OPEN"], [1, "CHANGES_REQUESTED"]]);
    expect(panel.venueDetailsAvailable).toBe(true);
    expect(panel.venueDetails).toEqual([
      { venueId: 1, found: true, emergencyAccess: "Two exits on the east wall; assembly point in car park B.", knownRestrictions: ["No open flames", "Max 200 standing"] },
      { venueId: 2, found: false, emergencyAccess: null, knownRestrictions: [] },
    ]);
    expect(JSON.stringify(panel)).not.toMatch(/attendee_id|email/);
  });

  test("[SPM-243-AC2] should_answer_not_found_for_a_round_another_officer_holds", async () => {
    await expect(safetyModel.findReviewPanel(7, 99)).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
  });
});

describe("MongoDB unavailable (AC11)", () => {
  test("[SPM-243-TC-20] should_load_the_panel_flagged_and_refuse_decisions", async () => {
    await closeMongoDb();
    const uri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      const panel = await safetyModel.findReviewPanel(7, OFFICER_ID);
      expect(panel.venueDetailsAvailable).toBe(false);
      expect(panel.venueDetails).toEqual([]);
      expect(panel.bookings).toHaveLength(2);
      await expect(safetyModel.assertVenueDetailsReadable(42)).rejects.toMatchObject({ code: "VENUE_DETAILS_UNAVAILABLE" });
    } finally {
      process.env.MONGODB_URI = uri;
    }
    await expect(safetyModel.assertVenueDetailsReadable(42)).resolves.toBeUndefined();
  });
});
