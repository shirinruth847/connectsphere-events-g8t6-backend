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

### Event Requests

All event routes require an authenticated organiser and use the bearer access token.

- `POST /api/events` creates and submits a request.
- `POST /api/events/drafts` creates a draft; `PUT /api/events/:id/draft` saves changes.
- `PUT /api/events/:id/submit` submits a saved draft.
- `GET /api/events/:id` loads an organiser-owned request.
- `GET /api/events/mine` lists organiser-owned requests. Optional `status`, `limit` (1-50, default 20), and opaque `cursor` parameters provide bounded pagination.

Submissions assign an active coordinator and write the event, activity record, notification, and recipients in one database transaction. Optional `venuePreferences` is an ordered array of venue IDs; `equipmentRequirements` is an array of `{ "equipmentId": number, "quantity": number }` objects.

Database changes are recorded under `supabase/migrations/`. Do not apply ad hoc schema SQL; apply reviewed migrations to the project-scoped development database and keep the local migration history aligned with the shared branch.

### Tests

Run the backend unit and startup smoke tests with:

```bash
npm test -- --runInBand
```
{
  "message": "App is working well"
}
```

---

## 🧪 Example `.env` File

Create a `.env` file in the root directory:

```bash
# Required to run the app
PORT=8000
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only-key>
```

Keep Supabase keys private and out of source control. The service-role key is server-only.

---

## ✅ Commit Message Format

This project follows a structured commit message format for consistency.

Please refer to the `COMMIT_MESSAGES.md` file in the root directory for details.

---

## 📁 connectsphere-events-g8t6-backend File Structure

```bash
connectsphere-events-g8t6-backend/
├── app.js                 # Express app and middleware composition
├── config/               # External service configurations (Supabase)
│   └── supabase.js 
├── controller/           # Route handler logic and controllers
│   └── authController.js
├── middleware/           # Request/response middleware functions
│   ├── auth.js
│   └── errorHandler.js
├── model/                # Data models and logic
│   ├── eventModel.js
│   └── healthModel.js
├── routes/               # API route definitions
│   ├── authRoutes.js
│   ├── eventRoutes.js
│   └── routers.js
├── supabase/migrations/  # Versioned database changes
├── tests/                # Unit and startup smoke tests
├── validators/           # Request validation rules
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
