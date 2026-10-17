# Completed-ticket repair baseline

Repair branch in both repositories: `fix/main-completed-ticket-baseline`.
Starting commits: backend `a3f51c6`, frontend `229e56d`. Local main branches and
existing stashes were preserved. Jira ACs were checked directly on 18 October 2026.

## Scope and contract decisions

| Ticket | Agreed scope | Current Jira / GitHub evidence |
| --- | --- | --- |
| [SPM-32](https://yvery.atlassian.net/browse/SPM-32) | Login, role routing, scoped dashboards, protected routes, logout | Done; backend #3 merged, frontend #1 still open |
| [SPM-35](https://yvery.atlassian.net/browse/SPM-35) | Request input, validation, explicit submission, receipt and dashboard | Done; backend #2/#7 and frontend #6 merged; frontend #7 is a follow-up |
| [SPM-37](https://yvery.atlassian.net/browse/SPM-37) | Manual save, autosave, resume/submit and dirty navigation | Done; backend #2 merged; frontend #7 still open |
| [SPM-123](https://yvery.atlassian.net/browse/SPM-123) | Existing backend signup contract and its regressions | Done; backend #6 merged; frontend #4 remains outside this repair scope |

SPM-35/SPM-37 descriptions still contain old text saying the frontend is not
built. Their explicit ACs define the verification below. Their sample errors
use `errors`/`message`, while the live API uses `fields`/`error`; the frontend
accepts both without changing backend validators or existing response shapes.
Lists retain the implemented cursor contract. Private resources retain the
existing nondisclosing 404 behavior. Current SPM-123 has five ACs; older PR
comments requiring email-verification AC6–AC8 do not match the current ticket.

## Implemented repairs

- Consolidate browser auth onto the publishable/anon-compatible Supabase client.
  Verify the backend profile before routing, validate normalised return URLs and
  render organiser, coordinator, venue staff, technical support and attendee
  destinations. Staff landing pages do not implement future operational modules.
- Revoke the current backend session on logout, clear local state and guard
  history restores. A business-call 401 redirects to login and preserves unsaved
  organiser input for the same user to recover after reauthentication.
- Serve `/events/create`, block invalid required fields on Next, and require an
  explicit final Submit. A saved draft submits final edits in one atomic PUT.
- Return a minimal organiser-only `/api/events/request-options` catalogue of
  venue IDs/names and layout choices. It does not create bookings or holds and
  does not implement the pending venue-management ticket.
- Save empty draft fields as explicit null/empty values, retain existing venue,
  layout/equipment requirements, serialise saves, reuse uncertain create keys,
  retain the first draft ID and use PUT thereafter. Reset the 30-second idle
  timer on keyboard/mouse/touch input. Do not add audit rows for autosave PUTs.
- Consume success notices once, group/filter drafts, render API statusLabel and
  tolerate unknown statuses. Map server field errors to the relevant wizard
  step; block missing, inaccessible, submitted and stale draft editors.
- Warn on refresh/tab close with the browser dialog and use the specified
  in-app warning for links and Back/Forward navigation.

## Scope isolation and removal manifest

Open PR state alone does not prove an accidental push. The following is a
reviewable isolation of features outside the user-selected four-ticket scope.
Jira marks SPM-174/SPM-177 Done despite their open PRs; SPM-180 is Reviewing.

| Area / provenance | Repair action | Retained dependencies |
| --- | --- | --- |
| Frontend `f367b99` / `89fee4e`: queue/initial assignment | Remove `app/events/page.tsx` and its feature-only API helper | Keep shared auth, organiser event forms and common CSS/design tokens |
| Frontend `c3c1391`: reassignment/calendar UI | Remove `app/assignments/page.tsx`, `app/calendar/page.tsx`, `components/assignments/availability-matrix.tsx`, `components/calendar/calendar-view.tsx`, `components/layout/coordinator-shell.tsx`, `components/shared/status-chip.tsx`, `lib/api/events.ts` | Keep the shared primitives, organiser styles and one compatible Supabase helper |
| Root login implementation coupled to coordinator UI | Replace `app/page.tsx` with redirect to the shared login page | Shared login resolves the verified user's permitted destination |
| Backend `37c91eb`: lead queue/assignment/reassignment | Gate five workflow routes behind `ENABLE_COORDINATOR_WORKFLOWS=true`; default is 404 | Keep coordinator's own assigned-event read for SPM-32, shared models/controllers and all historical migrations |
| Applied database objects | No schema changes or remote migration rollback | Persisted unassigned events, roles, audit records, assignment history and existing RPCs remain intact |

Backend `a3f51c6` has parents `37c91eb`/`479b2ef`; frontend `229e56d` has parents
`c3c1391`/`c9d1ad5`. Their messages describe main being merged into a feature
branch and do not establish how main was advanced. The repair does not blindly
revert those merge commits or import the pending PRs wholesale.

## AC evidence

| Ticket / AC | Evidence | Result |
| --- | --- | --- |
| 32 / staff login | Real EC, Venue Staff and Tech Support login and token revocation; browser role tests | Pass for authentication/routing; future operational tools remain feature scope |
| 32 / attendee view and isolation | Live attendee login; backend auth integration fixtures test registered-event projection and denial of internal/unassociated data; browser rejects organiser editor | Pass |
| 32 / organisation scoping | Backend integration tests exercise Organisation A/B, private drafts, colleague requests and organisation-less organisers; live organiser dashboard | Pass |
| 32 / invalid credentials | Backend real unknown-user/wrong-password checks; generic browser error | Pass |
| 32 / blank credentials | Inline browser validation for missing email, password and both | Pass |
| 32 / protected URL and return | `/events/create` redirects back after login; role-inappropriate and normalised external destinations rejected | Pass |
| 32 / logout and history | Browser Back protection; live server rejects each revoked token with 401 | Pass |
| 35 / AC1 input | Live persisted title, purpose, description, exact times, attendance, layout, selected venue preference, accessibility and registration capacity | Pass |
| 35 / AC2 validation | Existing backend validator/route tests; inline browser validation and server-error step mapping; exact 48-hour unit boundary | Pass |
| 35 / AC3 explicit submission | Browser proves Next does not POST; real Submit creates one SUBMITTED request with no assigned coordinator | Pass |
| 35 / AC4 receipt | Live success UI and real database receipt-notification assertion | Pass |
| 35 / dashboard | New request appears using Pending Approval from API; unknown-status browser test | Pass |
| 35 / TC-004 | Protected `/events/create`, login message and destination preserved | Pass |
| 37 / manual save | Real title-only save, success notice and My Drafts; one-shot banner browser test | Pass |
| 37 / isolation | Existing backend draft-isolation tests; runtime pending review routes disabled; no booking/hold created by options read or draft API | Pass within completed-ticket baseline |
| 37 / autosave | Browser 29/30-second boundary and input reset; real first POST/later PUT, DRAFT persistence and unchanged audit count on autosave PUT | Pass; virtual client clock used for deterministic timing |
| 37 / resume and submit | Real exact resume, clearing purpose to null and final submit; browser verifies only one final PUT and rejects stale/submitted/missing editors | Pass |
| 37 / data loss | Browser link/Back modal, refresh cancellation, session-expiry recovery; native dialog controls refresh/tab-close wording | Pass for exercised browser paths; OS-level forced process termination is not simulated |
| 123 / valid selected role | Live signup integration creates linked ATTENDEE/ORGANISER profiles | Backend pass; frontend signup remains pending |
| 123 / duplicate email | Live signup integration covers generic error and case variants | Backend pass |
| 123 / required fields | Live signup integration and unit validator tests | Backend pass |
| 123 / password rules | Live signup integration and unit validator tests | Backend pass |
| 123 / email format | Live signup integration and unit validator tests | Backend pass |

## Verification commands and limits

- Backend `npm test -- --runInBand`: 15 suites, 342 tests passed.
- Real backend auth/signup: `node node_modules/jest/bin/jest.js --runInBand
  --runTestsByPath tests/integration/auth.integration.test.js
  tests/integration/signup.integration.test.js`: 2 suites, 64 tests passed;
  their fixture manifests cleaned up successfully.
- Frontend `npm test`: 8 tests passed. Lint and Webpack production compilation,
  TypeScript and prerendering passed. Browser results are in the frontend's
  ignored `test-results/browser-results.json`; see the companion report for the
  final count (29/29 passed, including organiser layout parity). Three focused
  development-mode checks also passed; save notices survive React Strict Mode
  mount replay.
- Frontend `npm run test:live`: real seed-account login/logout for the five
  requested roles and request/draft/autosave journeys passed. A focused rerun
  also checked every submitted field and one venue preference in the database.
  Each run removed its three temporary events and dependent rows. Append-only
  audit entries remain attached to existing synthetic seed users intentionally;
  no users were created, reset or deleted by the live browser runner.
- The previously blocked complete integration run now passes: 4 suites,
  81 tests (49 auth, 15 signup, 14 event/draft and 3 reassignment). The test
  connection uses the configured shared development project through its
  session pooler, with TLS certificate and hostname verification against
  Supabase's official CA. The variable name does not imply an isolated
  database. No schema changes were applied. Each suite verified removal of
  its manifest-listed records, including temporary users and audit rows;
  zero fixture manifests remain. Machine-readable evidence is saved locally
  at `/private/tmp/connectsphere-integration-20261018.json`.
- A separate privileged test connection can remove only manifest-listed users'
  audit rows whose email matches the exact synthetic run prefix. Parameterised
  SQL and rollback tests protect this boundary; runtime audit DELETE grants
  were not broadened. Supply the connection only to test commands.
- Live initial assignment enters UNDER_REVIEW, as the current Master requires.
  Its old SUBMITTED-list assertion was corrected. Initial audit concerns about
  source/deployed migration drift did not prevent the current assignment and
  reassignment integration checks from passing, including history and
  notifications. This verifies the deployed database, not reconstruction of
  a fresh database from this branch's migration files. No partial migration
  was copied or applied to the shared database. Pending coordinator routes
  remain disabled by default; their tests explicitly enable them.
- Default scripts use Webpack because Turbopack failed with a worker port error
  in the audit environment. Both build roots are explicit. BACKEND_URL is
  accepted as a build-time fallback for NEXT_PUBLIC_BACKEND_URL.

Changes are local to the repair branches. No push, merge or shared database
schema changes have been performed.

The three inactive, unlinked profiles and protected audit rows from the earlier
17 October audit still require database-owner cleanup using its scoped SQL.
The repair run did not create additional stranded profiles.
