-- SPM-72 review fix (2026-10-19): venues carry an active state (Master
-- sections 6.2 and 6.5), so the Venue Catalogue can leave out venues that were
-- deleted as unusable (AC4, TC-VC-003) without hard-deleting rows that bookings
-- and event venue preferences still reference (section 6.1: restrict deletion
-- of referenced records). Deleting a venue (SPM-210/213) sets is_active = false.
-- Existing venues stay available.

ALTER TABLE public.venue
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.venue.is_active IS
  'false once the venue is deleted as unusable or not yet ready; inactive venues are not offered in the catalogue.';
