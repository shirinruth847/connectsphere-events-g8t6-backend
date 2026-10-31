# SPM-40 — reject submitted event request

## Scope

Jira SPM-40 was read on 30 October 2026: rejection form; required reason of
at least ten characters; confirmation; rejected status; audit actor/time and
organiser notification containing the notes. Jira has no comments or linked PRs.
Both repositories use feature/SPM-40-reject-submitted-event-request from main.

This ticket implements rejection of UNDER_REVIEW requests only, matching the
provided scenarios. The broader Master lifecycle also allows rejection from
clarification/planning/safety review before confirmation; those operational
paths require coordinated resource release and are not exposed by this endpoint.
Previously confirmed, cancelled, rejected and completed events are refused.
An ordinary under-review request has no venue holds/bookings or technical
arrangements: the Master permits creating those only in PLANNING.

## Coordinated frontend/backend contract

`POST /api/events/:id/reject`, JSON `{ version, reason }`, required
`Idempotency-Key`. Actor comes from verified authentication and trusted roles.
Only the active assigned coordinator may mutate the event; unrelated events
answer 404, other roles 403, missing session 401. Body fields other than version
and reason are rejected. Trimmed notes require 10–2,000 Unicode characters;
blank notes use `Rejection notes are required`. NUL input is refused.

200 `{ message, event }` is returned only after the RPC commits. Replays have
`Idempotent-Replayed: true`. Stale versions and disallowed transitions return
409; stale versions include the latest event. Changed-body key reuse is refused.

`reject_submitted_event` locks the event, rechecks active role/assignment even
on replay, checks version/state and saves the REJECTED transition,
ORGANISER_SAFE EVENT_REJECTED activity with reason/actor/time and state change,
owner notification with notes, and replay result in one PostgreSQL transaction.
Failures roll everything back. Notes are stored as text, never HTML.

The frontend reuses the guarded coordinator event workspace, shared Dialog,
primitives and apiRequest/session handling. Unsaved details block the action.
Cancel sends no command. An ambiguous command persists notes/version/key in
sessionStorage scoped to the trusted user and event; explicit logout clears
existing recovery keys. Automatic expiry/reload can reuse the identical command.
No shared shell/auth/navigation/styles are changed. The new endpoint and both
consumers should receive coordinated frontend/backend contract review.

## Deployment / rollback

Migration `20261030022851_spm40_reject_submitted_event.sql` is recorded as 20261030022851;
it was applied to development project rvwiflsedoujspmzfrbq on 30 October 2026. Apply through the approved review
process before deploying the API, then the frontend. It requires existing
lifecycle, audit/version and idempotency helpers. It adds one service-role-only
SECURITY DEFINER function with fixed search_path and extends the existing
operation check without losing other tickets' operations. An exclusive lock on
idempotency_records is held during the constraint update.

An API rollback may leave the additive function/operation in place. Preserve
rejected state, activity, notifications and replay history; do not revert real
rejections as a deployment rollback.

## Verification

- Backend `npm test -- --runInBand`: 1,851 passed, 69 suites (synthetic service
  configuration; database dependencies mocked by route/model tests).
- `node --test tests/database/spm40Rejection.test.cjs`: 23 passed, including approval/rejection mutual exclusion. Actual SQL in
  isolated PGlite/reduced fixture; no hosted concurrency or permissions claim.
- Frontend `npm test`: 170 passed.
- Frontend `npm run lint`: passed with no errors or warnings.
- `npm run test:e2e -- tests/e2e/lifecycle.spec.mjs tests/e2e/spm-40.spec.mjs`: 45 passed, including
  production build/type checking, desktop/mobile screenshots, cancellation,
  note boundaries, terminal/owner denial, stale versions, expiry, pending
  duplicate prevention and uncertain-response replay after reload.
- SPM-39 approval and the existing lifecycle browser journeys pass alongside
  SPM-40. Both API endpoints and operation keys coexist; either decision
  prevents the opposite decision with no duplicate activity or notification.
- Required cases: valid reason and exactly ten characters, blank/nine characters,
  cancel with no request, denied roles, terminal states, stale version, duplicate
  replay, changed key payload, rollback on audit/notification errors, actor/time,
  notes delivered to owner, unsaved edits, reload/retry and desktop/mobile.
- SPM-39 is on `main` and merged into this branch. The rejection work is
  committed on `feature/SPM-40-reject-submitted-event-request`. No real user
  changes or hosted fixtures. Only the explicitly authorised SPM-40 migration
  was applied.

## Rejection reason and history follow-up

The rejection audit entry existed, but the UI needed explicit rejection wording,
a persisted reason in the organiser event view, and refresh for previously open
tabs. GET event now includes optional rejectionReason for REJECTED events,
read only after visibility checks from the latest ORGANISER_SAFE EVENT_REJECTED
entry. Staff-only notes are excluded. History labels the action and displays
its reason separately. Event/history refresh on focus/visible-tab changes.
These shared refresh hooks and the additive response field need integration review.
Backend 1,851 tests, frontend 170 unit tests, lint and 45 browser journeys passed.
Hosted verification read only confirmed the saved reason; no event was mutated.

## Expanded edge-case verification

- Rejection SQL suite: 27 passed, adding exactly 2,000 characters, Unicode,
  trimmed boundary notes, missing key/version and nonexistent event checks.
- SPM-40 production browser suite: 19 passed. The broader run also passed 71
  related approval, event-workspace and clarification journeys. A failing race
  regression was fixed and the entire 19-test SPM-40 suite rerun successfully.
- Found and fixed: a background GET started before rejection could overwrite
  the committed event returned by the mutation. The event-view hook now
  invalidates older pending reads whenever a mutation replaces the event.
- Markup-like notes are rendered as plain text; long notes fit mobile width.
- Frontend lint and 170 unit tests passed. No shared data writes in this audit.
- Prepared `tests/integration/eventRejection.integration.test.js` in the backend
  for live Auth/API/detail/history/notification and two-connection races. It is
  skipped unless SPM40_LIVE_TESTS=authorized, and checks both database URLs for
  the authorised development project before fixture creation. It has NOT run;
  explicit shared-fixture permission is pending. It creates namespaced fixtures
  and uses existing cleanup manifests. This is not production test evidence.

## Review fixes (31 October 2026)

- The rejection SQL suite now loads `_lifecycle_transitions` from the newest
  migration that defines it, so later changes to the transition table are
  tested. The four-argument `_apply_event_transition` and `_notify_event_users`
  overloads used by the RPC are only defined in the SPM-173 migration.
- Validation messages are aligned with the frontend; the RPC fallback now reads
  "Rejection notes must contain 10 to 2,000 characters and no null characters."
- Rejection from `AWAITING_CLARIFICATION`, `PLANNING` and `SAFETY_REVIEW`
  (Master 5.2) remains out of scope and needs its own ticket: it must release
  holds, bookings and reservations and close open clarification rounds and
  safety reviews in the same transaction.
- Verified: `npm test` 2,389 passed (94 suites); `node --test
  tests/database/*.test.cjs` 382 passed, including 27 SPM-40 tests.
- `tests/integration/eventRejection.integration.test.js` (separate-connection
  races, Master 11) has still not run; it needs permission for shared fixtures.
