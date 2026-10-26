# SPM-41 review fixes

Scope: clarification audience, organiser equipment amendments, unchanged-start
lead-time validation, and acknowledgements of displayed clarification messages.
The ticket's coordinator-completion workflow remains in place.

## Deployment and rollback

1. Apply `20261025120000_spm41_displayed_message_reads.sql` after the three
   existing SPM-41 migrations, before deploying this backend.
2. Deploy the backend, then the matching frontend. Request options add only
   equipment IDs/names. No stock or reservation capability is exposed.
3. The read endpoint accepts `{ lastMessageId }` and responds `200 { read }`.
   A false result leaves saved read state unchanged. Missing cursors and
   same-organisation readers return false. Invalid supplied IDs return 400.
   Safety Officers receive 404 even when they can view the event for safety.
4. The former three-argument read RPC is retained as a no-op during rollout.
   Old clients can still read conversations but cannot clear unseen replies.
5. Application rollback can retain the added cursor column and overload.
   Do not drop thread/read data. Restoring the former helper definitions would
   reintroduce the stale-read defect; review any function rollback together.

Read acknowledgements and message writes use event -> clarification locks.
The cursor must equal the latest message ID under those locks. A later reply
therefore survives a delayed acknowledgement. Unread counts compare message
IDs, and notification/read timestamps use actual database time to avoid long
transactions making a new notification appear older than a read.

## Local commands

Backend:

```sh
npm test -- --runInBand
node --test tests/database/spm41ClarificationReads.test.cjs
```

Frontend, from `connectsphere-g8t6`:

```sh
npm run lint
npm test
npm run test:e2e
```

The focused backend route/model tests are in `clarifications.test.js`,
`clarificationActions.test.js`, and `eventModel.test.js`. Database access is
mocked there. The new database test executes actual migration functions on the
reduced SPM-177 fixture, including legacy backfill, stale and fabricated cursor
refusal, rollback, browser grants and transaction-start timestamp ordering.
It does not prove hosted RLS or separate-connection races.

SPM-41 browser regressions cover refreshed replies, failed refresh/retry without
read acknowledgement, attendance/end-only amendments inside 48 hours, invalid
equipment quantities, add/remove/save, and desktop/mobile geometry. Equipment
screenshots are saved in the corresponding Playwright test output folders.
Authentication and business APIs are mocked; the configured browser command
also runs the production build/type checks.

## Hosted checks requiring separate authorization

Do not run hosted fixtures during a read-only review. Once explicitly authorized,
use namespaced synthetic events/users and verify cleanup. The maintained
`tests/integration/clarifications.integration.test.js` sends observed cursors.
Also exercise independent connections for message versus acknowledgement,
amendment versus completion, and reassignment versus writes. Verify that a stale
acknowledgement does not clear unread state or reopen the notification throttle.

## Local execution — 25 October 2026

Checks used Node.js 24.22.0 and existing installed dependencies; some transitive
versions differ from the lockfiles. Exact-lockfile CI remains required.

- Frontend lint passed; `npm test` passed 107 tests.
- The final full browser rerun completed its production build/type checks and
  passed all 229 tests, including all 28 SPM-41 cases. A temporary configuration
  kept the same test set and production build/server command, with a list
  reporter, output under `/tmp`, and tracing disabled to avoid an earlier
  `ENOSPC` while writing trace files. Desktop/mobile equipment screenshots were
  inspected.
- Backend focused route/model/startup checks passed 229 tests using:
  `npm test -- --runInBand --runTestsByPath tests/unit/clarificationActions.test.js tests/unit/clarifications.test.js tests/unit/eventModel.test.js tests/unit/startup.test.js`.
- The final full backend run passed all 1,294 tests across 50 suites. Its earlier
  MongoDB startup failures came from a truncated cached executable. The rerun
  used a complete MongoDB 7.0.24 binary extracted under `/tmp`, verified against
  MongoDB's official archive checksum and macOS signature, through
  `MONGOMS_SYSTEM_BINARY` with `MONGOMS_RUNTIME_DOWNLOAD=false`. Inert loopback
  Supabase configuration (`SUPABASE_URL=http://127.0.0.1:9` and a synthetic key)
  satisfied a seed-helper import; no hosted credentials were used.
- `node --test tests/database/spm41ClarificationReads.test.cjs` passed all five
  checks, including the final cursor index and migration definitions.
- Hosted integration/concurrency tests were not run, and the new migration was
  not applied to the shared project.

The MongoDB checks also exposed a pre-existing SPM-181 photo-limit race: a
separate local repetition left 21 photos despite the 20-photo limit in 5 of
20 trials. The photo model, its test and its migration match `origin/main` and
are unchanged by these SPM-41 fixes. A green full-suite run does not resolve
that intermittent failure; it requires a separate SPM-181 change.
