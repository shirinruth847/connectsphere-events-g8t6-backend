jest.mock("../../config/supabase", () => ({
  from: jest.fn(),
  rpc: jest.fn(),
}));

const supabase = require("../../config/supabase");
const { toAttendeeEvent, findAttendeeRegistrations } = require("../../model/registrationModel");

const queryReturning = (result) => {
  const query = {};
  for (const method of ["select", "eq", "neq", "order", "in"]) {
    query[method] = jest.fn(() => query);
  }
  query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  query.range = jest.fn().mockResolvedValue(result);
  return query;
};

const booking = (venueId, name, status = "APPROVED") => ({
  status,
  room: { venue: { venue_id: venueId, name, address: `${venueId} Synthetic Road` } },
});

const currentEvent = (overrides = {}) => ({
  event_id: 41,
  title: "Current title",
  description: "Current description",
  start_datetime: "2027-03-02T10:00:00+00:00",
  end_datetime: "2027-03-02T12:00:00+00:00",
  status: "CONFIRMED",
  is_published: true,
  venue_booking: [booking(1, "Main Hall")],
  ...overrides,
});

const confirmedSnapshot = (overrides = {}) => ({
  confirmed_at: "2026-10-20T09:00:00+00:00",
  snapshot: {
    is_published: true,
    title: "Confirmed title",
    description: "Confirmed description",
    start_datetime: "2027-03-01T10:00:00+00:00",
    end_datetime: "2027-03-01T12:00:00+00:00",
    primary_venue: { venue_id: 9, name: "Confirmed Hall", address: "9 Confirmed Road" },
    registration_capacity: 80,
    ...overrides,
  },
});

beforeEach(() => jest.clearAllMocks());

describe("[SPM-141] My Events event values follow the attendee detail rules", () => {
  test("[TC-MYE-001] a published confirmed event shows its current date, time and venue", () => {
    expect(toAttendeeEvent(currentEvent())).toEqual({
      event_id: 41,
      title: "Current title",
      description: "Current description",
      start_datetime: "2027-03-02T10:00:00+00:00",
      end_datetime: "2027-03-02T12:00:00+00:00",
      attendee_status: "CONFIRMED",
      venue: { name: "Main Hall", address: "1 Synthetic Road" },
    });
  });

  test.each(["PLANNING", "SAFETY_REVIEW"])(
    "an event back in %s shows the last confirmation snapshot, never the unconfirmed changes",
    (status) => {
      const view = toAttendeeEvent(currentEvent({ status }), confirmedSnapshot());
      expect(view).toEqual({
        event_id: 41,
        title: "Confirmed title",
        description: "Confirmed description",
        start_datetime: "2027-03-01T10:00:00+00:00",
        end_datetime: "2027-03-01T12:00:00+00:00",
        attendee_status: "PENDING_CONFIRMATION",
        venue: { name: "Confirmed Hall", address: "9 Confirmed Road" },
      });
    }
  );

  test("[TC-MYE-003] a cancelled event keeps its cancelled status apart from the place, with its confirmed values", () => {
    const view = toAttendeeEvent(currentEvent({ status: "CANCELLED" }), confirmedSnapshot());
    expect(view.attendee_status).toBe("CANCELLED");
    expect(view.start_datetime).toBe("2027-03-01T10:00:00+00:00");
    expect(view).not.toHaveProperty("status");
  });

  test("a cancelled event that was never confirmed shows only its title and status", () => {
    expect(toAttendeeEvent(currentEvent({ status: "CANCELLED" }), null)).toEqual({
      event_id: 41,
      title: "Current title",
      description: null,
      start_datetime: null,
      end_datetime: null,
      attendee_status: "CANCELLED",
      venue: null,
    });
  });

  test("a snapshot taken while the event was unpublished is not shown", () => {
    const view = toAttendeeEvent(currentEvent({ status: "PLANNING" }), confirmedSnapshot({ is_published: false }));
    expect(view).toMatchObject({ title: "Current title", description: null, start_datetime: null, venue: null });
  });

  test("an unpublished confirmed event withholds its current values", () => {
    const view = toAttendeeEvent(currentEvent({ is_published: false }), confirmedSnapshot());
    expect(view).toMatchObject({ description: null, start_datetime: null, end_datetime: null, venue: null });
  });

  test("a snapshot is ignored for a confirmed event, whose current values are the confirmed ones", () => {
    expect(toAttendeeEvent(currentEvent(), confirmedSnapshot()).title).toBe("Current title");
  });

  test("two approved venues are ambiguous, so no venue is shown, as in event details", () => {
    const view = toAttendeeEvent(currentEvent({ venue_booking: [booking(1, "Main Hall"), booking(2, "Annex")] }));
    expect(view.venue).toBeNull();
  });

  test("two approved bookings of one venue show that venue; pending bookings never show", () => {
    expect(toAttendeeEvent(currentEvent({ venue_booking: [booking(1, "Main Hall"), booking(1, "Main Hall")] })).venue)
      .toEqual({ name: "Main Hall", address: "1 Synthetic Road" });
    expect(toAttendeeEvent(currentEvent({ venue_booking: [booking(3, "Pending Hall", "PENDING")] })).venue).toBeNull();
  });

  test("snapshot internals such as capacity and venue ID never reach the attendee", () => {
    const view = toAttendeeEvent(currentEvent({ status: "PLANNING" }), confirmedSnapshot());
    expect(Object.keys(view).sort()).toEqual(
      ["attendee_status", "description", "end_datetime", "event_id", "start_datetime", "title", "venue"]
    );
    expect(Object.keys(view.venue).sort()).toEqual(["address", "name"]);
  });
});

