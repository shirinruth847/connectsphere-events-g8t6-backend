const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");

const root = path.resolve(__dirname, "../..");
const migrationsDir = path.join(root, "supabase/migrations");
const listMigration = () => fs.readFileSync(
  path.join(migrationsDir, fs.readdirSync(migrationsDir).find((name) => name.endsWith("_spm174_lead_assignment_conflict_guard.sql"))),
  "utf8",
);

const LEAD = 2;
const OTHER_LEAD = 5;
const INACTIVE_LEAD = 6;
const C1 = 3;
const C2 = 4;

// Fixtures go in before the migration, as in SPM-174, so the legacy clash
// between E1 and E9 survives the overlap guard the migration adds.
const setup = async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm36DatabaseSchema.sql"), "utf8"));
  await db.exec(`
    CREATE UNIQUE INDEX one_active_assignment ON public.event_assignments(event_id) WHERE ended_at IS NULL;
    INSERT INTO public."user"(user_id, email, name, role, is_active) VALUES
      (1, 'spm182-owner@connectsphere.test', 'SPM182 Owner', 'ORGANISER', true),
      (${LEAD}, 'spm182-lead@connectsphere.test', 'SPM182 Lead', 'COORDINATOR_LEAD', true),
      (${C1}, 'spm182-c1@connectsphere.test', 'SPM182 Coordinator One', 'COORDINATOR', true),
      (${C2}, 'spm182-c2@connectsphere.test', 'SPM182 Coordinator Two', 'COORDINATOR', true),
      (${OTHER_LEAD}, 'spm182-lead2@connectsphere.test', 'SPM182 Other Lead', 'COORDINATOR_LEAD', true),
      (${INACTIVE_LEAD}, 'spm182-lead3@connectsphere.test', 'SPM182 Inactive Lead', 'COORDINATOR_LEAD', false);
    INSERT INTO public.event(event_id, organiser_id, coordinator_id, title, status, start_datetime, end_datetime) VALUES
      (1, 1, ${C1}, 'E1 supervised planning', 'PLANNING', '2030-01-03T10:00Z', '2030-01-03T12:00Z'),
      (2, 1, ${C2}, 'E2 supervised review', 'UNDER_REVIEW', '2030-01-02T10:00Z', '2030-01-02T12:00Z'),
      (3, 1, NULL, 'E3 waiting in queue', 'SUBMITTED', '2030-03-01T10:00Z', '2030-03-01T12:00Z'),
      (4, 1, NULL, 'E4 waiting in queue', 'SUBMITTED', '2030-03-05T10:00Z', '2030-03-05T12:00Z'),
      (9, 1, ${C1}, 'E9 other Lead, overlaps E1', 'PLANNING', '2030-01-03T11:00Z', '2030-01-03T13:00Z'),
      (10, 1, ${C2}, 'E10 legacy unsupervised', 'PLANNING', '2030-02-01T10:00Z', '2030-02-01T12:00Z'),
      (11, 1, ${C1}, 'E11 completed', 'COMPLETED', '2029-01-01T10:00Z', '2029-01-01T12:00Z'),
      (12, 1, ${C1}, 'E12 cancelled', 'CANCELLED', '2030-01-03T10:00Z', '2030-01-03T12:00Z'),
      (13, 1, ${C2}, 'E13 rejected', 'REJECTED', '2030-01-02T10:00Z', '2030-01-02T12:00Z'),
      (14, 1, NULL, 'E14 draft', 'DRAFT', '2030-04-01T10:00Z', '2030-04-01T12:00Z');
    INSERT INTO public.event_assignments(event_id, coordinator_id, assigned_by) VALUES
      (1, ${C1}, ${LEAD}), (2, ${C2}, ${LEAD}), (9, ${C1}, ${OTHER_LEAD}),
      (11, ${C1}, ${LEAD}), (12, ${C1}, ${LEAD}), (13, ${C2}, ${LEAD});
  `);
  await db.exec(listMigration());
  return db;
};

const overviewFor = async (db, leadId) => (
  await db.query("SELECT public.list_lead_event_assignments($1) AS result", [leadId])
).rows[0].result;

const ids = (rows) => rows.map((row) => row.eventId);

