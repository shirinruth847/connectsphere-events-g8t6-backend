-- SPM-41: clarification rounds (Master sections 5.2 and 6.2, "clarifications").
--
-- A round is one question from the assigned coordinator and, once the organiser
-- resubmits, the organiser's answer. Every round is kept (Master 5.2: "Clarification
-- preserves all question/response rounds"), so an event can be returned several
-- times and each question stays visible after the event goes back under review.
--
-- This migration only adds the table and its read access. The rows are written by
-- the request-clarification and resubmit database functions, which are added with
-- the SPM-173 lifecycle engine; the backend runtime never writes to this table
-- directly. The full question text is also recorded in activity_log by those
-- functions, which is the append-only audit trail (SPM-41 AC5).

CREATE TABLE public.clarifications (
  clarification_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Rounds stay with the event (Master 4.2: event-linked records survive
  -- reassignment) and block its deletion, like the rest of its history.
  event_id integer NOT NULL
    CONSTRAINT clarifications_event_id_fkey REFERENCES public.event (event_id) ON DELETE RESTRICT,
  round_number integer NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  message text NOT NULL,
  -- Named: the backend joins each person by constraint name (eventModel.js).
  requested_by integer NOT NULL
    CONSTRAINT clarifications_requested_by_fkey REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- Optional: an organiser may answer with amendments alone (team decision,
  -- 2026-10-20). responded_by/responded_at record who resubmitted and when.
  response text,
  responded_by integer
    CONSTRAINT clarifications_responded_by_fkey REFERENCES public."user" (user_id) ON DELETE RESTRICT,
  responded_at timestamptz,
  CONSTRAINT clarifications_event_round_key UNIQUE (event_id, round_number),
  CONSTRAINT clarifications_round_number_check CHECK (round_number > 0),
  -- Master 6.1: lifecycle values are text with a check constraint, not an enum.
  CONSTRAINT clarifications_status_check CHECK (status IN ('OPEN', 'RESPONDED')),
  -- Required, at most 2,000 characters, no minimum (team decision, 2026-10-20).
  CONSTRAINT clarifications_message_check CHECK (btrim(message) <> '' AND char_length(message) <= 2000),
  CONSTRAINT clarifications_response_check CHECK (
    response IS NULL OR (btrim(response) <> '' AND char_length(response) <= 2000)
  ),
  CONSTRAINT clarifications_response_state_check CHECK (
    (status = 'OPEN' AND response IS NULL AND responded_by IS NULL AND responded_at IS NULL)
    OR (status = 'RESPONDED' AND responded_by IS NOT NULL AND responded_at IS NOT NULL)
  ),
  CONSTRAINT clarifications_response_time_check CHECK (responded_at IS NULL OR responded_at >= requested_at)
);

-- An event has at most one unanswered question at a time.
CREATE UNIQUE INDEX clarifications_one_open_per_event
  ON public.clarifications (event_id)
  WHERE status = 'OPEN';

-- A round's question never changes, and an answered round is never reopened or
-- answered again. Enforced here so a later function cannot rewrite a question.
CREATE FUNCTION public._clarifications_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.round_number IS DISTINCT FROM OLD.round_number
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR OLD.status = 'RESPONDED' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CLARIFICATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER clarifications_guard_update
  BEFORE UPDATE ON public.clarifications
  FOR EACH ROW EXECUTE FUNCTION public._clarifications_guard_update();

COMMENT ON TABLE public.clarifications IS
  'SPM-41 clarification rounds: coordinator question and organiser response per round. Written only by the clarification lifecycle functions.';

-- Browser roles never reach this table (Master 4.3). The backend reads it; writes
-- go through SECURITY DEFINER functions owned by the migration role.
ALTER TABLE public.clarifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.clarifications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.clarifications TO service_role;
REVOKE ALL ON FUNCTION public._clarifications_guard_update() FROM PUBLIC, anon, authenticated, service_role;
