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

### Authentication (SPM-32)

Errors use one shape: `{ "error": "<safe message>", "code": "<MACHINE_CODE>" }`, plus `fields` for validation errors. Authenticated requests send `Authorization: Bearer <access_token>`, and their responses carry `Cache-Control: no-store`.

| Method & path | Access | Input | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /api/auth/login` | Public | `{ "email", "password" }`, no other fields | `200 { session: { access_token, refresh_token, token_type, expires_in, expires_at }, user: { user_id, email, name, role, home_path } }` | `400 VALIDATION_FAILED` with `fields`, `400 UNKNOWN_FIELDS`, `401 INVALID_CREDENTIALS` (same for unknown email, wrong password or inactive profile), `429 RATE_LIMITED` |
| `GET /api/auth/me` | Any signed-in user | — | `200 { user }` with the same shape as login | `401 UNAUTHENTICATED` (missing, expired or logged-out token) |
| `POST /api/auth/logout` | Bearer token, if any | — | `204`; revokes this device's session (access and refresh token) | — (idempotent) |
| `GET /api/events` | `ORGANISER` | — | `200 { events: [{ event_id, title, status, start_datetime, end_datetime, expected_attendance, organisation, is_owner, created_at, updated_at }] }`: own requests plus submitted requests from the organiser's organisations | `401`, `403 FORBIDDEN` for other roles |
| `GET /api/registrations/mine` | `ATTENDEE` | — | `200 { registrations: [{ registration_id, registration_status, registered_at, event: { event_id, title, description, start_datetime, end_datetime, status, venue } }] }`, attendee-safe only | `401`, `403 FORBIDDEN` for other roles |

`home_path` is `/dashboard` for organisers and staff and `/my-registrations` for attendees. Roles and organisation memberships always come from the database, never from the request or token metadata.

---

## 🧪 Example `.env` File

Create a `.env` file in the root directory:

```bash
PORT=8000
SUPABASE_URL=https://rvwiflsedoujspmzfrbq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key from the Supabase dashboard; never commit it>
```

---

## ✅ Testing

```bash
npm test                  # unit tests (no network; Supabase is mocked)
npm run test:integration  # live tests against the Supabase development project in .env
npm run test:cleanup      # removes fixtures left by an interrupted integration run
```

Integration tests create namespaced synthetic Auth accounts (`spm32-<run>-…@connectsphere.test`) through the Auth Admin API. Each created ID is recorded in `tests/fixtures/manifests/` (git-ignored), and the run removes exactly those records afterwards.

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
│   └── validate.js       # Body allowlisting and field validation
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
│   └── migrations/       # Versioned schema changes
├── tests/
│   ├── fixtures/         # Synthetic data setup and cleanup
│   ├── integration/
│   └── unit/
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
