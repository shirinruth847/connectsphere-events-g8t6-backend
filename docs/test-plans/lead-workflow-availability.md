# Lead workflow availability without a rollout switch

Candidate branch: `fix/lead-workflow-availability`, based on backend main
`bb90dcb`. Paired frontend branch: `fix/lead-dashboard-requests`, based on
frontend main `11c5524`. Requested by the user on 28 October 2026 after the
Lead Dashboard home displayed no event requests. Neither branch is merged.

## Change and boundaries

The five existing Lead endpoints are now always registered: unassigned queue,
cross-coordinator availability, supervised assignments, initial assignment and
reassignment. Only the `ENABLE_COORDINATOR_WORKFLOWS` registration condition and
its fallback 404 handler are removed. All five retain the same verified-token
and trusted Lead-role middleware, controller validation, model calls, ownership,
supervision, lifecycle, scheduling and idempotency checks.

The companion frontend embeds the existing queue on `/dashboard`. No database
objects, migrations, dependencies, response contracts, background jobs or shared
business records are changed. The already-applied
`20261020075714_spm174_lead_assignment_conflict_guard.sql` prevents conflicting
assignments; rerunning it cannot register HTTP routes or render dashboard cards.

The Master's earlier environment/startup text describes the old rollout gate.
This branch is the user-requested candidate to retire that deployment detail;
it changes no enduring role, ownership or lifecycle business rule. Historical
baseline reports and integration test setup may still mention the old setting.

## Verification, 28 October 2026

- Before the route change, all 44 new cases in
  `tests/unit/leadWorkflowAvailability.test.js` failed with 404 responses. The
  existing unassigned-event tests passed (9 cases).
- After the change, the focused route suites passed 159 tests, including all
  44 new cases with the flag unset and explicitly `false`. Coverage includes
  authorized reads/writes, verified actor propagation, reassignment command
  identity, missing/invalid sessions and denial of every non-Lead role.
- Full backend unit run: **65 suites, 1,749 passed**, flag unset. MongoDB tests
  used the previously verified local executable and isolated test databases;
  Supabase configuration was dummy localhost configuration.

```sh
env -u ENABLE_COORDINATOR_WORKFLOWS \
MONGOMS_SYSTEM_BINARY=/private/tmp/spm192-mongodb/mongod \
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_ANON_KEY=lead-workflow-unit-key SUPABASE_SERVICE_ROLE_KEY= \
npm test -- --runInBand
```

- The paired frontend source previously passed 352 mocked browser tests with
  production build/type checks, 147 Node tests and 3 Vitest tests. Lint had zero
  errors and one existing unused `historyIcon` warning. Only documentation
  changed in that frontend branch during backend flag removal.
- An additional Playwright MCP check used the production frontend on 3100 and
  the real Express app on 8000, with **no browser API interception**. The flag
  was absent. Identity verification and business models were synthetic in-memory
  test doubles; no hosted Auth or database writes occurred. The dashboard loaded
  a submitted request, confirmed assignment, removed it from the queue, opened
  Assignments, and confirmed reassignment after refreshing current assignments.
  Direct calls without a token returned 401; a Coordinator token returned 403.
  Temporary servers started no background jobs and were stopped after checking.

These checks detect regressions in covered behavior; they do not establish
complete hosted integration, external notification delivery or hosted concurrency.

## Rollout and rollback

Review and deploy the backend candidate with the matching dashboard frontend.
Every deployment still needs its normal assignment/reassignment migrations,
including the SPM-192 wrapper already applied to development. No new migration
or reapplication is required by this change. An old flag value is ignored,
including `false`; deployments intentionally using it to disable Lead operations
must account for this intended behavior change before upgrading.

Do not remove the setting from an older deployment until its backend is upgraded.
Rolling back to the old backend restores the flag requirement, so that version
needs `ENABLE_COORDINATOR_WORKFLOWS=true` for Lead routes. PostgreSQL and MongoDB
data require no rollback for this code-only change.
