-- SPM-244 (subtask of SPM-243), needed by SPM-173 AC9/AC10: safety review rounds
-- and the event's arrangement version (Master sections 5.2, 5.9, 6.2, 6.3).
--
-- event.arrangement_version counts changes to venue bookings, booking decisions,
-- blocking incidents, technical arrangements and expected attendance. A safety
-- approval is valid only for the version it reviewed. The stories that make those
-- changes increase it; this migration only adds the column.
--
-- One row per review round. Statuses are text with CHECK constraints, because
-- the vocabulary is local to this table. At most one OPEN round per event.
-- An APPROVED round keeps its status after the arrangements change; it stops
-- counting because its arrangement_version no longer matches the event's.
-- Rounds are never deleted.

ALTER TABLE public.event
  ADD COLUMN IF NOT EXISTS arrangement_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.event
  ADD CONSTRAINT event_arrangement_version_positive_check CHECK (arrangement_version > 0);

CREATE TABLE public.safety_reviews (
  review_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.event (event_id) ON DELETE RESTRICT,
  round_number integer NOT NULL CHECK (round_number > 0),
  arrangement_version integer NOT NULL CHECK (arrangement_version > 0),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'SUPERSEDED')),
  submitted_by integer NOT NULL REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  claimed_by integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  claimed_at timestamptz,
  -- One entry per factor, each with a result and a comment. The factor list and
  -- result values are validated by the decision function (SPM-249); the table
  -- only bounds the shape and size.
  checklist jsonb,
  organiser_comment text CHECK (char_length(organiser_comment) <= 2000),
  internal_notes text CHECK (char_length(internal_notes) <= 4000),
  requested_changes jsonb,
  decided_by integer REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  decided_at timestamptz,
  superseded_at timestamptz,
  UNIQUE (event_id, round_number),
  CONSTRAINT safety_reviews_claim_pair_check CHECK ((claimed_by IS NULL) = (claimed_at IS NULL)),
  CONSTRAINT safety_reviews_checklist_shape_check CHECK (
    checklist IS NULL OR (jsonb_typeof(checklist) = 'object' AND pg_column_size(checklist) <= 16384)
  ),
  CONSTRAINT safety_reviews_requested_changes_shape_check CHECK (
    requested_changes IS NULL OR (jsonb_typeof(requested_changes) = 'array' AND pg_column_size(requested_changes) <= 16384)
  ),
  CONSTRAINT safety_reviews_outcome_check CHECK (
    CASE status
      WHEN 'OPEN' THEN decided_at IS NULL AND decided_by IS NULL AND superseded_at IS NULL
      WHEN 'SUPERSEDED' THEN superseded_at IS NOT NULL AND decided_at IS NULL
      ELSE decided_at IS NOT NULL AND decided_by IS NOT NULL AND superseded_at IS NULL
    END
  )
);

-- Master section 6.3: at most one open safety review per event.
CREATE UNIQUE INDEX safety_reviews_one_open_per_event
  ON public.safety_reviews (event_id)
  WHERE status = 'OPEN';

-- The shared queue: open, unclaimed rounds, oldest submission first.
CREATE INDEX safety_reviews_open_queue
  ON public.safety_reviews (submitted_at, review_id)
  WHERE status = 'OPEN' AND claimed_by IS NULL;

CREATE INDEX safety_reviews_claimed_by
  ON public.safety_reviews (claimed_by)
  WHERE status = 'OPEN' AND claimed_by IS NOT NULL;

-- Venue bookings named in a REJECTED outcome, each with its reason.
CREATE TABLE public.safety_review_rejected_bookings (
  review_id bigint NOT NULL REFERENCES public.safety_reviews (review_id) ON DELETE RESTRICT,
  booking_id integer NOT NULL REFERENCES public.venue_booking (booking_id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  PRIMARY KEY (review_id, booking_id)
);

ALTER TABLE public.safety_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_review_rejected_bookings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.safety_reviews, public.safety_review_rejected_bookings
  FROM PUBLIC, anon, authenticated, service_role;
-- Rounds are history: the backend may read, add and update them, never delete.
GRANT SELECT, INSERT, UPDATE ON public.safety_reviews, public.safety_review_rejected_bookings TO service_role;
