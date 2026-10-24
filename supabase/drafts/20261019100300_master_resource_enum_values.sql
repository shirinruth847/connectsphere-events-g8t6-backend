-- DRAFT FOR AGREEMENT - do not apply until the SPM-179 (venue booking request)
-- and SPM-186 (venue booking approval) owners agree; see the companion
-- migration 20261019100400_master_resource_tables.sql.
--
-- Master v1.2 section 5.4: venue booking states are PENDING, APPROVED, REJECTED,
-- RELEASED and CANCELLED. Tentative holds are MongoDB venue_calendar documents,
-- not bookings (T27), so there is no HELD or EXPIRED booking state. The live
-- booking_status enum lacks RELEASED. Added in its own migration, because a new
-- enum value cannot be used in the transaction that adds it.

ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'RELEASED' AFTER 'REJECTED';
