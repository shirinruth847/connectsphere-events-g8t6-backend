-- SPM-155: attendee notification types (AC1-AC3, AC5, AC7).
--
-- Added on their own because a new enum value cannot be used in the
-- transaction that adds it; the functions that use them follow in later
-- migrations. Existing values and rows are unchanged.
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'REGISTRATION_CONFIRMED';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'WAITLIST_JOINED';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'WAITLIST_OFFER';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'EVENT_CANCELLED';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'EVENT_CHANGED';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'EVENT_REMINDER';
