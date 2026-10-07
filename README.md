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

### Event Requests (SPM-35, SPM-37)

All event routes require an `ORGANISER` bearer token and use the error shape described under Authentication below. Request and response fields are camelCase.

| Method & path | Input | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/events` | Event fields; `Idempotency-Key` header | `201 { message, event }`, status `SUBMITTED` | `400 VALIDATION_FAILED`, `409 NO_ELIGIBLE_COORDINATOR`, `409 IDEMPOTENCY_KEY_REUSED` |
| `POST /api/events/drafts` | Any event fields, `title` required; `Idempotency-Key` header | `201 { message, event, savedAt }`, status `DRAFT` | `400`, `409 IDEMPOTENCY_KEY_REUSED` |
| `PUT /api/events/:id/draft` | Changed fields, plus `"isAutoSave": true` from the idle timer | `200 { message, event, savedAt }`; auto-saves skip the activity log | `400`, `404 EVENT_NOT_FOUND`, `409 EVENT_NOT_DRAFT` |
| `PUT /api/events/:id/submit` | Final edits or `{}` | `200 { message, event }`, status `SUBMITTED` | `400` (draft unchanged), `404`, `409 EVENT_NOT_DRAFT`, `409 NO_ELIGIBLE_COORDINATOR` |
| `GET /api/events/:id` | — | `200 { event }` with `isOwner` | `404 EVENT_NOT_FOUND` (missing, another organiser's, or a colleague's draft) |
| `GET /api/events/mine` | `?status=<event status>`, `?limit=1..100` (default 50), `?cursor=<nextCursor>` | `200 { events: [{ eventId, requestId, status, statusLabel, title, startDatetime, endDatetime, expectedAttendance, organisation, isOwner, createdAt, updatedAt }], nextCursor }`, newest edit first | `400 VALIDATION_FAILED` (including `offset`, which this list does not accept) |

- **Event fields:** `title` (≤ 200 chars), `purpose` (≤ 2000), `description` (≤ 5000), `startDatetime` and `endDatetime` (ISO 8601 **with** a timezone offset, e.g. `2026-10-08T09:00:00+08:00`), `expectedAttendance` (positive whole number), `preferredLayoutType` (an existing room layout or `NO_PREFERENCE`), `accessibilityNeeds` (up to 20 short strings), `isRegistrationEnabled`, `registrationCapacity`, `venuePreferences` (ordered venue IDs) and `equipmentRequirements` (`[{ "equipmentId": number, "quantity": number }]`). Numeric strings are accepted for numbers.
- **Server-controlled fields** (`status`, `organiserId`, `requestId`, …) are rejected with `400`, never silently ignored.
- **`Idempotency-Key`:** 8–128 characters from `A-Z a-z 0-9 . _ : -`; a UUID per form submission works. Re-sending the same key and body returns the original result with an `Idempotent-Replayed: true` header and creates nothing new. Reusing a key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- **Drafts** need only a title. Other supplied values must still be valid, so a draft may enable registration before entering a capacity.
- **Submission** assigns an active coordinator by round robin and writes the event, activity record and two notifications (one to the organiser, one to the coordinator) in one database transaction (`submit_event_request`). If the database rejects a submission, the `400` still carries field-level `fields`.
- **Paging:** pass `nextCursor` back as `cursor`; it is `null` on the last page.

Database changes are recorded under `supabase/migrations/`. Do not apply ad hoc schema SQL; apply reviewed migrations to the project-scoped development database and keep the local migration history aligned with the shared branch.

### Authentication (SPM-32)

The browser signs in **directly with Supabase Auth** (`supabase.auth.signInWithPassword`), so Supabase's per-IP sign-in limit applies to each user's own IP. It then calls `GET /api/auth/me` with the access token. On `200` it redirects to `user.home_path`; on `401` (no active ConnectSphere profile) it signs out again. The backend never receives passwords.

Errors use one shape: `{ "error": "<safe message>", "code": "<MACHINE_CODE>" }`, plus `fields` for validation errors. Authenticated requests send `Authorization: Bearer <access_token>`, and their responses carry `Cache-Control: no-store`. Only `FRONTEND_ORIGIN` may call the API from a browser.

| Method & path | Access | Input | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /api/auth/me` | Any signed-in user | — | `200 { user: { user_id, email, name, role, roles, home_path } }` | `401 UNAUTHENTICATED` (missing, invalid, expired or logged-out token, or no active profile) |
| `POST /api/auth/logout` | Bearer token, if any | — | `204`; revokes this device's session (access and refresh token). The browser should then call `supabase.auth.signOut({ scope: "local" })` | — (idempotent) |
| `GET /api/events/mine` | `ORGANISER` | See Event Requests above | Own requests plus submitted requests from the organiser's organisations; colleagues' drafts are never listed | `400 VALIDATION_FAILED`, `401`, `403 FORBIDDEN` |
| `GET /api/registrations/mine` | `ATTENDEE` | `?limit=1..100` (default 50), `?offset=0..10000` | `200 { registrations: [{ registration_id, registration_status, registered_at, event: { event_id, title, description, start_datetime, end_datetime, attendee_status, venue } }], page }`, attendee-safe only | `400`, `401`, `403 FORBIDDEN` |

- `home_path` is `/dashboard` for organisers and staff and `/my-registrations` for attendees.
- `roles` is a list so the contract survives multi-role users; the schema currently stores one role per user.
- `attendee_status` is a display value: `CONFIRMED`, `COMPLETED`, `CANCELLED`, or `PENDING_CONFIRMATION` for any internal planning state. It is not an event state.
- `next_offset` is `null` on the last page of registrations.
- Roles and organisation memberships always come from the database, never from the request or token metadata.

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

Integration tests create namespaced synthetic Auth accounts (`spm32-<run>-…@connectsphere.test`) through the Auth Admin API, sign in with Supabase Auth as the browser does, and call the backend with the resulting token. Each created ID is recorded in `tests/fixtures/manifests/` (git-ignored), and the run removes exactly those records afterwards. Cleanup then verifies that nothing it created remains.

Supabase Auth rate-limits password sign-ins per IP. The suite reuses one session per role and makes about 20 sign-ins, so wait about 5 minutes between consecutive integration runs. A run started too soon fails with `Sign-in for <role> failed: 429`.

Test names follow `[<Jira test case or domain ID>] should_<behaviour>_when_<condition>`, e.g. `[TC-LOGIN-013] should_reject_the_access_token_immediately_when_user_logs_out`.

`tests/integration/events.integration.test.js` exercises the event request RPCs end to end, including parallel submissions and idempotent replays. It needs migration `20261007075542_event_request_review_fixes` applied to the development project.

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
│   ├── roles.js
│   └── supabase.js
├── controller/           # Route handler logic and controllers
│   ├── authController.js
│   ├── eventController.js
│   └── registrationController.js
├── middleware/           # Request/response middleware functions
│   ├── auth.js           # Verifies the Supabase access token and loads the profile
│   ├── authorize.js      # Role checks
│   ├── errorHandler.js   # Safe responses for unhandled errors
│   └── validate.js       # Offset and cursor pagination bounds
├── model/                # Data models and logic
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
