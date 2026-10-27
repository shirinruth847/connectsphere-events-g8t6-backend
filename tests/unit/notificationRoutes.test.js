// Route-level unit tests for SPM-156: real Express app, routes, middleware and
// controller. Only the model functions that reach Supabase are mocked. The
// routes serve attendees (SPM-155) and organisers (SPM-192); staff wait for SPM-193.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/notificationModel", () => {
  const actual = jest.requireActual("../../model/notificationModel");
  return {
    ...actual,
    findNotifications: jest.fn(),
    countUnreadNotifications: jest.fn(),
    markNotificationRead: jest.fn(),
    markAllNotificationsRead: jest.fn(),
  };
});

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const notificationModel = require("../../model/notificationModel");

const USER_ID = 21;

const signedInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: USER_ID, role, organisation_ids: [] });
};

const send = (method, path) => request(app)[method](path).set("Authorization", "Bearer token");

const cursorError = () => Object.assign(new Error("INVALID_CURSOR"), { name: "NotificationError", code: "INVALID_CURSOR" });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs("ATTENDEE");
  notificationModel.countUnreadNotifications.mockResolvedValue(3);
});

describe("authentication (SPM-155 TC-12)", () => {
  test.each([
    ["get", "/api/notifications"],
    ["get", "/api/notifications/unread-count"],
    ["post", "/api/notifications/read-all"],
    ["post", "/api/notifications/7/read"],
  ])("[SPM-156-AUTH] %s %s without a token is 401 and reads nothing", async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(notificationModel.findNotifications).not.toHaveBeenCalled();
    expect(notificationModel.markNotificationRead).not.toHaveBeenCalled();
    expect(notificationModel.markAllNotificationsRead).not.toHaveBeenCalled();
  });
});

describe("role restriction (attendees, organisers and coordinators)", () => {
  test.each(
    [
      ["SPM-192-AC9", "ORGANISER"],
      ["SPM-193-AC11", "COORDINATOR"],
    ].flatMap(([key, role]) => [
      [key, role, "get", "/api/notifications"],
      [key, role, "get", "/api/notifications/unread-count"],
      [key, role, "post", "/api/notifications/read-all"],
      [key, role, "post", "/api/notifications/7/read"],
    ])
  )("[%s] %s: %s %s reaches their own inbox", async (key, role, method, path) => {
    signedInAs(role);
    notificationModel.findNotifications.mockResolvedValue({ notifications: [], nextCursor: null });
    notificationModel.markNotificationRead.mockResolvedValue({ notification_id: 7, is_read: true, read_at: null });
    notificationModel.markAllNotificationsRead.mockResolvedValue(0);
    const res = await send(method, path);
    expect(res.status).toBe(200);
    expect(notificationModel.countUnreadNotifications).toHaveBeenCalledWith(USER_ID);
  });

  test("[SPM-192-AC8] the organiser's list is read with their own user and role", async () => {
    signedInAs("ORGANISER");
    notificationModel.findNotifications.mockResolvedValue({ notifications: [], nextCursor: null });
    await send("get", "/api/notifications");
    expect(notificationModel.findNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER_ID, role: "ORGANISER" }),
      expect.any(Object)
    );
  });

  test("[SPM-193-AC10] the coordinator's list is read with their own user and role", async () => {
    signedInAs("COORDINATOR");
    notificationModel.findNotifications.mockResolvedValue({ notifications: [], nextCursor: null });
    await send("get", "/api/notifications");
    expect(notificationModel.findNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER_ID, role: "COORDINATOR" }),
      expect.any(Object)
    );
  });

  test.each(
    ["COORDINATOR_LEAD", "VENUE_STAFF", "TECH_SUPPORT", "SAFETY_OFFICER"].flatMap((role) => [
      [role, "get", "/api/notifications"],
      [role, "get", "/api/notifications/unread-count"],
      [role, "post", "/api/notifications/read-all"],
      [role, "post", "/api/notifications/7/read"],
    ])
  )("[SPM-155] %s: %s %s is 403 and reads nothing", async (role, method, path) => {
    signedInAs(role);
    const res = await send(method, path);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(notificationModel.findNotifications).not.toHaveBeenCalled();
    expect(notificationModel.countUnreadNotifications).not.toHaveBeenCalled();
    expect(notificationModel.markNotificationRead).not.toHaveBeenCalled();
    expect(notificationModel.markAllNotificationsRead).not.toHaveBeenCalled();
  });
});

