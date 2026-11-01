-- SPM-190 (developer decision of 1 November 2026, Master 5.4.3): a booking
-- request is the venue hold. While PENDING it occupies the venue (setup and
-- turnaround included) until Venue Staff decide or its hold expires; an
-- expired request becomes EXPIRED and frees the venue (Week 7 change 4).
--
-- Additive only. The new enum value is committed by this migration before the
-- next one uses it (PostgreSQL cannot use a new enum value in the transaction
-- that adds it).

ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TABLE public.venue_booking
  ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS hold_reminded_at timestamptz;

COMMENT ON COLUMN public.venue_booking.hold_expires_at IS
  'While PENDING: when the request''s hold on the venue expires if Venue Staff have not decided. Cleared on approval.';
COMMENT ON COLUMN public.venue_booking.hold_reminded_at IS
  'When the 24-hour reminder for this pending request was sent.';

-- The expiry job looks up pending requests by their hold expiry.
CREATE INDEX IF NOT EXISTS venue_booking_pending_hold_expiry_idx
  ON public.venue_booking (hold_expires_at)
  WHERE hold_expires_at IS NOT NULL;
