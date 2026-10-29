# SPM-38 submitted event review fixes

Prepared on `fix/SPM-38-review-findings`, based on current backend main
`a698852` and frontend main `41efd3c`. Integrates the PR's organiser contact and
review requirements without replacing current safety, clarification, venue or
notification code. Review uses the same-named backend and frontend fix branches;
merging to main and updating Jira are outside this change.

## Confirmed scope

The user clarified that SPM-38 technical support means the needs provided by the
organiser when submitting, not technical arrangements created during Planning.
`technicalSupportNeeds` is optional text, trimmed, at most 2,000 characters, and
blank is null. It is captured in the organiser wizard, saved with drafts,
preserved when omitted, submitted in the existing transaction, displayed to the
organiser and assigned coordinator, and editable by the owner during an open
clarification. Coordinators cannot directly change it. Legacy events show an
explicit empty state. No support request, reservation or staffing is created.

The review fixes also wrap long organiser email addresses, retain assigned-only
email exposure (supervising Leads still receive name/ID only), and project
organiser history labels in Express. Staff keep detailed lifecycle states.
Existing unread history, pagination, safety and clarification behavior remains.
Opening an event does not start review: Lead assignment does.

## Deployment and rollback

`20261028120000_spm38_submitted_support_needs.sql` adds one nullable text column
and its length constraint and replaces the existing field-history, draft-save,
submission and clarification-amendment functions. RPC signatures, row locks,
version checks, idempotency and atomic history/notification writes are retained.
Functions keep fixed search paths and service-role-only runtime execution.
There is no data backfill or Auth change. Apply after the current SPM-173/SPM-41
functions, then deploy backend and frontend. This migration is prepared only;
shared development has NOT been modified. Do not blindly push historical files.

For application rollback, leave the nullable column and corrected functions in
place so stored support needs are retained. Removing the column would discard
user input and requires an explicitly reviewed rollback of dependent functions.

## Verification boundaries

Backend unit/HTTP tests use mocks. `node --test tests/database/spm38SupportNeeds.test.cjs` executes the complete new migration
against an isolated reduced PGlite schema: persistence/clear, submission,
validation, ownership, grants, stale saves, duplicate replay, recipient-failure
rollback and clarification amendments. It does not prove hosted RLS or
separate-client concurrency. Hosted fixture writes were not authorized.

Frontend checks: `npm run lint`, `npm test`, `npm run test:e2e`. Browser tests use
mocked Auth/Express responses and include production build/type checks. SPM-38
covers organiser capture/save/resume/submit, coordinator read, history labels,
missing support needs, denied access and maximum-length support/email at mobile
and desktop widths. Screenshot attachments are in the Playwright report.

Execution results are reported separately; commands listed here are not claims
that a check has passed. Shared event API/history files require integration
review before deployment.

## Execution record — 28 October 2026

- Exact locked dependencies installed with `npm ci --ignore-scripts`.
- Affected backend model/HTTP/validation/history/clarification command: 426 tests
  passed across 8 suites, including the script's unassigned-event tests.
- `npm test -- --runInBand` could not complete cleanly: the cached local MongoDB
  executable fails to spawn (`Unknown system error -88`), affecting seven
  MongoDB-dependent suites. With precisely those seven suites excluded, 1,700
  tests passed across 58 suites. The excluded suites are venuePhotoModel,
  venueCalendarModel, safetyPanel, venueRoomSeed, venueDetailModel,
  equipmentDetailModel and startup. No test configuration was changed.
- `node --test --test-concurrency=1 tests/database/*.test.cjs`: 147 passed,
  including all 6 new support-needs migration tests, with locked PGlite 0.2.17.
- Frontend lint passed with no warnings; `npm test`: 149 passed.
- Full `npm run test:e2e`: 371 passed, with production build and type checks.
- Shared database and Auth data unchanged. Hosted integration and separate-client
  concurrency were not executed.

Final follow-up: after the venue-mock-only screenshot cleanup, the affected
workspace/draft files passed 20 cases and hit one timeout in the existing
SPM-37 autosave test. The trace shows its business assertions completed and the
screenshot capture timed out. A focused rerun of all SPM-38 cases plus that
unchanged autosave test passed 11/11. No timeout, retry or assertion was weakened.
The earlier full 371-case passing report and final focused report are preserved
outside the source repositories. The generated tracked HTML report was restored.

