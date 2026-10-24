// Route, role and body-parsing contract for the T28 gallery. The model is
// mocked here; tests/integration/venuePhotos.integration.test.js covers the
// real database, Auth and MongoDB path.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({
  listVenuePhotos: jest.fn(),
  getVenuePhotoImage: jest.fn(),
  addVenuePhoto: jest.fn(),
  updateVenuePhoto: jest.fn(),
  replaceVenuePhotoImage: jest.fn(),
  deleteVenuePhoto: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");

const PHOTO_ID = "65a1b2c3d4e5f60718293a4b";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const PHOTO = { photoId: PHOTO_ID, position: 0, caption: "Hall", contentType: "image/jpeg", size: JPEG.length, uploadedAt: "2026-10-21T01:00:00.000Z", updatedAt: null, version: 1 };
const venueError = (code) => Object.assign(new Error(code), { name: "VenueError", code });

const as = (role) => userModel.findUserByAuthId.mockResolvedValue({ user_id: 7, role, organisation_ids: [] });
const authed = (call) => call.set("Authorization", "Bearer token");
const upload = (path, body = JPEG, type = "image/jpeg") => authed(request(app).post(path)).set("Content-Type", type).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  userModel.verifyAccessToken.mockResolvedValue("auth-user");
  as("VENUE_STAFF");
  venueModel.listVenuePhotos.mockResolvedValue({ photos: [PHOTO] });
  venueModel.getVenuePhotoImage.mockResolvedValue({ contentType: "image/jpeg", data: JPEG });
  venueModel.addVenuePhoto.mockResolvedValue(PHOTO);
  venueModel.updateVenuePhoto.mockResolvedValue({ ...PHOTO, caption: "Stage", version: 2 });
  venueModel.replaceVenuePhotoImage.mockResolvedValue({ ...PHOTO, version: 2 });
  venueModel.deleteVenuePhoto.mockResolvedValue(PHOTO);
});

describe("venue photo roles (T28)", () => {
  test("[TC-VENUE-181-115] should_return_403_for_every_gallery_route_when_the_user_is_not_venue_staff", async () => {
    for (const role of ["COORDINATOR", "COORDINATOR_LEAD", "ORGANISER", "ATTENDEE", "TECH_SUPPORT"]) {
      as(role);
      const responses = await Promise.all([
        authed(request(app).get("/api/venues/3/photos")),
        authed(request(app).get(`/api/venues/3/photos/${PHOTO_ID}`)),
        upload("/api/venues/3/photos"),
        authed(request(app).put(`/api/venues/3/photos/${PHOTO_ID}`)).send({ caption: "x" }),
        authed(request(app).put(`/api/venues/3/photos/${PHOTO_ID}/image`)).set("Content-Type", "image/jpeg").send(JPEG),
        authed(request(app).delete(`/api/venues/3/photos/${PHOTO_ID}`)),
      ]);
      expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    }
    expect(Object.values(venueModel).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  test("[TC-VENUE-181-116] should_return_401_when_no_token_is_sent", async () => {
    expect((await request(app).get("/api/venues/3/photos")).status).toBe(401);
    expect((await request(app).post("/api/venues/3/photos").set("Content-Type", "image/jpeg").send(JPEG)).status).toBe(401);
  });
});

describe("GET /api/venues/:venueId/photos (T28)", () => {
  test("[TC-VENUE-181-117] should_list_the_gallery_when_the_venue_exists", async () => {
    const response = await authed(request(app).get("/api/venues/3/photos"));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ photos: [PHOTO] });
    expect(venueModel.listVenuePhotos).toHaveBeenCalledWith(3);
  });

  test("[TC-VENUE-181-118] should_return_404_when_the_venue_id_cannot_exist_or_the_venue_is_deleted", async () => {
    expect((await authed(request(app).get("/api/venues/abc/photos"))).body.code).toBe("VENUE_NOT_FOUND");
    venueModel.listVenuePhotos.mockRejectedValueOnce(venueError("VENUE_NOT_FOUND"));
    expect((await authed(request(app).get("/api/venues/3/photos"))).status).toBe(404);
  });

  test("[TC-VENUE-181-119] should_return_503_when_mongodb_is_unavailable", async () => {
    venueModel.listVenuePhotos.mockRejectedValueOnce(venueError("VENUE_PHOTOS_UNAVAILABLE"));

    const response = await authed(request(app).get("/api/venues/3/photos"));

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("VENUE_PHOTOS_UNAVAILABLE");
  });
});

describe("GET /api/venues/:venueId/photos/:photoId (T28)", () => {
  test("[TC-VENUE-181-120] should_send_the_image_bytes_with_nosniff_when_the_photo_exists", async () => {
    const response = await authed(request(app).get(`/api/venues/3/photos/${PHOTO_ID}`));

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(response.body).equals(JPEG)).toBe(true);
    expect(venueModel.getVenuePhotoImage).toHaveBeenCalledWith(3, PHOTO_ID);
  });

  test("[TC-VENUE-181-121] should_return_404_when_the_photo_id_is_malformed_or_unknown", async () => {
    const malformed = await authed(request(app).get("/api/venues/3/photos/not-an-id"));
    expect(malformed.status).toBe(404);
    expect(malformed.body.code).toBe("PHOTO_NOT_FOUND");
    expect(venueModel.getVenuePhotoImage).not.toHaveBeenCalled();

    venueModel.getVenuePhotoImage.mockRejectedValueOnce(venueError("PHOTO_NOT_FOUND"));
    expect((await authed(request(app).get(`/api/venues/3/photos/${PHOTO_ID}`))).status).toBe(404);
  });
});

