-- DRAFT FOR AGREEMENT - do not apply until the SPM-179 (venue booking request)
-- and SPM-186 (venue booking approval) owners agree; see the companion
-- migration 20261019100400_master_resource_tables.sql.
--
-- Master v1.1 section 5.4: venue booking states are HELD, PENDING, APPROVED,
-- REJECTED, EXPIRED, RELEASED and CANCELLED. The live booking_status enum has
-- only PENDING, APPROVED, REJECTED and CANCELLED. Added in their own migration,
-- because the companion migration uses them in index predicates.

ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'HELD' BEFORE 'PENDING';
ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'EXPIRED' AFTER 'REJECTED';
ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'RELEASED' AFTER 'EXPIRED';