## Full backend rerun — 29 October 2026

The previous MongoDB exclusions are resolved for this execution: all 65 suites
and all 1,756 tests passed in 30.595 seconds, with no suites excluded.

The default cached MongoDB 7.0.24 executable was truncated: 26,220,544 bytes,
while its Mach-O headers require 165,343,616 bytes. This causes macOS error 88,
"Malformed Mach-O file". A separate MongoDB 7.0.24 download was verified against
the published archive checksum and extracted to an isolated temporary cache.
The original damaged cache was not modified. Hosted MongoDB accessibility does
not control these local test processes.

Three tests import the Supabase client without contacting it, so the isolated
worktree also needs dummy Supabase configuration. The successful command was:

```sh
SUPABASE_URL=https://supabase.example.test \
SUPABASE_SERVICE_ROLE_KEY=spm38-local-test-key \
MONGOMS_SYSTEM_BINARY=/private/tmp/spm38-mongo-rerun.J7emoc/mongod-arm64-darwin-7.0.24 \
MONGOMS_SYSTEM_BINARY_VERSION_CHECK=true \
npm test -- --runInBand
```

No real Supabase credentials or hosted MongoDB fixtures were used. This is the
complete `npm test` command, not the opt-in hosted integration suite. The earlier
SQL and frontend results remain prior execution records; they were not rerun in
this backend-only check. Application code and shared data were unchanged.

## Hosted read-only check — 29 October 2026

Checked the configured development Supabase project and MongoDB Atlas database
`connectsphere_dev` using the backend's existing configuration. The Supabase MCP
connector returned insufficient scope, so checks used the actual Supabase REST
client and configured PostgreSQL connection instead. The PostgreSQL connection
was confirmed to target the same project as the REST API. Catalog inspection ran
inside `BEGIN READ ONLY` and ended with `ROLLBACK`.

**Deployment blocker:** migration `20261028120000_spm38_submitted_support_needs`
is absent from hosted migration history. `event.technical_support_needs` and its
length constraint are absent, and all four functions replaced by this migration
still have the pre-SPM-38 bodies. Reading the column through REST returns HTTP
400 / PostgreSQL `42703`. Consequently, live support-needs persistence is not
ready; apply the reviewed migration before deploying this feature and running
write-based integration tests. Function-body comparison, normalising CRLF/LF,
found no unrelated hosted logic changes relative to the local prior versions.

Existing Supabase reads succeeded through the SPM-38 worktree's actual model:
an assigned event returned the organiser email, another coordinator's query
returned no event, and the owner representation excluded the organiser contact
object. The history query succeeded but the sampled event had no visible history
rows, so that read does not establish hosted history-label correctness. These
checks invoked models with trusted viewer objects; they did not authenticate
real users through HTTP. The event table has RLS enabled. The three public write
RPCs have fixed search paths and service-role execution, with execution denied
to `anon` and `authenticated`; this is a grant check, not a full RLS-policy test.

MongoDB Atlas 8.0.34 connected and answered ping. All six repository MongoDB
migrations are recorded. Validators for `venue_details`, `venue_calendar`,
`venue_photos`, `equipment_details`, and `venue_photo_galleries` exactly match
the worktree schemas and use strict/error validation. Actual venue-detail and
photo-list model reads also succeeded against existing data. No SPM-38 MongoDB
migration is required by this fix.

No hosted migrations, fixture creation, business-data changes, Auth changes,
write tests, or separate-client concurrency tests were performed. Raw summaries
without credentials or personal record contents are saved in
`/private/tmp/spm38-hosted-check-results.json` and
`/private/tmp/spm38-hosted-function-compare-results.json`.

## Publication checks — 29 October 2026

The final backend rerun passed all 65 suites and 1,756 tests in 29.961 seconds,
with no exclusions. All 147 isolated database tests passed, including the six
SPM-38 migration tests. The first sandboxed run could not bind localhost; a run
alongside the database suite then hit a MongoDB startup-hook timeout. The final
complete rerun above passed after the database suite finished, without changing
tests, timeouts, or application code. Hosted migration deployment remains
pending, as documented in the read-only check above.
