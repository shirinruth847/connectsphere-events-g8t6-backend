process.env.ENABLE_COORDINATOR_WORKFLOWS = "true";
// SPM-286 / SPM-287 on the live database, through the real API. Needs
// supabase/migrations/20261031090000_spm286_287_technical_requests.sql and
// TEST_DATABASE_URL (audit cleanup). Every row is a spm32-<runId> fixture on
// its own equipment, so other data never changes the quantities; cleanup
// removes events (cascading requests and lines), notifications, equipment,
// history and accounts.
const crypto = require("crypto");
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { createLifecycleEvent, cleanupLifecycleRows } = require("../fixtures/lifecycleFixtures");

jest.setTimeout(180000);

const runId = newRunId();
const createdEventIds = [];
let fixtures;
let mics;
let projectors;
const sessions = new Map();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed.`);
      return session;
    }));
  }
  return sessions.get(key);
};

const call = async (method, path, key, body, headers = {}) => {
  const session = await signIn(key);
  let req = request(app)[method](path).set("Authorization", `Bearer ${session.access_token}`);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};

const check = ({ data, error }, step) => {
  if (error) throw new Error(`${step} failed: ${error.message}`);
  return data;
};

const newKey = () => crypto.randomUUID();
const at = (day, hour) => new Date(Date.UTC(2031, 4, day, hour)).toISOString();

const createEquipment = async (name, totalQuantity) => {
  const row = check(
    await supabase
      .from("equipment")
      .insert({ name: `spm32-${runId} ${name}`, category: "AV", total_quantity: totalQuantity, is_active: true, details_pending: false })
      .select("equipment_id")
      .single(),
    `equipment ${name}`
  );
  recordFixtureIds(runId, "equipmentIds", [row.equipment_id]);
  return row.equipment_id;
};

const planningEvent = async (day, startHour, endHour, overrides = {}) => {
  const event = await createLifecycleEvent(fixtures, { start_datetime: at(day, startHour), end_datetime: at(day, endHour), ...overrides });
  createdEventIds.push(event.event_id);
  return event;
};

const send = (event, items, key = "coordinator", idempotencyKey = newKey()) =>
  call("post", `/api/events/${event.event_id}/technical-requests`, key, { items }, { "Idempotency-Key": idempotencyKey });

const decide = (requestId, body, key = "techSupport", idempotencyKey = newKey()) =>
  call("post", `/api/equipment/requests/${requestId}/decision`, key, body, { "Idempotency-Key": idempotencyKey });

const availableFor = async (equipmentId, start, end, key = "organiserA") => {
  const res = await call("get", `/api/events/equipment-options?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, key);
  expect(res.status).toBe(200);
  return res.body.equipment.find((item) => item.equipmentId === equipmentId).availableQuantity;
};

const notices = async (userKey, eventId) =>
  check(
    await supabase
      .from("notification_recipient")
      .select("notification!inner(title,message,event_id)")
      .eq("recipient_id", fixtures.accounts[userKey].userId)
      .eq("notification.event_id", eventId),
    "notices"
  ).map((row) => row.notification);

beforeAll(async () => {
  await require("../fixtures/adminCleanup").assertAuditCleanupAvailable();
  fixtures = await createAuthFixtures(runId, { extraAccounts: [{ key: "techSupportTwo", role: "TECH_SUPPORT" }] });
  mics = await createEquipment("Wireless Mic", 12);
  projectors = await createEquipment("Stage Projector", 3);
});

afterAll(async () => {
  if (fixtures) await cleanupLifecycleRows(runId, [...Object.values(fixtures.events), ...createdEventIds]);
  await cleanupAuthFixtures(runId);
});

