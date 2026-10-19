# ConnectSphere Backend (`connectsphere-events-g8t6-backend`)

This is the backend server for the **ConnectSphere** project. It provides API routes, middleware handling, database access, and health check endpoints.

---

## Getting Started

First, clone the repository, navigate into the project directory, and install the dependencies:

```bash
git clone [clone-url]
cd connectsphere-events-g8t6-backend
npm install
```

Create a `.env` file in the root directory for environment variables (see example below).

Then, run the development server using nodemon:

```bash
npm run dev
```

Open [http://localhost:8000](http://localhost:8000) with your browser or API client to verify the backend server is running.

---

## 🌐 API Endpoints

### Health Check

`GET /api/healthcheck`

Returns:

```json
{
  "message": "App is working well"
}
```

### Unassigned Event Queue

`GET /api/events/unassigned`

Returns submitted event requests that do not yet have a coordinator assigned.
This endpoint requires an authenticated `COORDINATOR_LEAD` profile and returns
the event summary fields used for assignment.

```json
{
  "events": [
    {
      "eventId": 42,
      "requestId": "REQ-000042",
      "status": "SUBMITTED",
      "title": "Example event",
      "startDatetime": "2026-10-20T09:00:00.000Z",
      "endDatetime": "2026-10-20T12:00:00.000Z"
    }
  ]
}
```

### Event Requests (SPM-35, SPM-36, SPM-37)

These routes require an `ORGANISER` bearer token, except `GET /api/events/:id`, which follows the SPM-33 viewing rules below. All use the error shape described under Authentication. Request and response fields are camelCase. Coordinators separately read their own assigned events through `GET /api/events/assigned`. Lead queue, assignment and reassignment routes exist only when `ENABLE_COORDINATOR_WORKFLOWS=true`; shared development sets it, because SPM-33's coordinator view needs assigned events.

The attendee discovery routes, `GET /api/events/discovery` and `GET /api/events/discovery/:id` (SPM-34), require an `ATTENDEE` bearer token instead.

| Method & path | Input | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/events` | Event fields; `Idempotency-Key` header | `201 { message, event }`, status `SUBMITTED` | `400 VALIDATION_FAILED`, `409 IDEMPOTENCY_KEY_REUSED` |
| `POST /api/events/drafts` | Any event fields, `title` required; `Idempotency-Key` header | `201 { message, event, savedAt }`, status `DRAFT` | `400`, `409 IDEMPOTENCY_KEY_REUSED` |
| `PUT /api/events/:id/draft` | Changed fields, plus `"isAutoSave": true` from the idle timer. Optional `version` and `Idempotency-Key` (see SPM-33) | `200 { message, event, savedAt }`; auto-saves skip the activity log | `400`, `403` (see SPM-33), `404 EVENT_NOT_FOUND`, `409 EVENT_VERSION_CONFLICT` |
| `PUT /api/events/:id/submit` | Final edits or `{}` | `200 { message, event }`, status `SUBMITTED` | `400` (draft unchanged), `404`, `409 EVENT_NOT_DRAFT` |
| `GET /api/events/:id` | — | `200 { event }` with `isOwner`, `version`, `viewerRelationship` and `permissions` | `404 EVENT_NOT_FOUND` (missing, or outside the user's viewing scope) |
| `GET /api/events/mine` | `?status=<event status>`, `?limit=1..100` (default 50), `?cursor=<nextCursor>` | `200 { events: [{ eventId, requestId, status, statusLabel, statusNote, title, startDatetime, endDatetime, expectedAttendance, organisation, isOwner, createdAt, updatedAt }], nextCursor }`, newest edit first | `400 VALIDATION_FAILED` (including `offset`, which this list does not accept) |
| `GET /api/events/discovery` | `?limit=1..100` (default 50), `?cursor=<nextCursor>` | `200 { events: [{ eventId, title, description, startDatetime, endDatetime, organisationName, location, registrationAvailability }], nextCursor }`, soonest start first (ties by event ID) | `400 VALIDATION_FAILED`, `401 UNAUTHENTICATED`, `403 FORBIDDEN` |
| `GET /api/events/discovery/:id` | — | `200 { event: { eventId, title, description, startDatetime, endDatetime, organisationName, registrationOpenAt, registrationCloseAt, location, registrationAvailability } }` | `404 EVENT_NOT_FOUND`, `401 UNAUTHENTICATED`, `403 FORBIDDEN` |

- **Event fields:** `title` (≤ 200 chars), `purpose` (≤ 2000), `description` (≤ 5000), `startDatetime` and `endDatetime` (ISO 8601 **with** a timezone offset, e.g. `2026-10-08T09:00:00+08:00`), `expectedAttendance` (positive whole number), `preferredLayoutType` (an existing room layout or `NO_PREFERENCE`), `accessibilityNeeds` (up to 20 short strings), `isRegistrationEnabled`, `registrationCapacity`, `venuePreferences` (ordered venue IDs) and `equipmentRequirements` (`[{ "equipmentId": number, "quantity": number }]`). Numeric strings are accepted for numbers.
- **Attendee discovery** exposes only public, published events whose status is `CONFIRMED` or `PREPARATION` and whose end time is still in the future, so events already in progress are listed too. Apply the versioned SPM-34 preparation migration before deploying to databases without that enum value. The `registrationAvailability` value is one of `OPEN`, `FULL_WAITLIST`, `CLOSED`, or `NOT_ENABLED`.
- **Registration window and capacity:** registration enabled requires a capacity (DB constraint). Registration is open from `registration_open_at` up to, but not including, `registration_close_at`; `registration_open_at = null` means registration opens immediately and `registration_close_at = null` means there is no deadline. `is_registration_enabled = false` returns `NOT_ENABLED`.
- **Attendee location:** list and detail return the name and address of the unique approved venue through the existing `venue_booking → room → venue` relationship. Pending, rejected and cancelled bookings are excluded. Multiple bookings at one venue count as one location. The current schema has no primary-venue marker: if approved bookings reference multiple venues, location remains `null` until the primary-venue model is available; discovery never chooses an arbitrary venue. No booking, room or venue IDs are returned.
- **Server-controlled fields** (`status`, `organiserId`, `requestId`, …) are never silently ignored: the two `POST` routes reject them with `400`, and the update routes (`PUT /api/events/:id`, `PUT /api/events/:id/draft`) with `403 FIELD_NOT_EDITABLE` (see SPM-33).
- **Status label and note:** organiser-facing responses carry `statusLabel` (`DRAFT` → "Draft", `SUBMITTED` → "Submitted", `UNDER_REVIEW` → "Under Review"; other states still return the stored code) (labels per Master section 3.5) and `statusNote`: "Waiting for a coordinator" while a submitted request has no coordinator, otherwise `null` (added by SPM-33; not yet listed in the Master).
- **`Idempotency-Key`:** 8–128 characters from `A-Z a-z 0-9 . _ : -`; a UUID per form submission works. Re-sending the same key and body returns the original result with an `Idempotent-Replayed: true` header and creates nothing new. Reusing a key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- **Drafts** need only a title. Other supplied values must still be valid, so a draft may enable registration before entering a capacity.
- **Submission** leaves the request unassigned in the Leads' queue (SPM-174) and writes the event, its activity record and the receipt notification for the organiser and active Coordinator Leads in one database transaction (`submit_event_request`). The database files the request under the organiser's organisation (see SPM-33). If the database rejects a submission, the `400` still carries field-level `fields`.
- **Assignment** (`POST /api/events/:id/coordinator`, Coordinator Lead only, requires `ENABLE_COORDINATOR_WORKFLOWS=true`) takes a request from the queue: in one transaction (`assign_event_coordinator`) it sets the coordinator, moves the request from `SUBMITTED` to `UNDER_REVIEW` (Master section 5.2), records the staff-only history entry `COORDINATOR_ASSIGNED` and notifies the organiser and the coordinator.
- **Paging:** pass `nextCursor` back as `cursor`; it is `null` on the last page.

Database changes are recorded under `supabase/migrations/`. Do not apply ad hoc schema SQL; apply reviewed migrations to the project-scoped development database and keep the local migration history aligned with the shared branch.

### Submission guarantees (SPM-36)

The agreed deployment has one Coordinator Lead. Submission saves against the
existing draft ID, enters `SUBMITTED` with no Coordinator, and notifies the owner
and that Lead. It succeeds even when no Coordinator is available. Assignment is
still the separate Lead action and enters `UNDER_REVIEW`.

Apply the reviewed migration
`supabase/migrations/20261019120000_spm36_submission_time_and_lead_receipt.sql`
before deploying this backend. It adds `event.submitted_at`, preserves the first
submission time on later updates, backfills only from recorded submission history,
and adds active Leads to the existing durable receipt's recipients in the same
transaction. Legacy events without submission evidence retain a null timestamp.
It has not been applied to shared development by this work item.

Event responses add `submittedAt` (ISO timestamp or null). The event detail read
also adds `coordinatorName` (name or null), without exposing the Coordinator's
other profile fields. The queue sorts by submission time, creation time and ID;
legacy entries without a known submission time follow dated entries. The existing
`event_assignments.assigned_by` records the assigning Lead; dedicated supervision
and handover modeling remains with the assignment stories.

Repeated draft submissions return `409 EVENT_NOT_DRAFT` without writing again;
the frontend retrieves the current event after a lost response or stale-tab retry.
The row lock, field/requirement changes, timestamp, history and notification
recipients commit or roll back together. Inbox UI (SPM-191), Organiser update
presentation (SPM-192), Coordinator assignment updates (SPM-193), and provider
email/SMS delivery remain separate notification dependencies.

See [the backend test plan](docs/test-plans/spm-36.md) for execution results,
commands and the isolated SQL test setup.

### Role-Scoped Event View, Direct Edits and History (SPM-33)

Any signed-in user may call these routes; what they get depends on their role **and** their relationship to the event. An event outside the user's viewing scope is always `404 EVENT_NOT_FOUND`, never `403`, so the response does not confirm that it exists.

| User | May view | May edit directly |
| --- | --- | --- |
| Organiser who owns the event | Always | Every draft field while `DRAFT`; nothing after submission (request a change, SPM-170) |
| Organiser in the same organisation | Once submitted, read-only | Never |
| Coordinator assigned to the event | Full coordination view, and history from submission onwards | `title`, `purpose`, `description` in `UNDER_REVIEW`, `PLANNING`, `SAFETY_REVIEW`, `CONFIRMED`, `PREPARATION` |
| Venue Staff, Technical Support, Coordinator Lead, Attendee, unassigned coordinator | Nothing through these routes | Never |

Same-organisation viewing relies on `event.organisation_id`. The database fills it in for every new request whose organiser belongs to exactly one organisation (trigger `event_default_organisation`, on insert and when a draft is submitted). An organiser with no membership keeps their requests to themselves. Migration `20261015112808_spm33_request_organisation_and_history_retention` backfilled existing requests.

| Method & path | Input | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/events/:id` | — | `200 { event }`. Adds `version`, `viewerRelationship` (`OWNER`, `ORGANISATION_MEMBER`, `ASSIGNED_COORDINATOR`) and `permissions: { canEdit, editableFields, canViewDraftHistory, canViewStaffHistory }`. The assigned coordinator also gets `coordinatorId` and `organiser: { userId, name }` | `401`, `404` |
| `PUT /api/events/:id` | Changed fields, `version` (the one loaded) and an `Idempotency-Key` header | `200 { message, event }`, plus `savedAt` for a draft | See below |
| `GET /api/events/:id/history` | `?limit=1..100` (default 50), `?cursor=<nextCursor>` | `200 { history: [{ historyId, action, actor: { userId, name, role }, occurredAt, summary, changes: [{ field, before, after }], audience }], nextCursor }`, newest first | `400`, `401`, `404` |

Saves are checked in this order, and a failed check changes nothing:

| Condition | Response |
| --- | --- |
| No session | `401 UNAUTHENTICATED` |
| Event outside the user's viewing scope | `404 EVENT_NOT_FOUND` |
| Owner edits after submission | `403 EDIT_REQUIRES_CHANGE_REQUEST` |
| Same-organisation organiser edits | `403 EVENT_READ_ONLY` |
| Status allows no direct edit (`SUBMITTED`, `AWAITING_CLARIFICATION`, `COMPLETED`, `REJECTED`, `CANCELLED`, or any other status not in the coordinator list) | `403 EVENT_NOT_EDITABLE_IN_STATUS` |
| Body contains an event field this user may not change (significant, registration or system fields) | `403 FIELD_NOT_EDITABLE` with `fields`; the whole request is rejected |
| Missing or invalid value, missing `version` or `Idempotency-Key`, unknown key | `400 VALIDATION_FAILED` with `fields` |
| Event changed since it was loaded | `409 EVENT_VERSION_CONFLICT` with the current `event` to review |
| `Idempotency-Key` reused with a different body | `409 IDEMPOTENCY_KEY_REUSED` |

- **Stale saves:** every change to an event raises its `version`. Send back the `version` you loaded; a save made against an older one is refused.
- **Retries:** re-sending the same request with the same `Idempotency-Key` returns the original result with `Idempotent-Replayed: true` and writes nothing new (no second history entry or notification). A retry that arrives after the user can no longer make that edit (the status changed, or the coordinator was reassigned) gets the `403` or `404` like any other edit, and nothing is saved twice; the client should reload the event to see whether the first attempt was saved. On `PUT /api/events/:id/draft` both `version` and the key are optional, so existing clients keep working.
- **Draft route alignment:** `PUT /api/events/:id/draft` now answers `403 EDIT_REQUIRES_CHANGE_REQUEST` (it used to be `409 EVENT_NOT_DRAFT`) when the request is no longer a draft, and `403 EVENT_READ_ONLY` to a same-organisation organiser. `PUT /api/events/:id/submit` still answers `409 EVENT_NOT_DRAFT`.
- **History:** every manual draft save and coordinator edit adds an entry with the actor, their role and the before/after values; auto-saves and failed saves add none. Each entry has one audience, and the filter is applied in the database query:

  | `audience` | Entries | Owner | Same-organisation organiser | Assigned coordinator |
  | --- | --- | --- | --- | --- |
  | `OWNER_ONLY` | Recorded while the request was a draft (`DRAFT_CREATED`, `DRAFT_UPDATED`) | Yes | No | No |
  | `ORGANISER_SAFE` | Submission and coordinator edits | Yes | Yes | Yes |
  | `STAFF_ONLY` | Assignment and reassignment records, and anything not classified | No | No | Yes |

  Nobody but the owner could see the draft, so nobody else may read what it used to say. Entries cannot be changed or removed: there is no route for it and the backend's database role has no `UPDATE`, `DELETE` or `TRUNCATE` on `activity_log`. Deleting a profile that wrote history entries is refused (`ON DELETE RESTRICT`); deactivate the profile instead.
- **History format for other tickets:** when a database function inserts into `activity_log` without the new columns, a trigger fills `actor_role` from the user's role and sets `audience` to `STAFF_ONLY`, unless the action is a known draft or organiser-safe one. To show an entry to organisers, pass `audience => 'ORGANISER_SAFE'` and a `changes` object keyed by API field name (`{ "title": { "before": ..., "after": ... } }`).
- **Notification:** when the assigned coordinator's edit changes something, the owner gets one in-app notification ("Event details updated", type `STATUS_CHANGE`) written in the same transaction. It names the changed fields, not their values. Draft saves, unchanged saves, failed saves and retries send none.
- **Coordinator statuses:** the list follows the Master 1.0 lifecycle (section 5.2): `SUBMITTED` is excluded because an event in it has no coordinator, and there is no `APPROVED` state. `SAFETY_REVIEW` and `PREPARATION` are not in the live `event_status` enum yet, so they take effect once that migration lands. The list is one constant, `COORDINATOR_EDITABLE_STATUSES` in `config/eventConstants.js`, passed to the database function, so changing it needs no migration.

### Authentication (SPM-32)

The browser signs in **directly with Supabase Auth** (`supabase.auth.signInWithPassword`), so Supabase's per-IP sign-in limit applies to each user's own IP. It then calls `GET /api/auth/me` with the access token. On `200` it redirects to `user.home_path`; on `401` (no active ConnectSphere profile) it signs out again. The backend never receives passwords.

Errors use one shape: `{ "error": "<safe message>", "code": "<MACHINE_CODE>" }`, plus `fields` for validation errors. Authenticated requests send `Authorization: Bearer <access_token>`, and their responses carry `Cache-Control: no-store`. Only `FRONTEND_ORIGIN` may call the API from a browser.

| Method & path                 | Access               | Input                                            | Success                                                                                                                                                                                                     | Errors                                                                                      |
| ----------------------------- | -------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/auth/me`            | Any signed-in user   | —                                                | `200 { user: { user_id, email, name, role, roles, home_path } }`                                                                                                                                            | `401 UNAUTHENTICATED` (missing, invalid, expired or logged-out token, or no active profile) |
| `POST /api/auth/logout`       | Bearer token, if any | —                                                | `204`; revokes this device's session (access and refresh token). The browser should then call `supabase.auth.signOut({ scope: "local" })`                                                                   | — (idempotent)                                                                              |
| `GET /api/events/mine`        | `ORGANISER`          | See Event Requests above                         | Own requests plus submitted requests from the organiser's organisations; colleagues' drafts are never listed                                                                                                | `400 VALIDATION_FAILED`, `401`, `403 FORBIDDEN`                                             |
| `GET /api/registrations/mine` | `ATTENDEE`           | `?limit=1..100` (default 50), `?offset=0..10000` | `200 { registrations: [{ registration_id, registration_status, registered_at, event: { event_id, title, description, start_datetime, end_datetime, attendee_status, venue } }], page }`, attendee-safe only | `400`, `401`, `403 FORBIDDEN`                                                               |

- `home_path` is `/dashboard` for organisers and staff and `/my-registrations` for attendees.
- `roles` is a list so the contract survives multi-role users; the schema currently stores one role per user.
- `attendee_status` is a display value: `CONFIRMED`, `COMPLETED`, `CANCELLED`, or `PENDING_CONFIRMATION` for any internal planning state. It is not an event state.
- `next_offset` is `null` on the last page of registrations.
- Roles and organisation memberships always come from the database, never from the request or token metadata.

### Sign-Up (SPM-123)

Prospective attendees and event organisers create their own accounts. Staff roles (`COORDINATOR`, `VENUE_STAFF`, `TECH_SUPPORT`) are never self-registered.

| Method & path | Access | Input | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /api/auth/signup` | Public; at most 5 attempts per IP per 15 minutes | `{ "accountType": "ATTENDEE" | "ORGANISER", "name", "email", "password" }`, no other fields | `201 { message, user: { user_id, email, name, role, roles, home_path } }`. No session: the browser then signs in with `supabase.auth.signInWithPassword` as for login | `400 VALIDATION_FAILED` with `fields` (missing fields, invalid email, weak password, staff or unknown `accountType`, any extra field such as `role`), `409 EMAIL_UNAVAILABLE` (`"The email cannot be used for registration."`), `429 RATE_LIMITED` |

- **Field rules:** `name` 1–100 characters; `email` a valid address of up to 150 characters, stored lowercase; `password` 8–72 characters with at least one letter and one number. The `400` message for a weak password states these rules.
- **Duplicate emails** get the same `409` whether the email belongs to an account, differs only in letter case, or matches a profile not yet linked to Auth, so the response never confirms that an account exists.
- **Accounts are usable immediately.** New accounts are created already confirmed and no verification email is sent. The current SPM-123 ticket has five ACs and does not require email verification; older AC6–AC8 references are superseded.
- **Consistency:** Supabase Auth and the `user` table cannot share a transaction. The Auth account is created first, marked in `app_metadata.signup_account_type`; if the profile insert then fails, the Auth account is deleted again. A marked Auth account left without a profile (e.g. after a crash) is removed and recreated when the same email signs up again more than two minutes later.
- **Organisers** start without an organisation membership, so `GET /api/events/mine` shows only their own requests.
- **Behind a proxy** (production), set Express `trust proxy` so the rate limit counts each client's IP rather than the proxy's.

---

## 🧪 Example `.env` File

Create a `.env` file in the root directory:

```bash
PORT=8000
SUPABASE_URL=https://rvwiflsedoujspmzfrbq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only-key>
# Optional
FRONTEND_ORIGIN=http://localhost:3000   # the only browser origin allowed by CORS (default shown)
SUPABASE_ANON_KEY=<anon/publishable key>  # tests sign in with it like the browser; falls back to the service role key
SEED_ACCOUNT_PASSWORD=<private password for seeded dev accounts, 12+ characters>
SEED_NAMESPACE=dev                         # prefix for seeded emails and organisation names
SIGNUP_RATE_LIMIT_MAX=5                    # sign-up attempts per IP per 15 minutes (default 5; tests raise it)
```

The code does not read `SUPABASE_PUBLIC_KEY`; name the anon/publishable key `SUPABASE_ANON_KEY`.

---

## 👤 Development Accounts

Nobody can log in until an Auth account is linked to an active profile (`user.auth_user_id`). To create one synthetic account per role, plus two organisations (organisers A and B belong to different ones):

```bash
npm run seed:accounts           # idempotent; re-running resets passwords to SEED_ACCOUNT_PASSWORD
npm run seed:accounts:cleanup   # removes exactly what supabase/seed/manifests/ lists
```

Accounts are `<SEED_NAMESPACE>-<organiser-a|organiser-b|coordinator|venue-staff|tech-support|attendee>@connectsphere.test`. The `.test` domain is undeliverable, so no email is ever sent.

The five pre-existing `user` rows are not linked to Auth accounts. To link one, its owner creates the Auth user in the Supabase dashboard (**Authentication → Users → Add user**, with **Auto Confirm** on) using the profile's email, then sets that row's `auth_user_id` to the new user's ID. Never edit `auth.*` tables with SQL.

---

## ✅ Testing

```bash
npm test                  # unit tests (no network; Supabase is mocked)
npm run test:integration  # live tests against the Supabase development project in .env
npm run test:cleanup      # removes fixtures left by an interrupted integration run
```

Integration tests create namespaced synthetic Auth accounts (`spm32-<run>-…` and, for sign-up, `spm123-<run>-…@connectsphere.test`) through the Auth Admin API, sign in with Supabase Auth as the browser does, and call the backend with the resulting token. Each created ID is recorded in `tests/fixtures/manifests/` (git-ignored), and the run removes exactly those records afterwards. Cleanup then verifies that nothing it created remains.

Supabase Auth rate-limits password sign-ins per IP. The suite reuses one session per role and makes about 20 sign-ins, so wait about 5 minutes between consecutive integration runs. A run started too soon fails with `Sign-in for <role> failed: 429`.

Test names follow `[<Jira test case or domain ID>] should_<behaviour>_when_<condition>`, e.g. `[TC-LOGIN-013] should_reject_the_access_token_immediately_when_user_logs_out`.

`tests/integration/events.integration.test.js` exercises the event request RPCs end to end, including parallel submissions and idempotent replays. It needs migration `20261007075542_event_request_review_fixes` applied to the development project.

`tests/integration/eventEdits.integration.test.js` covers SPM-33 (TC-01 to TC-21, two parallel saves, and an edit racing a reassignment). It needs the four SPM-33 migrations (`spm33_event_edit_history`, `spm33_owner_history_and_edit_notice`, `spm33_request_organisation_and_history_retention`, `spm33_assignment_enters_under_review`) and the `reassign_event_coordinator` function (SPM-180) in the development project. Cleanup deletes everything a run created except the profiles that wrote history entries: those stay, deactivated and without an Auth account, because history is never deleted.

---

## 🗄️ Database Migrations

Schema changes live in `supabase/migrations/<version>_<name>.sql`. The version matches the one recorded in the remote migration history. Add the SQL file first, review it, then apply it to the development project. Never edit an applied migration; add a corrective one.

---

## ✅ Commit Message Format

This project follows a structured commit message format for consistency.

Please refer to the `COMMIT_MESSAGES.md` file in the root directory for details.

---

## 📁 connectsphere-events-g8t6-backend File Structure

```bash
connectsphere-events-g8t6-backend/
├── app.js                 # Express app and middleware composition
├── config/               # External service configurations (Supabase) and shared constants
│   ├── eventConstants.js # Event statuses and the SPM-33 field edit matrix
│   ├── roles.js
│   └── supabase.js
├── controller/           # Route handler logic and controllers
│   ├── authController.js
│   ├── eventController.js
│   └── registrationController.js
├── middleware/           # Request/response middleware functions
│   ├── auth.js           # Verifies the Supabase access token and loads the profile
│   ├── authorize.js      # Role checks, the event access policy and requireVisibleEvent (404 outside viewing scope)
│   ├── errorHandler.js   # Safe responses for unhandled errors
│   ├── rateLimit.js      # Per-IP limit for sign-up attempts
│   └── validate.js       # Offset and cursor pagination bounds, event ID parsing
├── model/                # Data models and logic
│   ├── activityModel.js  # Audience-filtered change history
│   ├── eventModel.js
│   ├── healthModel.js
│   ├── registrationModel.js
│   └── userModel.js
├── routes/               # API route definitions
│   ├── authRoutes.js
│   ├── eventRoutes.js
│   ├── registrationRoutes.js
│   └── routers.js
├── supabase/
│   ├── migrations/       # Versioned schema changes
│   └── seed/             # Development account provisioning
├── tests/
│   ├── fixtures/         # Synthetic data setup and cleanup
│   ├── integration/      # Live tests against the development project
│   └── unit/             # Mocked Supabase; run by npm test
├── validators/           # Pure request validation rules
│   ├── authValidator.js
│   └── eventValidator.js
├── COMMIT_MESSAGES.md    # Commit message SOP standards
├── README.md             # Backend documentation
└── server.js             # Main server entry point
```

---

## 🌿 Branching Strategy & Standard Operating Procedure (SOP)

To maintain clean repository history and smooth collaboration, follow these branching rules:

### Branch Naming Convention

Format: `<type>/<ticket-id>-<short-description>` or `<type>/<short-description>`

- **`feature/`**: For new features or updates (e.g., `feature/SPM-55-backend-boilerplate` or `feature/user-authentication`)
- **`fix/`** or **`bugfix/`**: For bug fixes (e.g., `fix/SPM-58-cors-issue` or `fix/auth-middleware`)
- **`refactor/`**: For code refactoring without behavior changes (e.g., `refactor/route-handlers`)
- **`docs/`**: For documentation updates (e.g., `docs/update-readme`)
- **`chore/`**: For maintenance, dependency updates, or config changes (e.g., `chore/env-setup`)

### Branching Workflow (SOP)

1. **Pull the latest changes** from the main development branch before creating a new branch:
   ```bash
   git checkout main
   git pull origin main
   ```
### SPM-174 development fixture

After applying the Supabase migrations and provisioning the namespaced accounts, create a
synthetic submitted request with no coordinator:

```bash
npm run seed:unassigned
```

The fixture is recorded in `supabase/seed/manifests/` (ignored by git) and can be removed
without affecting other data:

```bash
npm run seed:unassigned:cleanup
```


## Completed-ticket repair baseline

See `docs/main-repair-baseline.md` for scope, removed entrypoints and AC evidence.
Existing event write/validation contracts are preserved. Request creation gains
an organiser-only, read-only `GET /api/events/request-options` response containing
`venues: [{ venueId, name }]` and `layouts: [layoutType]`; it creates no holds.

Lead queue/assignment/reassignment endpoints exist only when
`ENABLE_COORDINATOR_WORKFLOWS=true`; unset or any other value returns 404. Shared
development sets it to `true` (see `.env.example`) because SPM-33's coordinator
view and edits need assigned events. The coordinator's own assigned-event read
remains part of SPM-32 and is always available.

`npm test` runs all unit suites. Real auth/signup can be checked separately:

```sh
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/integration/auth.integration.test.js tests/integration/signup.integration.test.js
```

The full `npm run test:integration` event/reassignment suites also require
TEST_DATABASE_URL: a privileged test-only PostgreSQL connection to the same
isolated database as SUPABASE_URL. Supply it only to the test command, never the
application runtime. Their preflight checks permissions before creating fixtures.
Cleanup deletes audit rows only for the manifest's numeric user IDs whose email
also matches the exact synthetic run prefix. The application retains append-only
audit grants. With no privileged test connection, those suites are blocked;
ordinary auth/signup tests do not require audit-log deletion.

For an IPv4-only network, copy the Session pooler URI from Supabase's Connect
panel; use its supplied hostname and username. For verified TLS, download the
CA certificate from Database Settings > SSL Configuration and configure the
private test URI with `sslmode=verify-full` and `sslrootcert` pointing to that
local file. Keep the password and completed URI out of Git and browser code.
The variable name does not make a shared project an isolated test database.

Do not delete applied migration files or reset the shared database to remove
pending UI features. Current live assignment transitions to UNDER_REVIEW.
The full integration run passed 81 tests against the configured development
database; reconstruction from local migration history remains a separate check.
