-- SPM-163 / SPM-147: notices an attendee keeps after their place ends.
--   * WAITLIST_LEFT: they left the waitlist, declined an offer or let it expire.
--   * REGISTRATION_WITHDRAWN: they withdrew a registration.
-- _notification_visible hides attendee notices once the registration is no
-- longer REGISTERED or WAITLISTED, so these two get their own types and stay
-- visible (as SPM-193 did with ASSIGNMENT_ENDED).
--
-- Added on its own because a new enum value cannot be used in the transaction
-- that adds it; the functions that use them follow in later migrations.
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'WAITLIST_LEFT';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'REGISTRATION_WITHDRAWN';
