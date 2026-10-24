// The Unsplash development galleries (T28, SPM-181) must fit the venue_photos
// rules before anything is downloaded. No network or database here.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));

const { GALLERIES, FIXTURE } = require("../../mongodb/seed/venuePhotoSeed");
const { MAX_PHOTOS_PER_VENUE, MAX_CAPTION_LENGTH } = require("../../validators/venuePhotoValidator");

describe("venue photo seed data", () => {
  test("[TC-VENUE-181-160] should_give_every_seeded_venue_between_one_and_20_photos_within_the_caption_limit", () => {
    expect(Object.keys(GALLERIES).length).toBeGreaterThanOrEqual(10);
    for (const photos of Object.values(GALLERIES)) {
      expect(photos.length).toBeGreaterThanOrEqual(1);
      expect(photos.length).toBeLessThanOrEqual(MAX_PHOTOS_PER_VENUE);
      for (const [photoId, file, caption] of photos) {
        expect(photoId).toMatch(/^[A-Za-z0-9_-]{11}$/);
        expect(file).toMatch(/^photo-\d+-[0-9a-f]+$/);
        expect(caption.length).toBeGreaterThan(0);
        expect(caption.length).toBeLessThanOrEqual(MAX_CAPTION_LENGTH);
      }
    }
  });

  test("[TC-VENUE-181-161] should_use_each_unsplash_photo_once_and_tag_documents_for_cleanup", () => {
    const ids = Object.values(GALLERIES).flat().map(([photoId]) => photoId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(FIXTURE).toBe("spm181-unsplash");
  });
});
