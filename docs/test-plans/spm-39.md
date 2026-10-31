# SPM-39: accept event feasibility

## Rules and approved ticket interpretation

Master v1.6 sections 3.5, 4.2 and 5.2: only the active assigned coordinator
accepts an `UNDER_REVIEW` request, entering `PLANNING`. The organiser sees
`Approved & Planning`; there is no stored `APPROVED` event state. On 27 October
2026 the user approved this interpretation and retaining distinct `REJECTED`
and `CANCELLED` states. Jira remains unchanged; its old state expectations are
not implemented as new lifecycle states.

Sections 5.2 and 6.3: recheck title, purpose, description, a valid interval,
positive attendance, preferred layout and a venue preference. Contacts are
the organiser's existing name/email; phone is optional under the current
signup contract. A venue preference is not a booking. Approval does not require
booked resources or repeat submission's 48-hour lead-time rule.

Sections 7.1–7.2 and 8: event first; recheck role, assignment, version and
requirements inside one database function. The transition, organiser-safe
`FEASIBILITY_ACCEPTED` activity, owner notification and idempotency result
commit together. No reservation, secondary-store write or notification to
unassigned resource staff is added. Replays must still pass current access.

## Route and affected implementation

- Existing `GET /api/events/:id` uses verified auth and `requireVisibleEvent`.
  It supplies the request information and trusted status/label to the coordinator.
- New `POST /api/events/:id/accept-feasibility` uses `requireAuth` →
  `requireRole(COORDINATOR)` → `requireVisibleEvent` → `acceptFeasibility`.
  Body: `{ "version": <positive integer> }`. Required header: `Idempotency-Key`
  under the existing syntax/length rules. Actor, state and other fields are rejected.
- Success: 200 `{ message, event }`, with stored `PLANNING`, backend label,
  incremented version and the existing `Idempotent-Replayed` header on replay.
- Refusals: 400 invalid body/version/key; 401 unauthenticated; 403 wrong role;
  404 unrelated/missing event; 409 missing required fields
  (`FEASIBILITY_REQUIREMENTS_MISSING`, field messages), stale version,
  key reuse or invalid starting state (`TRANSITION_NOT_ALLOWED`, current status).
  Rejected/cancelled requests remain unchanged and get specific refusal text.

Reuse `routes/eventRoutes.js`, `controller/eventController.js`,
`model/eventModel.js`, `config/eventConstants.js`, and existing authentication,
visibility, lifecycle and idempotency helpers. Tables: `event`, `user`,
`event_venue_preference`, `activity_log`, `notification`,
`notification_recipient`, `idempotency_records`.

## Deployment and rollback

Review and deploy `20261026190415_spm39_accept_feasibility.sql` before the API.
It adds one service-role-only function and extends the existing idempotency
operation constraint without removing operations from other tickets. It requires
the existing SPM-173 lifecycle and version trigger migrations. It adds no table,
enum state or resource booking. Migration application takes a brief exclusive
lock on `idempotency_records`; schedule deployment accordingly.

Applied to development project `rvwiflsedoujspmzfrbq` through Supabase MCP
as migration `20261026190415` on 27 October 2026 (Singapore time). The local
filename matches the migration ID assigned by Supabase; SQL content is unchanged.
An API rollback can leave it in place. Do not remove the operation from the
constraint while replay records still use it; retain history and notifications.

## Verification

- `npm test -- --runInBand`: real Express middleware/controller tests, mocked
  database model, mandatory key/version, role/scope, stable refusals and safe errors.
- `node --test tests/database/spm39Feasibility.test.cjs`: real SQL in isolated
  PGlite with existing migration helpers. Tests required fields, lifecycle,
  versioning, replay, assignment loss, rollback of activity/notifications/replay,
  grants and preservation of previous idempotency operations. Reduced fixture,
  one connection: not hosted permissions or concurrency evidence.
- After explicit hosted fixture authorization and migration deployment:
  `npm run test:integration -- --runTestsByPath tests/integration/spm39Feasibility.integration.test.js`.
  Uses namespaced Auth fixtures and manifests, persisted API/replay checks and
  two independent PostgreSQL connections for same/different-key races. Cleanup
  uses the existing privileged fixture cleanup, never raw SQL against Auth tables.

Frontend counterpart under SPM-39: approval confirmation, success banner,
required-field errors, disabled terminal-state action, request-scoped idempotency
key retained over uncertain responses/re-authentication, and refreshing event,
history and notifications after success. No frontend implementation is included.
Run the real coordinator journey against ports 3000/8000 once it consumes this
endpoint and the migration has been deployed to an authorized environment.


## Execution record — 27 October 2026 (Singapore time)

- Backend branch: `feature/SPM-39-approve-submitted-event-request`, base
  `67206cd`. Frontend checkout at final verification: `3bbfe3e`; no frontend
  code changed.
- Both dependency installs and private environment-file checks passed. Existing
  listeners on 8000/3000 were preserved. Backend root/health returned 200;
  Playwright checked real synthetic coordinator sign-in, trusted profile 200,
  named shared sidebar and logout, with no browser runtime errors.
- `npm test -- --runInBand`: 1,718 passed across 64 suites.
- `node --test tests/database/spm39Feasibility.test.cjs tests/database/spm173Readiness.test.cjs tests/database/spm72IdempotencyUpgrade.test.cjs`:
  35 passed. This includes the 22 SPM-39 checks, including the parent test.
- Hosted integration command above: 3 passed, including independent-connection
  same-key replay and different-key stale-command races. Fixture manifest cleanup
  and verification completed; no run-owned fixtures remain.
- Syntax and `git diff --check` passed. The backend defines no lint/build script.
- Verified applied function has `search_path=pg_catalog, public` and EXECUTE
  grants only for postgres/service_role. No Jira writes, commits or pushes.
- Not yet exercised: a frontend approval confirmation journey; it is not wired
  to this backend endpoint yet. The startup journey is not an approval UI test.
