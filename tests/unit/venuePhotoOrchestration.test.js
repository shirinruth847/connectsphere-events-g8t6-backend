// venueModel's gallery orchestration (T28): the PostgreSQL venue check comes
// first, MongoDB failures become VENUE_PHOTOS_UNAVAILABLE, every change is
// audited as STAFF_ONLY, and My Venues rows carry the cover photo ID.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn().mockResolvedValue(new Map()), EDITABLE_DETAIL_FIELDS: [] }));
jest.mock("../../model/venuePhotoModel");
jest.mock("../../model/activityModel", () => ({ appendActivity: jest.fn() }));

const supabase = require("../../config/supabase");
const venuePhotoModel = require("../../model/venuePhotoModel");
const activityModel = require("../../model/activityModel");
const venueModel = require("../../model/venueModel");

const PHOTO_ID = "65a1b2c3d4e5f60718293a4b";
const PHOTO = { photoId: PHOTO_ID, position: 0, caption: "Hall", version: 1 };
const UPLOAD = { contentType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]), size: 3, caption: "Hall" };

const venueRow = (id, name = `Venue ${id}`) => ({
  venue_id: id, name, address: "1 Road", max_capacity: 100, status: "ACTIVE", status_reason: null,
  contact_person: null, contact_email: null, contact_number: null, version: 1,
  created_at: "2026-10-21T00:00:00Z", updated_at: "2026-10-21T00:00:00Z", created_by: null, updated_by: null,
});

// Chainable supabase-js stand-in that resolves to `result` however it is awaited.
const query = (result) => {
  const chain = { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["select", "eq", "in", "ilike", "order", "range"]) chain[method] = jest.fn(() => chain);
  chain.maybeSingle = jest.fn().mockResolvedValue(result);
  return chain;
};
const venueExists = (exists = true) => supabase.from.mockReturnValue(query({ data: exists ? venueRow(3) : null, error: null }));
const mongoDown = () => Object.assign(new Error("connect ECONNREFUSED"), { name: "MongoServerSelectionError", code: "ECONNREFUSED" });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  venueExists();
  activityModel.appendActivity.mockResolvedValue(undefined);
});

