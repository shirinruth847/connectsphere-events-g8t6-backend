-- SPM-32 review: event_document is outside the baseline (Master 6.2) and no
-- backend code uses it, so the runtime role should not hold DML on it.
revoke select, insert, update, delete on table public.event_document from service_role;