// Stands in for assign_event_coordinator (SPM-177): its current version needs
// later migrations, and the overview only reads the rows it writes.
const assignFromQueue = (db, eventId, coordinatorId, leadId) => db.exec(`
  UPDATE public.event SET coordinator_id = ${coordinatorId}, status = 'UNDER_REVIEW' WHERE event_id = ${eventId};
  INSERT INTO public.event_assignments(event_id, coordinator_id, assigned_by) VALUES (${eventId}, ${coordinatorId}, ${leadId});
`);

test("[SPM-182-AC1][TC-01] lists supervised and legacy events by start time with the current coordinator", async () => {
  const db = await setup();
  try {
    const rows = await overviewFor(db, LEAD);
    assert.deepEqual(ids(rows), [2, 1, 10]);
    const [e2, e1, e10] = rows;
    assert.equal(e2.requestId, "REQ-000002");
    assert.equal(e2.status, "UNDER_REVIEW");
    assert.equal(e2.coordinatorName, "SPM182 Coordinator Two");
    assert.equal(e1.coordinatorId, C1);
    assert.equal(e1.coordinatorName, "SPM182 Coordinator One");
    assert.equal(e1.supervisingLeadId, LEAD);
    assert.equal(e10.supervisingLeadId, null);
  } finally {
    await db.close();
  }
});

test("[SPM-182-AC4][TC-08][TC-09] shows only the Lead's own supervision plus legacy events, never terminal, draft or queued ones", async () => {
  const db = await setup();
  try {
    const lead = ids(await overviewFor(db, LEAD));
    const otherLead = ids(await overviewFor(db, OTHER_LEAD));
    assert.ok(!lead.includes(9), "another Lead's event leaked into the overview");
    assert.deepEqual(otherLead, [9, 10]);
    for (const hidden of [3, 4, 11, 12, 13, 14]) {
      assert.ok(!lead.includes(hidden) && !otherLead.includes(hidden), `event ${hidden} should not be listed`);
    }
  } finally {
    await db.close();
  }
});

test("[SPM-182-AC6][TC-10] flags a scheduling conflict only on the overlapping supervised event", async () => {
  const db = await setup();
  try {
    const rows = await overviewFor(db, LEAD);
    assert.deepEqual(rows.filter((row) => row.hasScheduleConflict).map((row) => row.eventId), [1]);
  } finally {
    await db.close();
  }
});

test("[SPM-182-AC2][TC-05][TC-06] a reassignment shows the new coordinator once and keeps the event with its Lead", async () => {
  const db = await setup();
  try {
    await db.query("SELECT public.reassign_event_coordinator($1, $2, $3, $4)", [2, C1, C2, LEAD]);
    const rows = await overviewFor(db, LEAD);
    const e2 = rows.filter((row) => row.eventId === 2);
    assert.equal(e2.length, 1);
    assert.equal(e2[0].coordinatorId, C1);
    assert.equal(e2[0].coordinatorName, "SPM182 Coordinator One");
    assert.equal(e2[0].supervisingLeadId, LEAD);
    assert.ok(!ids(await overviewFor(db, OTHER_LEAD)).includes(2));
  } finally {
    await db.close();
  }
});

test("[SPM-182-AC5][TC-07] an assigned event moves into the assigning Lead's overview only", async () => {
  const db = await setup();
  try {
    await assignFromQueue(db, 3, C2, LEAD);
    await assignFromQueue(db, 4, C2, OTHER_LEAD);
    const lead = await overviewFor(db, LEAD);
    assert.deepEqual(ids(lead), [2, 1, 10, 3]);
    assert.equal(lead.find((row) => row.eventId === 3).coordinatorName, "SPM182 Coordinator Two");
    assert.ok(!ids(lead).includes(4));
    assert.ok(ids(await overviewFor(db, OTHER_LEAD)).includes(4));
  } finally {
    await db.close();
  }
});

test("[SPM-182-AC9][TC-15] refuses a deactivated Lead and a non-Lead", async () => {
  const db = await setup();
  try {
    await assert.rejects(overviewFor(db, INACTIVE_LEAD), (error) => error.message === "FORBIDDEN");
    await assert.rejects(overviewFor(db, C1), (error) => error.message === "FORBIDDEN");
  } finally {
    await db.close();
  }
});
