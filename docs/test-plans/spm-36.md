# SPM-36 backend test cases — submitting event requests

Status: implemented core submission; execution results and outstanding integration dependencies are recorded below.
The scenario tables remain the acceptance checklist; they do not imply every dependent feature is complete.

## References and agreed behavior

- [SPM-36 — Submitting Event Requests](https://yvery.atlassian.net/browse/SPM-36).
- [Master](../../ConnectSphere-Master.md), sections 5.2, 5.8, 7.1 and 8.
- [Frontend companion plan](../../../connectsphere-events-g8t6-frontend/connectsphere-g8t6/docs/test-plans/spm-36.md).
- Original scenario references `TC-01`–`TC-18` and `NT-01`–`NT-06` match the planning discussion; `BE-*` identifies backend cases.

Use the Master flow and the user's confirmed setup of one Coordinator Lead:

`DRAFT → submit → SUBMITTED (unassigned) → Lead assigns → UNDER_REVIEW`

Submission keeps the existing request ID, saves final valid information and
records submission time. It does not select a Coordinator or record a supervising
Lead. The single Lead can see the submitted event in the unassigned queue.
Assignment later records the Coordinator and supervising Lead.

SPM-36's current SUB-01, SUB-02, SUB-06 and SUB-08 still describe automatic
assignment. These cases use the agreed replacement flow. No available Coordinator
is not a submission failure. SUB-05 follows SPM-33's post-submission edit rules.
This document does not update Jira or claim its acceptance criteria were amended.

## Fixtures and execution approach

- A: active Organiser and draft owner. B: another Organiser, tested both within and outside A's organisation.
- L: the one active Coordinator Lead. C1/C2: active Coordinators, separate from L.
- Additional denied-role identities: Venue Staff, Technical Support, Safety Officer and Attendee; also test a missing/expired session.
- Valid draft E: title, purpose, description, start/end with explicit timezone offsets, positive whole-number attendance and a valid layout. Use future times relative to a fixed test clock.
- Enable Coordinator workflow routes for queue/assignment integration cases.
- Future database tests must use an authorized test environment and namespaced fixtures; clean up their own event, recipient, notification and related test records, and report retained audit data.
- Use validator unit tests for input boundaries, route tests for authentication/error mapping, and real database integration tests for transactions, concurrency, persistence and deduplication. Mocks alone cannot prove those guarantees.

For rejected operations, verify no change to the persisted draft, status,
assignment, submission time, successful-submission activity or notifications.
Unsaved input retention is a frontend responsibility.

## Core submission cases

| ID | Original scenario / AC | Preconditions and action | Expected result | Level |
| --- | --- | --- | --- | --- |
| BE-01 | TC-01 / SUB-01 | A submits valid owned draft E through `PUT /api/events/:id/submit`. | 200; same event/request ID; submitted fields persisted; status `SUBMITTED`; recorded submission time; no Coordinator or supervising Lead assignment. | Route + database |
| BE-02 | TC-02 / SUB-01 | Submit E with final valid edits, including requirements, different from the saved draft. | Final accepted values and submission commit together against E; no extra event created. | Database |
| BE-03 | TC-01, TC-03 / SUB-01, SUB-02 | Read E after successful submission. | Stored submission time is present and represents the submission instant; status label is `Submitted`; event remains unassigned. Do not assume `updatedAt` alone proves submission time. | Database + route |
| BE-04 | TC-04 / SUB-01 | L reads the queue after E is submitted; include older and newer submitted fixtures. | E appears once in oldest-first order with permitted basic information. Drafts and assigned events are excluded. SPM-174 integration. | Database + route |
| BE-05 | TC-05 / SUB-08 amended | Submit valid E with no active/available Coordinator fixture. | Submission succeeds into the queue; no `NO_ELIGIBLE_COORDINATOR` failure or automatic assignment. | Database |
| BE-06 | TC-06 / SUB-03 | Omit each mandatory field, then test null/empty/whitespace values as applicable; test multiple missing fields together. | 400 with field-specific errors for all affected fields; no submission effects. Mandatory fields: title, purpose, description, start/end, attendance and layout. | Validator + route |
| BE-07 | TC-07, TC-08 / SUB-04 | Freeze time; test invalid/past start, start just below/exactly/above 48 hours ahead, end equal to/before/after start, malformed dates and dates without timezone offsets. | Current shared 48-hour minimum applies: exactly 48 hours is valid; end must be later than start; malformed/ambiguous inputs rejected with field errors. | Validator + database |
| BE-08 | TC-07 / SUB-04 | Test attendance absent, 0, negative, fractional, nonnumeric, 1, valid numeric string, and above PostgreSQL integer range. | Only supported positive whole-number values within storage range accepted; invalid values return attendance errors rather than server errors. | Validator + route |
| BE-09 | TC-09 / SUB-04 | Test invalid layout, unknown/duplicate venue or equipment IDs, invalid quantities and text beyond existing shared limits. | Field-specific validation failure; no partial event or requirement update. Reuse SPM-35/SPM-37 shared rules. | Validator + database |
| BE-10 | TC-09 / SUB-04 | Enable registration with missing/zero/negative/fractional capacity; test valid capacity and disabled registration without capacity. | Invalid enabled-registration capacity rejected; valid and optional-field cases follow the shared validator. Do not require a booked venue at submission. | Validator + route |
| BE-11 | TC-10 / SUB-07 | Submit E without a session or using an expired/invalid session. | 401; no submission effects. | Route |
| BE-12 | TC-11 / SUB-07 | B submits E, including same-organisation B; repeat with each non-Organiser role. | Action denied; no private draft disclosure or submission effects. Assert the established route's 403/404 access contract for each role. | Route + database |
| BE-13 | TC-12 / SUB-07 | Include system fields such as owner, Coordinator, supervising Lead, status, request ID or submission time with otherwise valid edits. | Reject disallowed fields as a whole; client cannot assign staff, change ownership or supply lifecycle/time values. | Route + database |
| BE-14 | TC-13 / SUB-06 | Submit E successfully, then repeat the same request. | One event, transition, original submission time and successful-submission activity; no duplicate notification recipients. Current route may return 409 `EVENT_NOT_DRAFT`; do not require a new replay contract. | Database + route |
| BE-15 | TC-13 / SUB-06 | Send two concurrent submissions for E. | At most one transition commits; no lost update, duplicate event/activity/notification or overwritten submission time. Losing request follows the established conflict response. | Database |
| BE-16 | TC-14 / SUB-06 | Commit E's submission, simulate loss of response, retry, then retrieve E. | No duplicate effects; GET reveals committed `SUBMITTED` state so the client can recover from an ambiguous response. | Route + database |
| BE-17 | TC-15 / SUB-06 | Submit E, let L assign C1, then retry the old submission. | No new transition or notification; C1, L and `UNDER_REVIEW` retained; E does not re-enter the queue. | Database |
| BE-18 | TC-16 / SUB-05 | After submission, A sends direct updates through both the draft and general edit routes. | Updates denied; all submitted fields unchanged; appropriate change-request guidance/error returned. SPM-33 regression; clarification and change-request implementation excluded. | Route + database |
| BE-19 | TC-17 / SUB-08 | Inject a persistence failure during submission, including after event data is tentatively written but before commit. | Whole transaction rolls back; no partial fields, requirements, timestamp, activity or notification; no successful response; persisted draft remains available for retry. | Database |
| BE-20 | TC-18 / SUB-01 integration | After E submits, L assigns active C1 through the assignment route. | Coordinator C1 and supervising Lead L recorded; state `UNDER_REVIEW`; E removed from queue. This verifies the SPM-177 boundary, not an assignment reimplementation. | Database + route |

## Notification integration cases

Submission must create durable notification/recipient data inside the business
transaction. Provider delivery happens only after commit. Count one notification
effect per action and recipient; do not require separate notification records
where one record with multiple recipient rows satisfies the contract.

| ID | Original scenario | Action | Expected result | Dependency |
| --- | --- | --- | --- | --- |
| BE-N01 | NT-01 | Successfully submit E. | Exactly one submission notification effect each for A and L, identifying E and the relevant action; no notification for C1/C2 yet; audience-safe wording. | SPM-31; SPM-192 AC1; Lead alert coverage gap |
| BE-N02 | NT-02 | Run invalid, unauthorized and failed submissions. | No submission notification or delivery rows created. | SPM-36 transaction |
| BE-N03 | NT-03 | Repeat and race submissions, including retry after response loss. | No duplicate notification/recipient/delivery effects for the originating action. | SPM-31 deduplication |
| BE-N04 | NT-04 | Fail durable notification or recipient insertion before commit. | Submission rolls back completely, with E still a draft. | SPM-31 transaction integration |
| BE-N05 | NT-05 | Fail email provider delivery after a successful commit. | E and in-app notification remain committed; delivery can retry without duplicate effects; nothing sent before commit; submission creates no SMS delivery. | SPM-31 delivery work; not provider implementation in SPM-36 |
| BE-N06 | NT-06 | Retrieve notification data as an unrelated user and attempt access through its event target. | No other user's notification or private event information disclosed; Lead target uses the permitted queue/action view rather than assuming generic event-detail access. | SPM-191 + SPM-174 access contracts |
| BE-N07 | TC-18 boundary | L assigns C1 after E submits. | Assignment notifies C1 and A once; C2 receives nothing. No Coordinator notification was sent at submission. | SPM-177 + SPM-193 AC1 + SPM-192 AC4 |

## Dependencies and existing coverage

- SPM-174 owns the queue, SPM-177 assignment, and SPM-33 direct edit restrictions.
- SPM-191 owns inbox/read state/navigation; SPM-192 owns Organiser updates; SPM-193 owns Coordinator updates after assignment. Those notification stories were To Do when reviewed on 19 October 2026.
- No dedicated Lead submission-alert story was identified. Track this integration gap under SPM-31; it remains a required Master behavior, not an optional acceptance test.
- Notification-dependent cases remain planned/pending until their shared contract and implementation are available. A mocked notification call does not complete database delivery or inbox acceptance.
- Existing starting points: `tests/unit/eventValidator.test.js`, `tests/unit/eventRoutes.test.js`, `tests/unit/eventModel.test.js`, `tests/integration/events.integration.test.js`, and the SPM-33 edit/assignment suites. Existing overlapping tests are reuse candidates, not evidence that these cases pass.
- The draft submission controller rejects repeats with `EVENT_NOT_DRAFT`. The SPM-36 migration adds `event.submitted_at`, exposed as `submittedAt`; later updates preserve it. The detail read adds `coordinatorName`. Apply the migration before deploying the updated backend.
- The full cross-role browser journeys are listed once in the frontend companion plan as `E2E-*`.

## Execution record — 19 October 2026

Environment/startup checks passed before implementation: ignored environment
files and supported keys, backend root/health check, frontend login page, and a
real synthetic Attendee login/logout/token-revocation journey. Starting commits:
backend `917d590`, frontend `2459119`. Both repositories use
`feature/SPM-36-submit-event-requests`. Initial implementation preserved existing
backend package edits; the follow-up repair restored both package files to main.

| Check | Result and scope |
| --- | --- |
| Backend unit/route regression suite | After restoring package.json and package-lock.json to main and running `npm ci --no-audit --no-fund`, ordinary `npm test -- --runInBand` passed 529/529 in 19 suites using the repository's Jest 30.5.2. Includes new SPM-36 route cases and shared validation/access/edit regressions. Local HTTP test sockets required execution outside the filesystem/network sandbox. |
| PostgreSQL migration suite | 12/12 passed in isolated engine cases: submission/time/audience, no available Coordinator, invalid input, ownership, duplicate submission, requirement and recipient rollback, assignment notifications/time preservation, immutable timestamp, create-key replay, queue order and historical backfill. See command below. |
| Hosted integration suite | Added concurrent draft PUT and rollback cases and updated receipt audiences. Not run: `TEST_DATABASE_URL` is absent and shared migration application is pending verification. Actual multi-connection concurrency remains unverified. |
| Frontend | After the review repairs, lint and 14/14 unit tests passed; full browser suite 56/56 passed with production build/type checks, including 13 SPM-36 cases. New cases cover a lost creation response followed by 401 on replay or event GET, then login/reload/retry without duplicate simulated effects. Unresolved-key recovery after 31 minutes is also covered. Browser Auth/API calls are mocked; this does not prove hosted cross-role integration. |
| Provider/inbox cases | BE-N05 and BE-N06 remain pending SPM-31/SPM-191 provider/inbox implementations. Assignment notification audiences are verified directly in SQL; actual inbox/navigation is not. |
| Schema/cleanup | Exposed development schema inspected read-only. Migration applied only in isolated, disposable PostgreSQL WASM instances, closed after testing. No shared migration, event fixture, Auth account or notification created by this work item. |
| Design/provisional markers | Existing organiser wizard/details used as frontend reference. No provisional markers in changed feature code. |

The first review found that pre-existing package downgrades mixed Jest 25.0.0
core with Jest 25.5.4 config and prevented the normal test runner from starting.
The follow-up repair removed those unrelated changes by restoring package.json
and package-lock.json to main (Jest ^30.5.2 and nodemon ^3.1.10), then performed a
clean install and verified the ordinary test command. An isolated Jest runner is
no longer required. The SQL suite below was also rerun and passed 12/12.

No authenticated Supabase MCP connection was available during the review/repair
session. The earlier implementation's exposed-schema inspection does not prove
current project grants, RLS, function definitions or migration history. Verify
those read-only against project `rvwiflsedoujspmzfrbq` before rollout; no shared
database changes or business fixtures were created by the review/repair.

To reproduce SQL migration tests without adding an application dependency, from
the backend root:

```sh
npm install --prefix /private/tmp/spm36-verification --no-audit --no-fund @electric-sql/pglite@0.5.10
PGLITE_MODULE=/private/tmp/spm36-verification/node_modules/@electric-sql/pglite node --test tests/database/spm36Submission.test.cjs
```

The suite loads actual submission/assignment/helper SQL from versioned migrations
and a fixture schema derived from the inspected column/relationship contract. It
executes PL/pgSQL, including forced recipient-insert failure and rollback. It is
single-connection PostgreSQL WASM coverage, not a replacement for Supabase Auth,
PostgREST, complete hosted constraints/permissions, providers or lock-contention
verification. The fixture SQL is never a shared database setup script.

Before rollout, review/apply
`20261019120000_spm36_submission_time_and_lead_receipt.sql`, coordinate the current
remote migration head with teammates, configure authorized audit cleanup, and run
the hosted integration suite. SPM-31 still needs explicit ownership of Lead alert
presentation. Dedicated supervision/handover modeling stays with assignment
stories; this change retains `event_assignments.assigned_by` as the recorded Lead.