describe("SPM-286 equipment request", () => {
  test("[SPM-286-TC-01][SPM-286-TC-02][SPM-286-TC-06] a PENDING request holds 4 mics for the overlap only; Technical Support are notified", async () => {
    const eventA = await planningEvent(1, 10, 12);
    const res = await send(eventA, [{ equipmentId: mics, quantity: 4 }]);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");

    expect(await availableFor(mics, at(1, 11), at(1, 13))).toBe(8);
    expect(await availableFor(mics, at(1, 12), at(1, 14))).toBe(12);
    expect(await availableFor(mics, at(1, 11), at(1, 13), "coordinatorTwo")).toBe(8);
    for (const key of ["techSupport", "techSupportTwo"]) {
      expect((await notices(key, eventA.event_id)).map((n) => n.title)).toEqual(["New technical request"]);
    }
  });

  test("[SPM-286-AC2] without a date and time, usable stock with a note", async () => {
    const res = await call("get", "/api/events/equipment-options", "organiserA");
    expect(res.status).toBe(200);
    expect(res.body.note).toMatch(/confirmed once/);
    expect(res.body.equipment.find((item) => item.equipmentId === mics).availableQuantity).toBe(12);
  });

  test("[SPM-286-TC-03][SPM-286-TC-05] a draft keeps 2 projectors and 4 mics; too many is a field error", async () => {
    const window = { startDatetime: at(2, 9), endDatetime: at(2, 11) };
    const requirements = [{ equipmentId: projectors, quantity: 2 }, { equipmentId: mics, quantity: 4 }];
    const saved = await call("post", "/api/events/drafts", "organiserA", { title: `spm32-${runId} draft`, ...window, equipmentRequirements: requirements }, { "Idempotency-Key": newKey() });
    expect(saved.status).toBe(201);
    createdEventIds.push(saved.body.event.eventId);
    recordFixtureIds(runId, "eventIds", [saved.body.event.eventId]);

    const reopened = await call("get", `/api/events/${saved.body.event.eventId}`, "organiserA");
    expect(reopened.body.event.equipmentRequirements).toEqual(expect.arrayContaining(requirements.map((item) => expect.objectContaining(item))));

    const tooMany = await call("post", "/api/events/drafts", "organiserA", { title: `spm32-${runId} too many`, ...window, equipmentRequirements: [{ equipmentId: projectors, quantity: 4 }] }, { "Idempotency-Key": newKey() });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.fields.equipmentRequirements).toMatch(/3 available/);
  });

  test("[SPM-286-TC-04][SPM-286-TC-10] requirements are shown to the owner, same-organisation organisers and the coordinator, not another organisation", async () => {
    const event = await planningEvent(3, 9, 10);
    check(await supabase.from("event_equipment_requirement").insert({ event_id: event.event_id, equipment_id: mics, quantity_requested: 2 }), "requirement");
    for (const key of ["organiserA", "organiserA2", "coordinator"]) {
      const res = await call("get", `/api/events/${event.event_id}`, key);
      expect(res.status).toBe(200);
      expect(res.body.event.equipmentRequirements).toEqual([expect.objectContaining({ equipmentId: mics, quantity: 2 })]);
    }
    expect((await call("get", `/api/events/${event.event_id}`, "organiserB")).status).toBe(404);
  });

  test("[SPM-286-TC-07] refused while the event is Under Review", async () => {
    const event = await planningEvent(4, 9, 10, { status: "UNDER_REVIEW" });
    const res = await send(event, [{ equipmentId: mics, quantity: 1 }]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_NOT_IN_PLANNING");
    expect(await availableFor(mics, at(4, 9), at(4, 10))).toBe(12);
  });

  test("[SPM-286-TC-08] two coordinators race for the last projectors: one succeeds, the other sees the available quantity", async () => {
    const first = await planningEvent(5, 9, 11);
    const second = await planningEvent(5, 10, 12, { coordinator_id: fixtures.accounts.coordinatorTwo.userId });
    const results = await Promise.all([
      send(first, [{ equipmentId: projectors, quantity: 3 }], "coordinator"),
      send(second, [{ equipmentId: projectors, quantity: 3 }], "coordinatorTwo"),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    const refused = results.find((res) => res.status === 409);
    expect(refused.body.code).toBe("EQUIPMENT_NOT_AVAILABLE");
    expect(refused.body.items).toEqual([expect.objectContaining({ equipmentId: projectors, requested: 3, available: 0 })]);
  });

  test("[SPM-286-TC-09] the same request retried with the same key creates one request", async () => {
    const event = await planningEvent(6, 9, 10);
    const idempotencyKey = newKey();
    const first = await send(event, [{ equipmentId: mics, quantity: 1 }], "coordinator", idempotencyKey);
    const retry = await send(event, [{ equipmentId: mics, quantity: 1 }], "coordinator", idempotencyKey);
    expect([first.status, retry.status]).toEqual([201, 200]);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.technicalRequestId).toBe(first.body.technicalRequestId);
    const { count } = await supabase.from("technical_request").select("technical_request_id", { count: "exact", head: true }).eq("event_id", event.event_id);
    expect(count).toBe(1);
  });
});

describe("SPM-287 equipment dashboard", () => {
  let older;
  let newer;

  beforeAll(async () => {
    older = await planningEvent(10, 9, 11);
    // Overlaps older, so another coordinator (one coordinator cannot hold overlapping events).
    newer = await planningEvent(10, 10, 12, { coordinator_id: fixtures.accounts.coordinatorTwo.userId });
    older.requestId = (await send(older, [{ equipmentId: projectors, quantity: 1 }, { equipmentId: mics, quantity: 2 }])).body.technicalRequestId;
    newer.requestId = (await send(newer, [{ equipmentId: projectors, quantity: 2 }], "coordinatorTwo")).body.technicalRequestId;
  });

  test("[SPM-287-TC-01] Pending requests, oldest first, with the details", async () => {
    const res = await call("get", `/api/equipment/requests?status=PENDING&search=spm32-${runId}&limit=100`, "techSupport");
    expect(res.status).toBe(200);
    const ids = res.body.technicalRequests.map((item) => item.technicalRequestId);
    expect(ids.indexOf(older.requestId)).toBeLessThan(ids.indexOf(newer.requestId));
    const item = res.body.technicalRequests.find((row) => row.technicalRequestId === older.requestId);
    expect(item).toMatchObject({ status: "PENDING", event: { eventId: older.event_id, title: older.title }, requestedBy: { userId: fixtures.accounts.coordinator.userId } });
    expect(item.items).toHaveLength(2);
  });

  test("[SPM-287-TC-03] the detail shows items, availability excluding this request, schedule and history", async () => {
    const res = await call("get", `/api/equipment/requests/${older.requestId}`, "techSupport");
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ eventId: older.event_id, start: expect.any(String), end: expect.any(String) });
    // Newer overlaps and holds 2 projectors: 3 - 2 = 1 left for this request.
    expect(res.body.items.find((item) => item.equipmentId === projectors).availableQuantity).toBe(1);
    expect(res.body.history.map((entry) => entry.action)).toEqual(["TECHNICAL_REQUEST_SENT"]);
  });

  test("[SPM-287-TC-07] a Coordinator or Organiser is denied the dashboard", async () => {
    for (const key of ["coordinator", "organiserA"]) {
      expect((await call("get", "/api/equipment/requests", key)).status).toBe(403);
      expect((await decide(older.requestId, { decision: "APPROVE" }, key)).status).toBe(403);
    }
  });

  test("[SPM-287-TC-06] reject without a reason is blocked", async () => {
    const res = await decide(newer.requestId, { decision: "REJECT", reason: " " });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("reason");
  });

  test("[SPM-287-TC-04][SPM-287-TC-10][SPM-287-TC-09] approve once: retried with the key replays; a second decider is told it was decided", async () => {
    const idempotencyKey = newKey();
    const [approved, raced] = await Promise.all([
      decide(older.requestId, { decision: "APPROVE" }, "techSupport", idempotencyKey),
      decide(older.requestId, { decision: "REJECT", reason: "Late" }, "techSupportTwo"),
    ]);
    const statuses = [approved.status, raced.status];
    expect(statuses).toContain(200);
    expect(statuses).toContain(409);
    const winner = approved.status === 200 ? "techSupport" : "techSupportTwo";
    const loser = approved.status === 200 ? raced : approved;
    expect(loser.body.code).toBe("TECHNICAL_REQUEST_ALREADY_DECIDED");

    if (winner === "techSupport") {
      const retry = await decide(older.requestId, { decision: "APPROVE" }, "techSupport", idempotencyKey);
      expect(retry.status).toBe(200);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect((await notices("coordinator", older.event_id)).map((n) => n.title)).toEqual(["Technical request approved"]);
      expect((await notices("organiserA", older.event_id)).map((n) => n.title)).toEqual(["Equipment approved"]);
      expect(await notices("organiserA2", older.event_id)).toEqual([]);
      const detail = await call("get", `/api/equipment/requests/${older.requestId}`, "techSupport");
      expect(detail.body.history.map((entry) => entry.action)).toEqual(["TECHNICAL_REQUEST_SENT", "TECHNICAL_REQUEST_APPROVED"]);
    }
    expect((await call("get", `/api/equipment/requests/${older.requestId}`, "techSupport")).body.status).not.toBe("PENDING");
  });

  test("[SPM-287-TC-05][SPM-287-TC-08] reject with a reason releases the projectors; the decision is final", async () => {
    const before = await availableFor(projectors, at(10, 11), at(10, 12));
    const res = await decide(newer.requestId, { decision: "REJECT", reason: "Projector unavailable" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("REJECTED");
    expect(await availableFor(projectors, at(10, 11), at(10, 12))).toBe(before + 2);
    const [notice] = await notices("coordinatorTwo", newer.event_id);
    expect(notice.message).toMatch(/Reason: Projector unavailable\./);
    expect(await notices("organiserA", newer.event_id)).toEqual([]);

    const again = await decide(newer.requestId, { decision: "APPROVE" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "TECHNICAL_REQUEST_ALREADY_DECIDED", status: "REJECTED" });
  });

  test("[SPM-287-TC-02] filter Approved + search by title returns only that request", async () => {
    const approved = (await call("get", `/api/equipment/requests/${older.requestId}`, "techSupport")).body.status;
    const res = await call("get", `/api/equipment/requests?status=${approved}&search=${encodeURIComponent(older.title)}`, "techSupport");
    expect(res.status).toBe(200);
    expect(res.body.technicalRequests.every((item) => item.status === approved && item.event.title === older.title)).toBe(true);
    expect(res.body.technicalRequests.map((item) => item.technicalRequestId)).toContain(older.requestId);
  });
});

describe("SPM-286/287 review fixes", () => {
  let event;
  let first;
  let second;

  beforeAll(async () => {
    event = await planningEvent(15, 9, 17);
    first = (await send(event, [{ equipmentId: projectors, quantity: 1 }, { equipmentId: mics, quantity: 2 }])).body.technicalRequestId;
    expect((await decide(first, { decision: "REJECT", reason: "Projector booked" })).status).toBe(200);
    second = (await send(event, [{ equipmentId: mics, quantity: 3 }])).body.technicalRequestId;
    expect((await decide(second, { decision: "APPROVE" })).status).toBe(200);
  });

  test("[SPM-286-AC5] the assigned coordinator reads the event's requests, one row per request", async () => {
    const res = await call("get", `/api/events/${event.event_id}/arrangements`, "coordinator");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.arrangements)).toEqual(["technical"]);
    expect(res.body.arrangements.technical.requests.map((request) => [request.requestId, request.status, request.equipment.length])).toEqual([
      [second, "APPROVED", 1],
      [first, "REJECTED", 2],
    ]);
    expect((await call("get", `/api/events/${event.event_id}/arrangements`, "coordinatorTwo")).status).toBe(404);
  });

  test("[SPM-286-AC4] the organiser view groups requests the same way", async () => {
    const res = await call("get", `/api/events/${event.event_id}/arrangements`, "organiserA");
    expect(res.status).toBe(200);
    expect(res.body.arrangements.technical.requests.map((request) => request.requestId)).toEqual([second, first]);
    expect(res.body.arrangements.venues).toBeDefined();
  });

  test("[SPM-287-HISTORY] the event history shows only labelled status changes", async () => {
    const res = await call("get", `/api/events/${event.event_id}/history?limit=50`, "coordinator");
    expect(res.status).toBe(200);
    const technical = res.body.history.filter((entry) => entry.action.startsWith("TECHNICAL_REQUEST_"));
    expect(technical).toHaveLength(4);
    for (const entry of technical) {
      expect(entry.changes).toEqual([expect.objectContaining({ field: "technicalRequestStatus", label: "Technical request" })]);
    }
    expect(technical.map((entry) => entry.changes[0].afterLabel).sort()).toEqual(["Approved", "Pending", "Pending", "Rejected"]);
  });

  test("[SPM-287-SCHEDULE] Technical Support see the event on its Singapore date with its active equipment", async () => {
    const res = await call("get", "/api/equipment/schedule?from=2031-05-15&to=2031-05-15", "techSupport");
    expect(res.status).toBe(200);
    const [day] = res.body.days;
    expect(day.date).toBe("2031-05-15");
    const listed = day.events.find((item) => item.eventId === event.event_id);
    expect(listed).toMatchObject({ title: event.title, start: expect.any(String), end: expect.any(String) });
    expect(listed.equipment).toEqual([expect.objectContaining({ equipmentId: mics, quantity: 3, status: "APPROVED", technicalRequestId: second })]);
    expect((await call("get", "/api/equipment/schedule?from=2031-05-15&to=2031-05-15", "coordinator")).status).toBe(403);
  });
});
