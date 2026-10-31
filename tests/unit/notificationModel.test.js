// SPM-156 notification model: RPC arguments, response mapping and cursors.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));

const supabase = require("../../config/supabase");
const notificationModel = require("../../model/notificationModel");

const row = (overrides = {}) => ({
  notification_id: 40,
  type: "WAITLIST_OFFER",
  title: "Action required: a place is available",
  message: "A place is available for \"Forum\".",
  created_at: "2026-10-20T06:00:00.123456+00:00",
  is_read: false,
  read_at: null,
  action_expires_at: "2026-10-22T06:00:00+00:00",
  event_id: 8,
  event_title: "Forum",
  ...overrides,
});

const attendee = { user_id: 3, role: "ATTENDEE" };

beforeEach(() => jest.clearAllMocks());

describe("findNotifications", () => {
  test("[SPM-155-AC4/AC5] maps each row to the reader's own copy with a Go to Event target", async () => {
    supabase.rpc.mockResolvedValue({ data: [row()], error: null });
    const { notifications, nextCursor } = await notificationModel.findNotifications(attendee, { limit: 20, cursor: null });
    expect(supabase.rpc).toHaveBeenCalledWith("list_notifications", {
      p_user_id: 3, p_limit: 21, p_before_created_at: null, p_before_id: null,
    });
    expect(nextCursor).toBeNull();
    expect(notifications).toEqual([{
      notification_id: 40,
      type: "WAITLIST_OFFER",
      title: "Action required: a place is available",
      message: "A place is available for \"Forum\".",
      created_at: "2026-10-20T06:00:00.123456+00:00",
      is_read: false,
      read_at: null,
      action_expires_at: "2026-10-22T06:00:00+00:00",
      event: { event_id: 8, title: "Forum" },
      target: { page: "MY_EVENTS", event_id: 8 },
    }]);
  });

  test("[SPM-156] staff and organisers are sent to the event workspace; no event means no target", () => {
    expect(notificationModel.toNotificationItem(row(), "ORGANISER").target).toEqual({ page: "EVENT_WORKSPACE", event_id: 8 });
    const detached = notificationModel.toNotificationItem(row({ event_id: null, event_title: null }), "COORDINATOR");
    expect(detached.event).toBeNull();
    expect(detached.target).toBeNull();
  });

  test("[SPM-193-TC-11][TC-12] a coordinator's notice, including 'assignment ended', opens the event workspace", () => {
    const ended = notificationModel.toNotificationItem(row({ type: "ASSIGNMENT_ENDED" }), "COORDINATOR");
    expect(ended.type).toBe("ASSIGNMENT_ENDED");
    expect(ended.target).toEqual({ page: "EVENT_WORKSPACE", event_id: 8 });
  });

  test("[SPM-286-TC-06] a Technical Support notice opens their technical requests dashboard", () => {
    const sent = notificationModel.toNotificationItem(row({ type: "EQUIPMENT_UPDATE" }), "TECH_SUPPORT");
    expect(sent.target).toEqual({ page: "TECHNICAL_REQUESTS", event_id: 8 });
  });

  test("[SPM-286] a Venue Staff booking request notice opens that booking; other notices their booking requests", async () => {
    supabase.rpc.mockResolvedValue({ data: [row({ notification_id: 41 }), row({ notification_id: 42 })], error: null });
    const keys = [
      { notification_id: 41, action_key: "VENUE_BOOKINGS_REQUESTED:8:7895" },
      { notification_id: 42, action_key: "HOLD_REQUESTED:232" },
    ];
    const query = { select: jest.fn().mockReturnThis(), in: jest.fn().mockResolvedValue({ data: keys, error: null }) };
    supabase.from.mockReturnValue(query);

    const { notifications } = await notificationModel.findNotifications({ user_id: 5, role: "VENUE_STAFF" }, { limit: 20 });

    expect(query.in).toHaveBeenCalledWith("notification_id", [41, 42]);
    expect(notifications.map((item) => item.target)).toEqual([
      { page: "VENUE_BOOKING_REQUESTS", event_id: 8, booking_id: 7895 },
      { page: "VENUE_BOOKING_REQUESTS", event_id: 8 },
    ]);
  });

  test("[SPM-155-AC8] returns a cursor for the next page that keeps microseconds", async () => {
    supabase.rpc.mockResolvedValue({
      data: [row({ notification_id: 3 }), row({ notification_id: 2 }), row({ notification_id: 1 })],
      error: null,
    });
    const { notifications, nextCursor } = await notificationModel.findNotifications(attendee, { limit: 2 });
    expect(notifications.map((item) => item.notification_id)).toEqual([3, 2]);
    expect(notificationModel.decodeCursor(nextCursor)).toEqual({
      createdAt: "2026-10-20T06:00:00.123456+00:00",
      notificationId: 2,
    });

    supabase.rpc.mockResolvedValue({ data: [], error: null });
    await notificationModel.findNotifications(attendee, { limit: 2, cursor: nextCursor });
    expect(supabase.rpc).toHaveBeenLastCalledWith("list_notifications", {
      p_user_id: 3, p_limit: 3, p_before_created_at: "2026-10-20T06:00:00.123456+00:00", p_before_id: 2,
    });
  });

  test.each([
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ createdAt: "2026-02-31T00:00:00Z", notificationId: 1 })).toString("base64url"),
    Buffer.from(JSON.stringify({ createdAt: "2026-10-20T06:00:00Z", notificationId: 0 })).toString("base64url"),
    Buffer.from(JSON.stringify({ createdAt: "2026-10-20T06:00:00Z" })).toString("base64url"),
  ])("[SPM-156-VAL] rejects cursor %s before calling the database", async (cursor) => {
    await expect(notificationModel.findNotifications(attendee, { limit: 2, cursor })).rejects.toMatchObject({
      name: "NotificationError",
      code: "INVALID_CURSOR",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("[SPM-156-ERR] database errors are thrown, not returned", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(notificationModel.findNotifications(attendee, { limit: 2 })).rejects.toThrow("[Supabase Error] boom");
  });
});

describe("read state and reminders", () => {
  test("[SPM-155-TC-08] passes the trusted user ID to each RPC", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: 4, error: null });
    expect(await notificationModel.countUnreadNotifications(3)).toBe(4);
    expect(supabase.rpc).toHaveBeenLastCalledWith("count_unread_notifications", { p_user_id: 3 });

    const marked = { notification_id: 40, is_read: true, read_at: "2026-10-20T07:00:00+00:00" };
    supabase.rpc.mockResolvedValueOnce({ data: [marked], error: null });
    expect(await notificationModel.markNotificationRead(3, 40)).toEqual(marked);
    expect(supabase.rpc).toHaveBeenLastCalledWith("mark_notification_read", { p_user_id: 3, p_notification_id: 40 });

    supabase.rpc.mockResolvedValueOnce({ data: [], error: null });
    expect(await notificationModel.markNotificationRead(3, 41)).toBeNull();

    supabase.rpc.mockResolvedValueOnce({ data: 2, error: null });
    expect(await notificationModel.markAllNotificationsRead(3)).toBe(2);
    expect(supabase.rpc).toHaveBeenLastCalledWith("mark_all_notifications_read", { p_user_id: 3 });
  });

  test("[SPM-158] sends one bounded reminder batch", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: 5, error: null });
    expect(await notificationModel.sendDueEventReminders(50)).toBe(5);
    expect(supabase.rpc).toHaveBeenLastCalledWith("send_due_event_reminders", { p_limit: 50 });
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await expect(notificationModel.sendDueEventReminders(50)).rejects.toThrow("[Supabase Error] down");
  });
});
