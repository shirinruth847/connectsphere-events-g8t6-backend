# SPM-134 hosted verification — 31 October 2026

Reviewed backend PR 32 head: `d2ad63e687945f2b3cd024c73640749f8c9a78d8`.
Development project: `rvwiflsedoujspmzfrbq`. The user explicitly authorized
development migration work and synthetic tests in this session.

## Deployment verification

Supabase MCP remained unavailable. Read-only PostgreSQL transactions through
the existing project-scoped test connection supplied the missing evidence.
No connection was reconfigured and no credentials or complete business rows
were included in the report.

Migration history already contained `20261031100000` and waitlist correction
`20261031080611`; no migration was reapplied. All three deployed function
bodies exactly matched the PR's final corrective migration:

- `register_for_event`: fresh post-lock clock and actual waitlist helper calls.
- `event_registration_availability`: statement-time discovery read.
- `_event_registration_availability_at`: shared timed admission rule.

All three are SECURITY DEFINER with `search_path=pg_catalog, public`.
The public entry points grant execute to service_role; the timed private helper
has only owner execute. The waitlist expiry/allocation helpers exist and have
owner-only execute. Registration, waitlist_offer and idempotency_records have
RLS enabled. Registration retains its unique attendee/event constraint and
bounded preference-text checks. Browser roles lack SELECT/INSERT/UPDATE/DELETE
on registration; legacy REFERENCES/TRIGGER/TRUNCATE grants remain a separate
pre-existing privilege-hardening consideration, not proof of a browser HTTP
exploit. Runtime service_role retains registration table privileges.

## Executed checks

From the backend repository:

```sh
npm run test:integration -- --runTestsByPath tests/integration/eventRegistration.integration.test.js
```

Result: **54 passed**, including actual Auth/Express/PostgreSQL requests,
last-place races, parallel duplicate/idempotent requests, profile preservation,
notifications, and a separate-client event-lock wait across the closing deadline.
The existing afterAll manifest cleanup and its clean-state assertions completed.
No unrelated manifests were cleaned.

Three supplementary hosted checks ran from an isolated snapshot using the same
fixture lifecycle and deployed PostgreSQL functions. Each admission/offer
scenario ran in a transaction that was rolled back; namespaced accounts,
events and venues were removed by the existing fixture cleanup.

- Eligible queued attendee retains priority over direct registration: passed.
- Active offer reserves the only place: passed.
- Expired offer is expired by the actual helper and a direct place is admitted:
  passed.

Final supplementary result: **3 passed** (54 copied registration cases were
filtered out, not rerun by this supplementary command). The initial expired
fixture failed waitlist_offer_window_check because its offered_at was later
than expires_at; correcting the synthetic timestamps yielded the passing run.
No deployed constraint or application logic was changed to make it pass.

Logs for this session: `/tmp/spm134-hosted-registration.log` and
`/tmp/spm134-hosted-coexistence-final.log`. The supplementary test source is
`/tmp/connectsphere-backend-pr32/tests/integration/spm134HostedCoexistence.review.test.js`.

## Conclusion and limits

The previously missing deployment, hosted registration-concurrency and basic
real-waitlist-coexistence evidence is now available. No production code change
was required. The earlier isolated checks passed 2,254 unit tests and 58 SQL
tests; those are prior executions, not rerun here. Frontend rendering/recovery
criteria and the full SPM-163 acceptance/withdrawal/job suite remain separate
workstreams. Dependency advisory maintenance remains a non-blocking follow-up.