describe("POST /api/venues/:venueId/photos (T28)", () => {
  test("[TC-VENUE-181-122] should_store_the_raw_image_with_its_caption_and_return_201", async () => {
    const response = await upload("/api/venues/3/photos?caption=%20Main%20hall%20");

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ message: "Photo added.", photo: PHOTO });
    expect(venueModel.addVenuePhoto).toHaveBeenCalledWith(7, 3, {
      contentType: "image/jpeg",
      data: expect.any(Buffer),
      size: JPEG.length,
      caption: "Main hall",
    });
  });

  test("[TC-VENUE-181-123] should_return_415_when_the_request_is_not_an_image_type", async () => {
    for (const [body, type] of [[JSON.stringify({ image: "x" }), "application/json"], ["<svg/>", "image/svg+xml"], ["x", "text/plain"]]) {
      const response = await authed(request(app).post("/api/venues/3/photos")).set("Content-Type", type).send(body);
      expect(response.status).toBe(415);
      expect(response.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    expect(venueModel.addVenuePhoto).not.toHaveBeenCalled();
  });

  test("[TC-VENUE-181-124] should_return_415_when_the_bytes_are_not_an_image_despite_an_image_header", async () => {
    const response = await upload("/api/venues/3/photos", Buffer.from("<html><script>alert(1)</script></html>"));

    expect(response.status).toBe(415);
    expect(response.body.fields).toHaveProperty("image");
    expect(venueModel.addVenuePhoto).not.toHaveBeenCalled();
  });

  test("[TC-VENUE-181-125] should_return_413_when_the_image_is_over_2_mb", async () => {
    const response = await upload("/api/venues/3/photos", Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]));

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("PAYLOAD_TOO_LARGE");
    expect(venueModel.addVenuePhoto).not.toHaveBeenCalled();
  });

  test("[TC-VENUE-181-126] should_return_400_when_the_body_is_empty_or_the_caption_is_too_long", async () => {
    expect((await upload("/api/venues/3/photos", Buffer.alloc(0))).status).toBe(400);
    const long = await upload(`/api/venues/3/photos?caption=${"x".repeat(201)}`);
    expect(long.status).toBe(400);
    expect(long.body.fields).toHaveProperty("caption");
    expect(venueModel.addVenuePhoto).not.toHaveBeenCalled();
  });

  test("[TC-VENUE-181-127] should_return_409_when_the_gallery_is_full", async () => {
    venueModel.addVenuePhoto.mockRejectedValueOnce(venueError("PHOTO_LIMIT_REACHED"));

    const response = await upload("/api/venues/3/photos");

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("PHOTO_LIMIT_REACHED");
  });
});

describe("PUT and DELETE /api/venues/:venueId/photos/:photoId (T28)", () => {
  test("[TC-VENUE-181-128] should_update_caption_and_position_when_the_edit_is_valid", async () => {
    const response = await authed(request(app).put(`/api/venues/3/photos/${PHOTO_ID}`)).send({ caption: "Stage", position: 0 });

    expect(response.status).toBe(200);
    expect(response.body.photo).toMatchObject({ caption: "Stage", version: 2 });
    expect(venueModel.updateVenuePhoto).toHaveBeenCalledWith(7, 3, PHOTO_ID, { caption: "Stage", position: 0 });
  });

  test("[TC-VENUE-181-129] should_return_400_when_the_edit_has_unknown_fields_or_a_bad_position", async () => {
    const response = await authed(request(app).put(`/api/venues/3/photos/${PHOTO_ID}`)).send({ position: 25, data: "x" });

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.fields).sort()).toEqual(["data", "position"]);
    expect(venueModel.updateVenuePhoto).not.toHaveBeenCalled();
  });

  test("[TC-VENUE-181-130] should_replace_the_image_and_ignore_a_caption_query", async () => {
    const response = await authed(request(app).put(`/api/venues/3/photos/${PHOTO_ID}/image?caption=ignored`))
      .set("Content-Type", "image/jpeg")
      .send(JPEG);

    expect(response.status).toBe(200);
    expect(venueModel.replaceVenuePhotoImage).toHaveBeenCalledWith(7, 3, PHOTO_ID, expect.objectContaining({ contentType: "image/jpeg", caption: null }));
  });

  test("[TC-VENUE-181-131] should_delete_the_photo_and_return_404_when_it_is_already_gone", async () => {
    const response = await authed(request(app).delete(`/api/venues/3/photos/${PHOTO_ID}`));
    expect(response.status).toBe(200);
    expect(venueModel.deleteVenuePhoto).toHaveBeenCalledWith(7, 3, PHOTO_ID);

    venueModel.deleteVenuePhoto.mockRejectedValueOnce(venueError("PHOTO_NOT_FOUND"));
    expect((await authed(request(app).delete(`/api/venues/3/photos/${PHOTO_ID}`))).status).toBe(404);
  });
});