describe("GET /api/notifications", () => {
  test("[SPM-155-AC8] returns the page, next cursor and unread count for the signed-in user only", async () => {
    const notifications = [{ notification_id: 9, title: "Registration confirmed" }];
    notificationModel.findNotifications.mockResolvedValue({ notifications, nextCursor: "abc" });
    const res = await send("get", "/api/notifications?limit=10&cursor=abc");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notifications, nextCursor: "abc", unreadCount: 3 });
    expect(notificationModel.findNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: USER_ID, role: "ATTENDEE" }),
      { limit: 10, cursor: "abc" }
    );
    expect(notificationModel.countUnreadNotifications).toHaveBeenCalledWith(USER_ID);
  });

  test.each([
    ["limit=0", "limit"],
    ["limit=101", "limit"],
    ["offset=20", "offset"],
    ["cursor=%24bad", "cursor"],
  ])("[SPM-156-VAL] ?%s is rejected as a field error", async (query, field) => {
    const res = await send("get", `/api/notifications?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.fields).toHaveProperty(field);
    expect(notificationModel.findNotifications).not.toHaveBeenCalled();
  });

  test("[SPM-156-VAL] a cursor the model cannot decode is a field error", async () => {
    notificationModel.findNotifications.mockRejectedValue(cursorError());
    const res = await send("get", "/api/notifications?cursor=abc");
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ cursor: "Invalid page cursor." });
  });

  test("[SPM-156-ERR] a database failure is a safe 500", async () => {
    notificationModel.findNotifications.mockRejectedValue(new Error("[Supabase Error] connection reset"));
    const res = await send("get", "/api/notifications");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("GET /api/notifications/unread-count", () => {
  test("[SPM-155-AC8] returns the unread count", async () => {
    const res = await send("get", "/api/notifications/unread-count");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 3 });
  });
});

describe("POST /api/notifications/:id/read", () => {
  test("[SPM-155-TC-08] marks one read and returns the new count", async () => {
    const notification = { notification_id: 7, is_read: true, read_at: "2026-10-20T06:00:00.000001+00:00" };
    notificationModel.markNotificationRead.mockResolvedValue(notification);
    notificationModel.countUnreadNotifications.mockResolvedValue(2);
    const res = await send("post", "/api/notifications/7/read");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notification, unreadCount: 2 });
    expect(notificationModel.markNotificationRead).toHaveBeenCalledWith(USER_ID, 7);
  });

  test("[SPM-155-TC-07] someone else's or a hidden notification is not found", async () => {
    notificationModel.markNotificationRead.mockResolvedValue(null);
    const res = await send("post", "/api/notifications/7/read");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Notification not found.", code: "NOTIFICATION_NOT_FOUND" });
  });

  test.each(["0", "abc", "1.5", "99999999999"])("[SPM-156-VAL] ID %s is not found without a database call", async (id) => {
    const res = await send("post", `/api/notifications/${id}/read`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOTIFICATION_NOT_FOUND");
    expect(notificationModel.markNotificationRead).not.toHaveBeenCalled();
  });
});

describe("POST /api/notifications/read-all", () => {
  test("[SPM-155-TC-08] marks everything read and returns the new count", async () => {
    notificationModel.markAllNotificationsRead.mockResolvedValue(3);
    notificationModel.countUnreadNotifications.mockResolvedValue(0);
    const res = await send("post", "/api/notifications/read-all");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3, unreadCount: 0 });
    expect(notificationModel.markAllNotificationsRead).toHaveBeenCalledWith(USER_ID);
    expect(notificationModel.markNotificationRead).not.toHaveBeenCalled();
  });
});