describe("gallery orchestration (T28)", () => {
  test("[TC-VENUE-181-132] should_refuse_every_gallery_call_when_the_venue_is_deleted_or_missing", async () => {
    venueExists(false);

    for (const call of [
      () => venueModel.listVenuePhotos(3),
      () => venueModel.getVenuePhotoImage(3, PHOTO_ID),
      () => venueModel.addVenuePhoto(7, 3, UPLOAD),
      () => venueModel.updateVenuePhoto(7, 3, PHOTO_ID, { caption: "x" }),
      () => venueModel.replaceVenuePhotoImage(7, 3, PHOTO_ID, UPLOAD),
      () => venueModel.deleteVenuePhoto(7, 3, PHOTO_ID),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "VENUE_NOT_FOUND" });
    }
    expect(Object.values(venuePhotoModel).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(activityModel.appendActivity).not.toHaveBeenCalled();
  });

  test("[TC-VENUE-181-133] should_add_the_photo_and_audit_it_as_staff_only_when_the_venue_exists", async () => {
    venuePhotoModel.addPhoto.mockResolvedValue(PHOTO);

    await expect(venueModel.addVenuePhoto(7, 3, UPLOAD)).resolves.toEqual(PHOTO);

    expect(venuePhotoModel.addPhoto).toHaveBeenCalledWith({ venueId: 3, ...UPLOAD, actorId: 7 });
    expect(activityModel.appendActivity).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7, entityName: "venue", entityId: 3, action: "VENUE_PHOTO_ADDED", audience: "STAFF_ONLY",
    }));
  });

  test("[TC-VENUE-181-134] should_audit_each_change_with_its_own_action", async () => {
    venuePhotoModel.updatePhoto.mockResolvedValue(PHOTO);
    venuePhotoModel.replacePhotoImage.mockResolvedValue(PHOTO);
    venuePhotoModel.deletePhoto.mockResolvedValue(PHOTO);

    await venueModel.updateVenuePhoto(7, 3, PHOTO_ID, { position: 0, caption: "Stage" });
    await venueModel.replaceVenuePhotoImage(7, 3, PHOTO_ID, UPLOAD);
    await venueModel.deleteVenuePhoto(7, 3, PHOTO_ID);

    expect(activityModel.appendActivity.mock.calls.map(([entry]) => entry.action)).toEqual([
      "VENUE_PHOTO_UPDATED", "VENUE_PHOTO_REPLACED", "VENUE_PHOTO_DELETED",
    ]);
    expect(activityModel.appendActivity.mock.calls[0][0].details).toBe("Venue photo updated: caption, position");
    // A replacement keeps the caption, so none is passed on.
    expect(venuePhotoModel.replacePhotoImage.mock.calls[0][0]).not.toHaveProperty("caption");
  });

  test("[TC-VENUE-181-135] should_map_mongodb_failures_to_unavailable_and_keep_photo_errors_as_they_are", async () => {
    venuePhotoModel.listPhotos.mockRejectedValue(mongoDown());
    await expect(venueModel.listVenuePhotos(3)).rejects.toMatchObject({ code: "VENUE_PHOTOS_UNAVAILABLE" });

    venuePhotoModel.addPhoto.mockRejectedValue(Object.assign(new Error("PHOTO_LIMIT_REACHED"), { name: "VenueError", code: "PHOTO_LIMIT_REACHED" }));
    await expect(venueModel.addVenuePhoto(7, 3, UPLOAD)).rejects.toMatchObject({ code: "PHOTO_LIMIT_REACHED" });

    venuePhotoModel.getPhotoImage.mockResolvedValue(null);
    await expect(venueModel.getVenuePhotoImage(3, PHOTO_ID)).rejects.toMatchObject({ code: "PHOTO_NOT_FOUND" });
    expect(activityModel.appendActivity).not.toHaveBeenCalled();
  });

  test("[TC-VENUE-181-136] should_keep_the_mongodb_change_when_the_audit_append_fails", async () => {
    venuePhotoModel.deletePhoto.mockResolvedValue(PHOTO);
    activityModel.appendActivity.mockRejectedValue(Object.assign(new Error("insert failed"), { code: "57014" }));

    await expect(venueModel.deleteVenuePhoto(7, 3, PHOTO_ID)).resolves.toEqual(PHOTO);
    expect(console.error).toHaveBeenCalledWith("[venue-photos] audit entry not written", expect.objectContaining({ action: "VENUE_PHOTO_DELETED" }));
  });
});

describe("My Venues cover photo (T28)", () => {
  test("[TC-VENUE-181-137] should_add_the_cover_photo_id_to_each_row_and_null_when_there_is_none", async () => {
    supabase.from.mockReturnValue(query({ data: [venueRow(1, "Alpha"), venueRow(2, "Bravo")], error: null }));
    venuePhotoModel.findCoverPhotoIds.mockResolvedValue(new Map([["1", PHOTO_ID]]));

    const result = await venueModel.listManagedVenues({}, { limit: 10, offset: 0 });

    expect(venuePhotoModel.findCoverPhotoIds).toHaveBeenCalledWith([1, 2]);
    expect(result.venues.map((venue) => venue.coverPhotoId)).toEqual([PHOTO_ID, null]);
  });

  test("[TC-VENUE-181-138] should_still_list_venues_with_no_covers_when_mongodb_is_unavailable", async () => {
    supabase.from.mockReturnValue(query({ data: [venueRow(1, "Alpha")], error: null }));
    venuePhotoModel.findCoverPhotoIds.mockRejectedValue(mongoDown());

    const result = await venueModel.listManagedVenues({ sort: "setupMinutes" }, { limit: 10, offset: 0 });

    expect(result.venues).toHaveLength(1);
    expect(result.venues[0].coverPhotoId).toBeNull();
  });
});