describe("[SPM-141] findAttendeeRegistrations", () => {
  const row = (registrationId, event, status = "REGISTERED") => ({
    registration_id: registrationId,
    registration_status: status,
    registration_datetime: "2026-10-30T09:00:00+00:00",
    event,
  });

  const tables = (rows, snapshots = []) => {
    const registrationQuery = queryReturning({ data: rows, error: null });
    const snapshotQuery = queryReturning({ data: snapshots, error: null });
    supabase.from.mockImplementation((table) => (table === "event_confirmation_snapshots" ? snapshotQuery : registrationQuery));
    return { registrationQuery, snapshotQuery };
  };

  test("[TC-MYE-010][TC-MYE-011] reads only this attendee's places and leaves out withdrawn ones", async () => {
    const { registrationQuery } = tables([]);
    await findAttendeeRegistrations(21, { limit: 50, offset: 0 });
    expect(registrationQuery.eq).toHaveBeenCalledWith("attendee_id", 21);
    expect(registrationQuery.neq).toHaveBeenCalledWith("registration_status", "WITHDRAWN");
  });

  test("[TC-MYE-006] no places is an empty page, without a snapshot read", async () => {
    tables([]);
    await expect(findAttendeeRegistrations(21, { limit: 50, offset: 0 })).resolves.toEqual({ registrations: [], nextOffset: null });
    expect(supabase.from).not.toHaveBeenCalledWith("event_confirmation_snapshots");
  });

  test("[TC-MYE-013] reads one extra row to know whether another page follows, and never returns it", async () => {
    const { registrationQuery } = tables([row(3, currentEvent({ event_id: 3 })), row(2, currentEvent({ event_id: 2 }))]);
    const result = await findAttendeeRegistrations(21, { limit: 1, offset: 4 });
    expect(registrationQuery.range).toHaveBeenCalledWith(4, 5);
    expect(result.registrations.map((registration) => registration.registration_id)).toEqual([3]);
    expect(result.nextOffset).toBe(5);
  });

  test("[TC-MYE-005] reads the latest snapshots once per page, only for events that need them", async () => {
    const { snapshotQuery } = tables(
      [
        row(1, currentEvent({ event_id: 1 })),
        row(2, currentEvent({ event_id: 2, status: "PLANNING" })),
        row(3, currentEvent({ event_id: 3, status: "CANCELLED" }), "WAITLISTED"),
      ],
      [
        { event_id: 2, ...confirmedSnapshot({ title: "Newest" }) },
        { event_id: 2, ...confirmedSnapshot({ title: "Older" }) },
      ]
    );
    const { registrations } = await findAttendeeRegistrations(21, { limit: 50, offset: 0 });
    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(snapshotQuery.in).toHaveBeenCalledWith("event_id", [2, 3]);
    expect(snapshotQuery.order).toHaveBeenCalledWith("snapshot_id", { ascending: false });
    expect(registrations.map(({ registration_status, event }) => [registration_status, event.title, event.attendee_status])).toEqual([
      ["REGISTERED", "Current title", "CONFIRMED"],
      ["REGISTERED", "Newest", "PENDING_CONFIRMATION"],
      ["WAITLISTED", "Current title", "CANCELLED"],
    ]);
  });

  test("a failed snapshot read fails the request instead of showing unconfirmed values", async () => {
    supabase.from.mockImplementation((table) =>
      table === "event_confirmation_snapshots"
        ? queryReturning({ data: null, error: { message: "boom" } })
        : queryReturning({ data: [row(2, currentEvent({ event_id: 2, status: "PLANNING" }))], error: null })
    );
    await expect(findAttendeeRegistrations(21, { limit: 50, offset: 0 })).rejects.toThrow();
  });
});
