# ConnectSphere — Application Architecture Master

| Document field | Value |
| --- | --- |
| Version | 0.8 |
| Updated | 7 October 2026 |
| Status | Architecture and implementation baseline; repository verification required per ticket |
| Application style | Next.js frontend with one JavaScript/Express modular-monolith backend |
| Repositories | `connectsphere-g8t6` (frontend) and `connectsphere-events-g8t6-backend` (backend) |
| Data platform | Supabase PostgreSQL and Supabase Auth; MongoDB Atlas for venue and equipment detail |
| Canonical copy | Backend repository; frontend consumes an accessible synchronized copy |

This document gives developers and coding agents the durable context needed to build ConnectSphere. It defines the repository layout, architectural boundaries, roles, business rules, data ownership, workflow guarantees, test expectations and agent workflow.

This document intentionally does **not** define a route-by-route API contract, request/response payload catalogue, OpenAPI specification or deployment/runtime architecture. Ticket acceptance criteria, implemented route definitions and tests determine the transport details for each feature. When a ticket changes an enduring business rule or structure, update this master in the same work item.

## 1. Architecture Decision

ConnectSphere is a **modular monolith**, not a microservices system.

- The browser application is a separate Next.js repository.
- All business operations are handled by one Node.js/Express backend application.
- The backend is started from `server.js` and is organized using the existing `routes`, `controller`, `middleware`, `model` and `config` layers.
- Business data lives in two stores, and only the backend connects to either of them:
  - **Supabase PostgreSQL** is the system of record for workflow state, allocation, audit and every rule that must hold atomically. All PostgreSQL work for one operation can share one database transaction.
  - **MongoDB Atlas** holds descriptive venue and equipment detail used for search, suitability warnings and display. MongoDB writes never take part in a PostgreSQL transaction; they are applied after commit (section 7.3).
- Supabase Auth provides identity. The backend remains the authority for application roles, relationships, workflow state and business-data writes.
- Business areas, including booking conflict detection and the operational safety check, are code modules inside the same backend process. Do not create independently deployed services, service-to-service APIs, further databases or message brokers unless a future approved architecture decision requires them.

The two repositories are a source-code ownership boundary, not a microservice boundary. The Next.js frontend is a client of the single backend monolith.

### 1.1 Confirmed technology baseline

| Area | Confirmed baseline | Agent instruction |
| --- | --- | --- |
| Frontend | Next.js App Router, React, TypeScript, `next/font`, Geist | Follow the installed versions in `package.json` and the lockfile. Do not replace Next.js with Vite or a generic SPA layout. |
| Backend | Node.js, Express-style routing, JavaScript files (CommonJS), nodemon development command | Preserve the JavaScript and folder conventions in the backend README. The backend stays JavaScript (M2); a TypeScript migration requires an approved ticket. |
| Database | Supabase PostgreSQL | Keep schema changes versioned in the backend repository before applying them to the shared development project. |
| Detail store | MongoDB Atlas, shared cluster `spm.ldi4ulx.mongodb.net` (`appName=SPM`), native `mongodb` driver (M1) | Only the backend connects. Collections, validators and indexes change only through versioned scripts in the backend repository (section 6.4). |
| Identity | Supabase Auth | Passwords and login identities remain Auth-managed; application profiles and roles remain business data. |
| Notification delivery | In-app notifications in PostgreSQL; email and SMS through external providers (M5, M6) | Delivery is sent only after commit, from the delivery queue (section 8). |
| Local ports | Frontend `3000`; backend `8000` | The frontend's configured backend base URL must target port `8000` locally. |
| Package manager | npm is the documented common path | Use the checked-in lockfile. Do not regenerate it with a different package manager without team approval. |

Exact library versions and available scripts come from each repository's `package.json` and lockfile. README examples describe the baseline but do not override executable repository configuration.

### 1.2 Architectural boundaries

| Boundary | Responsibility |
| --- | --- |
| Next.js pages and components | Presentation, navigation, form state, accessible feedback and calls to the backend |
| Backend routes | Map HTTP requests to the correct controller and attach middleware; no business workflow logic |
| Backend controllers | Validate and normalize request input, invoke model/domain operations and translate outcomes to safe responses |
| Backend middleware | Authentication, authorization context, request-level checks and shared request behavior |
| Backend models | PostgreSQL and MongoDB access, domain state changes, transactional checks and persistence rules |
| Backend jobs | Scheduled internal work (expiry, completion, MongoDB sync, notification delivery) that calls model operations |
| Backend configuration | Construct external clients and read validated environment configuration |
| PostgreSQL | Durable state, referential integrity, uniqueness, conflict prevention, transaction isolation and the sync/delivery queues |
| MongoDB Atlas | Descriptive venue and equipment documents; never consulted by a blocking rule check |
| Supabase Auth | Signup, login, token issuance, refresh and Auth-user lifecycle |
| Email and SMS providers | External delivery of notifications already committed in PostgreSQL |

Never put privileged database credentials, authorization decisions or scarce-resource allocation logic in browser code. Never use Next.js API routes to duplicate the core Express backend. A Next.js route handler may be introduced only for a documented frontend-specific need and must not become a second business backend.

### 1.3 C4 model alignment

The team's C4 diagrams must describe this architecture. At container level:

| Container or system | Technology | Notes |
| --- | --- | --- |
| Web Application | Next.js / React / TypeScript | Role-based views for all seven roles |
| Backend API | Node.js / Express / JavaScript | Contains booking conflict detection and the safety check as components, not as separate containers |
| Main Database | Supabase PostgreSQL | System of record, including holds, bookings, availability, reservations, assignments, safety reviews, notifications and audit |
| Catalogue Detail Store | MongoDB Atlas | `venue_details` and `equipment_details` collections in one database; may be drawn as two containers only if labelled as collections of the same database |
| Supabase Auth | External system | Identity provider |
| Email Service, SMS Service | External systems | Receive committed notifications from the backend |

The venue availability calendar is computed from PostgreSQL and must not be shown as stored in MongoDB. Booking conflict detection and the safety check belong in a component diagram of the Backend API.

## 2. Repository Structure and Developer Setup

The structures in this section are the source of truth for code placement. “Current” reflects the repository READMEs supplied to the team. “Target” expands those same structures for ConnectSphere features; it does not replace them with a different architecture.

### 2.1 Backend: README-confirmed baseline

```text
connectsphere-events-g8t6-backend/
├── config/
│   └── supabase.js
├── controller/
│   └── authController.js
├── middleware/
│   └── auth.js
├── model/
│   └── healthModel.js
├── routes/
│   ├── authRoutes.js
│   └── routers.js
├── COMMIT_MESSAGES.md
├── README.md
└── server.js
```

`server.js` is the application entry point. `routes/routers.js` is the central route composition point. `config/supabase.js` owns Supabase client configuration. Existing authentication work remains in `authRoutes.js`, `authController.js` and `middleware/auth.js`.

### 2.2 Backend: target expansion

Add new functionality inside the existing top-level layers. The following is the target organization; create a listed file only when the associated feature is implemented.

```text
connectsphere-events-g8t6-backend/
├── config/
│   ├── supabase.js
│   └── mongodb.js
├── controller/
│   ├── authController.js
│   ├── eventController.js
│   ├── venueController.js
│   ├── equipmentController.js
│   ├── registrationController.js
│   ├── changeRequestController.js
│   ├── notificationController.js
│   ├── activityController.js
│   └── safetyController.js
├── jobs/
│   ├── runner.js
│   ├── holdExpiryJob.js
│   ├── eventCompletionJob.js
│   ├── waitlistOfferExpiryJob.js
│   ├── mongoSyncJob.js
│   └── notificationDeliveryJob.js
├── middleware/
│   ├── auth.js
│   ├── authorize.js
│   ├── errorHandler.js
│   └── validate.js
├── model/
│   ├── healthModel.js
│   ├── userModel.js
│   ├── eventModel.js
│   ├── venueModel.js
│   ├── venueConflictModel.js
│   ├── venueDetailModel.js
│   ├── equipmentModel.js
│   ├── equipmentDetailModel.js
│   ├── registrationModel.js
│   ├── changeRequestModel.js
│   ├── notificationModel.js
│   ├── activityModel.js
│   ├── outboxModel.js
│   └── safetyModel.js
├── mongodb/
│   ├── schemas/
│   ├── migrations/
│   └── seed/
├── routes/
│   ├── authRoutes.js
│   ├── eventRoutes.js
│   ├── venueRoutes.js
│   ├── equipmentRoutes.js
│   ├── registrationRoutes.js
│   ├── changeRequestRoutes.js
│   ├── notificationRoutes.js
│   ├── activityRoutes.js
│   ├── safetyRoutes.js
│   └── routers.js
├── supabase/
│   ├── migrations/
│   └── seed/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── COMMIT_MESSAGES.md
├── README.md
├── package.json
├── package-lock.json
└── server.js
```

The `supabase`, `mongodb`, `jobs` and `tests` directories are controlled extensions needed for database change history, scheduled internal work and repeatable verification. If the repositories already use different names when this document is adopted, retain the established names and update this tree rather than creating duplicates.

### 2.3 Backend placement rules

- `server.js` configures Express, shared middleware, route mounting, error handling, startup and shutdown. It must not contain feature SQL, MongoDB queries or workflow rules.
- `routes/*.js` declare route paths and middleware order. Route files must remain thin.
- `controller/*.js` deal with transport input and output. A controller must not trust actor IDs or roles supplied by the request body.
- `model/*.js` own database queries and domain changes. Cross-domain changes must share one PostgreSQL transaction/client rather than opening unrelated writes.
- `venueDetailModel.js` and `equipmentDetailModel.js` are the only files that query MongoDB. Every other model reaches MongoDB through them. They read documents and apply outbox entries; they never decide a blocking rule.
- `venueConflictModel.js` holds booking conflict detection: occupied-range calculation, overlap and block checks, overdue-hold expiry and the buffer-change scan. `safetyModel.js` holds the operational safety check. Both are modules, not services.
- `jobs/*.js` run scheduled internal work. A job claims work with a durable lease and calls model operations; it contains no business rules of its own. `jobs/runner.js` is started from `server.js` and exposes no HTTP trigger.
- `middleware/auth.js` verifies the Supabase access token and establishes the authenticated identity.
- `middleware/authorize.js` applies role and relationship policies after authentication. Hiding a frontend button is not authorization.
- `config/supabase.js` and `config/mongodb.js` read private server environment values and construct their clients once at startup. They must not export credentials to the frontend or log them.
- `supabase/migrations` is the only durable history for PostgreSQL schema changes, and `mongodb/migrations` (with `mongodb/schemas`) is the only durable history for MongoDB collections, validators and indexes. Do not make undocumented remote-only changes in the Supabase dashboard or the Atlas UI.
- Keep domain naming aligned across route, controller and model files so a feature can be traced vertically.

Do not introduce `src/modules`, `src/platform`, `src/workflows` or another competing backend root merely because an agent prefers that pattern. A major restructuring requires an approved ticket and coordinated README/master update.

#### 2.3.1 Backend code structure and writing style

The existing `healthModel.js`, `routers.js`, `authController.js` and `authRoutes.js` files are the coding-style reference for backend work. Unless an approved refactoring ticket changes the convention, agents must extend the backend in the same recognizable style rather than introducing a different JavaScript architecture.

Required conventions:

- Use CommonJS imports and exports: `require(...)` and `module.exports`. Do not mix in ES-module `import`/`export` syntax or TypeScript syntax.
- Use double quotes for strings and semicolons at statement boundaries.
- Use `const` by default and named `async` arrow functions for asynchronous model and controller operations.
- Keep the established route → controller → model flow. A route imports its controller, registers it on an Express `Router`, and exports the router. A controller awaits the model operation and sends the HTTP response. A model performs or delegates the data operation and returns domain data.
- Keep route files minimal. They may compose middleware and controllers, but must not contain database queries or workflow logic.
- Keep `req` and `res` inside controllers. Models must not depend on Express request or response objects.
- Use `try/catch` at the controller boundary, log enough server-side context for diagnosis, and return a safe client error without exposing credentials, SQL text or stack traces.
- Follow the indentation and spacing of the nearest existing file. Do not reformat unrelated files as part of a feature ticket.
- Use concise, feature-specific function names such as `getEvent`, `submitEvent` or `getVenueAvailability`. The existing `test` name is health-check boilerplate and is not a naming pattern for production handlers.
- Keep comments sparse and useful. Explain a non-obvious decision or invariant; do not narrate straightforward code or copy decorative comments mechanically.

Reference shapes:

```js
const express = require("express");
const router = express.Router();

const getEvent = require("../controller/eventController");

router.get("/:eventId", getEvent);

module.exports = router;
```

```js
const findEventById = require("../model/eventModel");

const getEvent = async (req, res) => {
  try {
    const event = await findEventById(req.params.eventId);
    res.status(200).json({ event });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

module.exports = getEvent;
```

These examples define code shape, not a complete endpoint or authorization implementation. Real controllers must apply the authentication, authorization, validation and business rules required by the ticket and this master.

Preserve the examples' style without copying weaknesses from boilerplate. In particular, models must not convert thrown failures into ordinary successful return values, generic placeholder names must not spread into domain code, and environment initialization should occur once at application startup rather than being added to every new controller. Correctness, security and transaction rules in this master take precedence when a sample is incomplete.

### 2.4 Frontend: README-confirmed baseline

```text
connectsphere-g8t6/
├── .next/
├── app/
│   ├── favicon.ico
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── node_modules/
├── public/
├── .gitignore
├── AGENTS.md
├── CLAUDE.md
├── COMMIT_MESSAGES.md
├── eslint.config.mjs
├── next-env.d.ts
├── next.config.ts
├── package-lock.json
├── package.json
├── postcss.config.mjs
├── README.md
└── tsconfig.json
```

`.next` and `node_modules` are generated directories and must remain ignored. `AGENTS.md` and `CLAUDE.md` contain repository-local agent guidance and must be read before editing. The current landing page is `app/page.tsx` until the planned `src` migration is performed. The startup check in section 2.7 also relies on a root-level `api/events.tsx` helper that the README tree does not list; the `src` migration moves its responsibility into `src/lib/api`.

### 2.5 Frontend: target expansion

The frontend README proposes moving application code beneath `src`. Apply that direction once as a coordinated refactor; do not maintain both root `app/` and `src/app/` implementations.

```text
connectsphere-g8t6/
├── public/
│   ├── favicon.ico
│   └── logo.png
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── globals.css
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   └── signup/page.tsx
│   │   └── (portal)/
│   │       ├── dashboard/page.tsx
│   │       ├── assignments/page.tsx
│   │       ├── events/
│   │       │   ├── page.tsx
│   │       │   ├── new/page.tsx
│   │       │   └── [eventId]/page.tsx
│   │       ├── venues/
│   │       │   ├── page.tsx
│   │       │   └── [venueId]/page.tsx
│   │       ├── technical-requests/page.tsx
│   │       ├── safety-reviews/page.tsx
│   │       ├── my-registrations/page.tsx
│   │       └── notifications/page.tsx
│   ├── components/
│   │   ├── layout/
│   │   ├── forms/
│   │   ├── feedback/
│   │   └── shared/
│   ├── lib/
│   │   ├── api/
│   │   ├── auth/
│   │   ├── permissions/
│   │   └── validation/
│   └── styles/
├── tests/
│   └── e2e/
├── .env.local
├── .gitignore
├── AGENTS.md
├── CLAUDE.md
├── COMMIT_MESSAGES.md
├── eslint.config.mjs
├── next-env.d.ts
├── next.config.ts
├── package-lock.json
├── package.json
├── postcss.config.mjs
├── README.md
└── tsconfig.json
```

Route groups organize code and do not change URLs. Dynamic App Router segments use `[eventId]` and `[venueId]`, not Express-style `:id` folder names.

### 2.6 Frontend placement rules

- `src/app` owns routing, layouts, page composition, loading/error boundaries and server/client component boundaries.
- `src/components` owns reusable presentation components. Domain-specific page orchestration should stay close to its page until genuine reuse exists.
- `src/lib/api` owns the single browser-to-backend client, shared error normalization and request helpers.
- `src/lib/auth` owns Supabase browser-session integration and authenticated request setup; it does not define application authorization policy.
- `src/lib/permissions` may determine what controls to render from trusted server-provided context. It must never be treated as the enforcement layer.
- `src/lib/validation` may share form-oriented schemas, but backend validation remains authoritative.
- `src/styles` contains shared styling beyond `globals.css` when needed.
- `public` contains immutable public assets. Do not place secrets or private documents there.
- Core business endpoints belong to the Express backend, not `src/app/api`.

### 2.7 Local environment setup and startup verification

Both applications must start and pass the checks in this section before any ticket work begins. This applies to developers and coding agents alike. Work started on an environment that does not boot cannot be verified, and setup failures are easily misreported as defects in the new work.

#### 2.7.1 Prerequisites

- Node.js (current LTS release) and npm.
- Access to the Supabase development project `rvwiflsedoujspmzfrbq` (section 10.1) to copy its URL and API key.
- An individual MongoDB Atlas database user for cluster `spm.ldi4ulx.mongodb.net`, obtained from the team's Atlas admin, with the "Read and write to any database" role, and your current IP address added to Atlas Network Access. Required once `config/mongodb.js` exists.
- Both repositories cloned and checked out on the branch you will work from.
- Ports 8000 (backend) and 3000 (frontend) free, or changed together as described below.

#### 2.7.2 Backend setup

```bash
git clone [backend-clone-url]
cd connectsphere-events-g8t6-backend
npm install
```

Create a file named exactly `.env` in the backend root (on Windows, confirm the editor did not save it as `.env.txt`):

```dotenv
PORT=8000
SUPABASE_URL=https://rvwiflsedoujspmzfrbq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key from the Supabase dashboard: Project Settings → API Keys>
MONGODB_URI=mongodb+srv://<atlas-username>:<url-encoded-password>@spm.ldi4ulx.mongodb.net/?appName=SPM
MONGODB_DB_NAME=connectsphere_dev
```

| Variable | Required | Read by | Notes |
| --- | --- | --- | --- |
| `PORT` | No | `server.js` | Defaults to `8000`. If changed, change the frontend `BACKEND_URL` to match. |
| `SUPABASE_URL` | Yes | `config/supabase.js` | Development project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes, unless `SUPABASE_ANON_KEY` is set | `config/supabase.js` | Bypasses row-level security. Server-only: never place it in the frontend, a commit, Jira or chat. |
| `SUPABASE_ANON_KEY` | Fallback only | `config/supabase.js` | Used only when the service role key is absent. RLS then applies to backend queries, so behavior can differ from the service-role setup. |
| `MONGODB_URI` | Yes, once `config/mongodb.js` exists | `config/mongodb.js` | Your own Atlas user. URL-encode special characters in the password (for example `@` becomes `%40`). Server-only: never place it in the frontend, a commit, Jira or chat. |
| `MONGODB_DB_NAME` | Yes, once `config/mongodb.js` exists | `config/mongodb.js` | `connectsphere_dev` for shared development (M3). Automated tests set their own value (section 11). |

`config/supabase.js` throws `Missing Supabase environment variables in .env` during startup when `SUPABASE_URL` or both keys are missing. The backend never reads `MDB_MCP_CONNECTION_STRING`; that user-level variable belongs to the MongoDB MCP server (section 10.1), even if it holds the same credentials. Email and SMS provider variables are added by the ticket that introduces each provider (M6). `.env` is ignored by `.gitignore`; never commit it. When a work item introduces a new backend variable, add it to this table and the backend README in the same work item.

Start the backend:

```bash
npm run dev
```

`npm run dev` runs `nodemon server.js`, which restarts on file changes but does not reload `.env`; restart it manually after editing `.env`.

#### 2.7.3 Backend startup check

All three must pass:

1. The terminal prints `Server is running on http://localhost:8000` with no stack trace.
2. `GET http://localhost:8000/` returns `Server is working!`. This confirms Express only.
3. `GET http://localhost:8000/api/healthcheck` returns HTTP 200 with `{"message":"App is working well"}`. This confirms the Supabase URL and key are accepted.

```bash
curl http://localhost:8000/api/healthcheck
```

In Windows PowerShell 5.1, use `curl.exe` (plain `curl` is an alias for `Invoke-WebRequest`) or open the URL in a browser.

The health check deliberately queries a table that does not exist. Supabase's table-not-found response (`PGRST205`) counts as success because it proves the request was authenticated and reached the database. Any other Supabase error returns HTTP 500 `{"error":"Internal Server Error"}`, and the real cause is logged in the backend terminal. The health check is an operational baseline, not a complete API specification.

Once `config/mongodb.js` exists, the work item that introduces it must extend the health check to ping MongoDB, so that HTTP 200 confirms both stores, and must update this section. Until then the health check covers Supabase only.

#### 2.7.4 Frontend setup

```bash
cd connectsphere-g8t6
npm install
```

Create `.env.local` in the frontend root (`connectsphere-g8t6/`):

```dotenv
BACKEND_URL=http://localhost:8000
```

| Variable | Required | Read by | Notes |
| --- | --- | --- | --- |
| `BACKEND_URL` | Yes | `api/events.tsx` | Base URL of the running backend, without a trailing slash. Read on the server by `app/page.tsx` (a server component), so it has no `NEXT_PUBLIC_` prefix. |

A variable that must reach browser code needs the Next.js `NEXT_PUBLIC_` prefix and is then visible to every user. It must never contain a service-role key, database password or private MCP credential. `.env*` files are ignored by `.gitignore`; never commit them. Next.js reads `.env.local` at startup, so restart the dev server after editing it. When a work item introduces a new frontend variable, add it to this table and the frontend README in the same work item.

With the backend already running, start the frontend:

```bash
npm run dev
```

#### 2.7.5 Frontend startup check

1. Open `http://localhost:3000`.
2. The page displays the pretty-printed `{"message": "App is working well"}` response. `app/page.tsx` fetches it from the backend health check through `api/events.tsx`, so this confirms frontend → backend → Supabase end to end.
3. The frontend terminal logs `http://localhost:8000/api/healthcheck`. If it logs `undefined/api/healthcheck`, `BACKEND_URL` was not loaded.

If a work item removes the health check from the landing page (for example the `src` migration in section 2.5), it must provide an equivalent end-to-end check and update this section in the same work item.

#### 2.7.6 Environment file check

Run this check before starting either server. It catches missing, misnamed, committed or mismatched environment files, which otherwise show up later as confusing startup or data errors. Applies to developers and coding agents alike.

**Never reveal secrets.** An agent may read the environment files to run this check, but it reports only file names, variable names and pass/fail. It never prints, logs, copies or asks for the value of `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `MONGODB_URI`, provider keys or `MDB_MCP_CONNECTION_STRING`, and it never asks the developer to paste a value into the conversation. Only the non-secret values listed in step 4 may be shown.

1. **Files exist with exact names.** `.env` is in the backend root and `.env.local` is in the frontend root. On Windows, confirm neither was saved as `.env.txt` or `.env.local.txt` (`dir /a` or `ls -a` shows hidden files).
2. **Files are not committed.** In each repository, `git check-ignore <file>` prints the file name and `git ls-files <file>` prints nothing. If a file is tracked, stop: tell the developer, do not commit anything, and treat the credentials in it as exposed. The developer must remove it from the repository and have the keys rotated (Supabase keys in the dashboard; Atlas passwords through the Atlas admin).
3. **Required variables are present and non-empty.**

   | File | Always required | Required once `config/mongodb.js` exists |
   | --- | --- | --- |
   | Backend `.env` | `SUPABASE_URL`; `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY` | `MONGODB_URI`, `MONGODB_DB_NAME` |
   | Frontend `.env.local` | `BACKEND_URL` | — |

   Variables added later by a work item (section 2.7.2) join this table in the same work item.
4. **Non-secret values match the team setup.** These may be shown when they differ:
   - `SUPABASE_URL` is `https://rvwiflsedoujspmzfrbq.supabase.co`.
   - `MONGODB_DB_NAME` is exactly `connectsphere_dev` (M3). Any other value puts the developer in a private database whose documents do not match the shared Supabase project (section 6.5).
   - `BACKEND_URL` is `http://localhost:8000` (or the backend's `PORT`), with no trailing slash.
5. **Secret values have the right shape, checked without printing them.** `MONGODB_URI` starts with `mongodb+srv://`, its host is `spm.ldi4ulx.mongodb.net`, and it contains no database name that conflicts with `MONGODB_DB_NAME`. A wrong username, wrong password or unencoded special character cannot be detected here; it appears as `authentication failed` when the backend connects (see section 2.7.8).
6. **No MCP variable in the application.** `MDB_MCP_CONNECTION_STRING` appears nowhere in either repository or environment file (section 4.3).

Example commands that print only status, assuming the backend loads `.env` with `dotenv` (check `package.json`; adapt otherwise):

```bash
node -e "require('dotenv').config(); for (const k of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_ANON_KEY','MONGODB_URI','MONGODB_DB_NAME']) console.log(k, process.env[k] ? 'set' : 'not set')"
node -e "require('dotenv').config(); let ok=false; try { const u=new URL(process.env.MONGODB_URI||''); ok=u.protocol==='mongodb+srv:' && u.hostname==='spm.ldi4ulx.mongodb.net'; } catch {} console.log('MONGODB_URI shape:', ok ? 'ok' : 'not ok')"
```

If any step fails, stop and tell the developer which file or variable is wrong and what to do, then wait for them to fix it. After the developer edits an environment file, restart the affected server: nodemon does not reload `.env`, and Next.js reads `.env.local` only at startup. Record the result in the ticket report as `Environment check: passed`, or list the failed checks by file and variable name only.

#### 2.7.7 Startup gate

Before starting any ticket:

1. Pull the latest changes on the working branch in both repositories and run `npm install` in each, because dependencies may have changed.
2. Pass the environment file check in section 2.7.6.
3. Start the backend and pass section 2.7.3.
4. Start the frontend and pass section 2.7.5.
5. If any check fails, **stop**. Do not begin the ticket and do not change feature code to work around the failure.
   - Setup problems (missing or wrong environment values, ports, dependencies): fix them using sections 2.7.6 and 2.7.8, then repeat the checks.
   - Code problems on the branch (for example `Cannot find module`): report the exact error, branch and commit to the team and resolve it as its own work item before starting the ticket.
6. Record in the ticket report that the gate passed, including the environment check result, with the branch and commit of each repository.

A coding agent must run these checks itself, including starting both servers and requesting the check URLs; it must not assume they pass. If the environment files are missing, the agent asks the developer to create them using sections 2.7.2 and 2.7.4 and never asks for keys to be pasted into the conversation.

#### 2.7.8 Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Backend exits with `Missing Supabase environment variables in .env` | `.env` missing, misnamed, outside the backend root or missing values | Create it as in section 2.7.2 and restart |
| `git ls-files .env` or `git ls-files .env.local` lists the file | The environment file was committed | Stop; remove it from the repository and have the exposed keys rotated (section 2.7.6) |
| Venues created by teammates show missing details, or your new venues stay inactive for others | `MONGODB_DB_NAME` is not `connectsphere_dev` | Correct it and restart the backend |
| Backend exits with `Cannot find module '…'` | A file on the branch requires a module that is not committed | Code problem: stop and report as in section 2.7.7 |
| Backend exits with `EADDRINUSE` | Port already in use | Stop the other process, or change `PORT` and `BACKEND_URL` together |
| Health check returns 500; backend log shows `Invalid API key` | Wrong key or key from another project | Copy the key again from project `rvwiflsedoujspmzfrbq` |
| Health check returns 500; backend log shows `fetch failed` or `ENOTFOUND` | Wrong `SUPABASE_URL` or no network access | Check the URL and connectivity |
| Backend start or health check times out connecting to MongoDB | Your IP is not on Atlas Network Access | Ask the Atlas admin to add your current IP, then restart |
| MongoDB `authentication failed` | Wrong Atlas username/password, or special characters in the password are not URL-encoded | Fix `MONGODB_URI` and restart |
| MongoDB `not authorized` on a write | Your Atlas user lacks the "Read and write to any database" role | Ask the Atlas admin to grant the role |
| Frontend logs `undefined/api/healthcheck` | `.env.local` missing, misnamed or not loaded | Create it as in section 2.7.4 and restart the frontend |
| Frontend page shows `fetch failed` / `ECONNREFUSED` | Backend not running or on a different port | Start the backend; make `BACKEND_URL` match `PORT` |
| Frontend page shows `Failed to fetch data` | Backend returned a non-2xx response | Pass section 2.7.3 first |

Passing the startup gate is a precondition, not verification of the task. Before claiming a task is verified, inspect `package.json` in the relevant repository and run its actual lint, test and build scripts. Do not invent missing scripts or infer success from the development server alone.

### 2.8 Commit and branch conventions

Use `COMMIT_MESSAGES.md` in the relevant repository for the exact commit-message format.

Branch names use `<type>/<ticket-id>-<short-description>` when work maps to Jira. Supported prefixes are:

- `feature/` for new behavior;
- `fix/` or `bugfix/` for defects;
- `refactor/` for behavior-preserving restructuring;
- `docs/` for documentation changes;
- `chore/` for maintenance and dependency/configuration work.

Examples: `feature/SPM-55-event-submission`, `fix/SPM-118-booking-conflict`, `docs/update-master`.

Start from the latest shared main branch:

```bash
git checkout main
git pull origin main
```

Inspect the real repository status before creating or switching branches. Preserve unrelated developer changes. Related frontend and backend work must reference the same Jira issue.

## 3. Product Scope and User Experience

ConnectSphere manages event requests from draft through coordinator assignment, review, resource planning, operational safety review, preparation, confirmation, attendee registration and completion. It also handles clarification, reassignment, tentative venue holds, multi-venue arrangements, venue unavailability and replacement, significant changes, cancellation, resource incidents, notifications and audit history.

### 3.1 Roles

| Code | Role | Main responsibility |
| --- | --- | --- |
| `ORGANISER` | Event Organiser (EO) | Create event requests, answer clarifications, request changes and manage registration policy |
| `COORDINATOR_LEAD` | Event Coordinator Lead (ECL) | Review the unassigned queue, assign and reassign coordinators, and oversee coordinator assignments and active events |
| `COORDINATOR` | Event Coordinator (EC) | Review assigned events, coordinate resources and make lifecycle decisions for assigned events |
| `VENUE_STAFF` | Venue Staff (VS) | Maintain venue data, setup and turnaround times, holds and blocks, and decide venue-booking requests |
| `TECH_SUPPORT` | Technical Support Staff (TS) | Review technical needs and reserve equipment/support |
| `SAFETY_OFFICER` | Safety Officer (SO) | Conduct the Operational Safety Check and approve, reject or request changes to an event's arrangements |
| `ATTENDEE` | Attendee (AT) | View published events and manage personal participation |

Users may hold multiple roles. A multi-role user receives each role's permissions only within that role's scope; for example, a user who is both ECL and EC makes lifecycle decisions only on events assigned to them as coordinator. There is no baseline application System Administrator role. External users may self-register as organiser or attendee only. Staff accounts and staff roles, including `COORDINATOR_LEAD` and `SAFETY_OFFICER`, require trusted provisioning.

### 3.2 Included capabilities

- Authentication, profile provisioning, roles and organization membership.
- Draft event creation, submission, review, clarification, resubmission, feasibility acceptance, operational safety review, preparation, confirmation, rejection and completion.
- An unassigned queue for submitted events, with coordinator assignment and reassignment by the Event Coordinator Lead.
- Venue catalogue, configurable setup and turnaround times, availability, suitability, tentative holds with expiry, booking review, conflict prevention, operational blocks and preparation status.
- Multiple venue bookings for one event, each checked independently.
- Equipment inventory, time-based availability, technical review, reservation and preparation status.
- Attendee registration, capacity enforcement, waiting list, offers, withdrawal and attendance history.
- Significant event changes, cancellation, venue replacement and resource incidents.
- Durable in-app notifications and audience-filtered activity history.

### 3.3 Baseline exclusions

Payments, pricing, full reporting/export suites, general document management, recurring or multi-session events, sub-divisible rooms within a venue, demographics, favorites and detailed staff rostering are outside the baseline. Multiple venues for one event are in scope (section 5.4.2); each venue remains one independently bookable space. The draft database diagrams may show fields or tables for excluded capabilities; those diagrams are reference material, not authority to implement them.

### 3.4 Frontend surfaces

| URL | Main purpose |
| --- | --- |
| `/login`, `/signup` | Authentication and permitted external onboarding |
| `/dashboard` | Role-specific drafts, assignments and outstanding work |
| `/events`, `/events/new`, `/events/[eventId]` | Event discovery/list, creation and role-aware workspace |
| `/assignments` | Event Coordinator Lead's unassigned queue, coordinator assignments and oversight of active events |
| `/venues`, `/venues/[venueId]` | Venue catalogue, details, setup/turnaround configuration, blocks, suitability and calendar information |
| `/technical-requests` | Technical review and preparation queue |
| `/safety-reviews` | Safety Officer's review queue and review workspace |
| `/my-registrations` | Current user's registrations, invitations and withdrawal actions |
| `/notifications` | Durable inbox and read state |

The event workspace should expose overview, requirements, clarification, assignment, venue arrangements (one entry per venue booking or hold), technical arrangements, safety review, changes, registrations and history according to permissions. Display current and proposed values separately. A saved draft is not submitted, a held venue is not a booked venue, an expired hold is not a booking, a waitlist entry is not a confirmed registration, an approved resource is not a confirmed event, a safety-approved event is not a confirmed event, and an approved change is not applied until the explicit apply step succeeds.

Venue calendars distinguish event time from setup and turnaround time, and show active holds (with their expiry), approved bookings and operational blocks distinctly.

Every page must handle loading, empty, validation, forbidden, conflict, retry and success states. Preserve user input after recoverable errors. Support keyboard operation and practical mobile layouts. Do not optimistically claim scarce-resource allocation or final confirmation before the backend commits it.

## 4. Authentication and Authorization

### 4.1 Authentication sequence

1. The frontend signs the user in through Supabase Auth.
2. The frontend sends the access token to the Express backend with authenticated business requests.
3. `middleware/auth.js` verifies the token's signature, issuer, expiry and audience using the supported Supabase verification mechanism.
4. The backend loads the active application profile, trusted roles and organization memberships.
5. The controller/model operation checks role, relationship, allowed fields and lifecycle state.

Do not trust a decoded-only token, a body-supplied actor ID, an `X-User-ID` header or user-editable metadata for permissions. Role switching in the UI changes presentation only; it cannot expand server permissions.

### 4.2 Access rules

| Data/action | EO | ECL | EC | VS | TS | SO | AT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Private draft | Owner read/write only | No access | No access | No access | No access | No access | No access |
| Unassigned queue | Own event status only | Basic information for every queued event | No access | No access | No access | No access | No access |
| Submitted event | Own and permitted organization events; limited editing | Events under supervision, read-only | Assigned events | Relevant venue information | Assigned technical information | Safety-relevant information for events in or past safety review | Published attendee-safe view only |
| Coordinator assignment or reassignment | No | Yes, for non-terminal events | No; may ask the Lead | No | No | No | No |
| Lifecycle decision | No | No, unless also the assigned EC | Assigned coordinator only | No | No | Safety outcome only | No |
| Venue catalogue, buffers, holds, blocks and booking decision | Read candidate data through event planning | Read | Request holds and bookings; read | Maintain and decide within scope | Relevant operational read | Read venue safety information | Published summary only |
| Equipment/technical decision | State requirements | Read | Request/refine | No decision | Assigned review and reservation | Read equipment placement | No |
| Safety review | Outcome summary | Read | Submit for review; read outcome | Read outcome for own venues | Read outcome for own requests | Claim and decide | No |
| Change/cancellation request | Owner may request | Read | Review and explicitly apply/decide | Review affected venue plan | Review affected technical plan | Re-review when arrangements change | No |
| Participant list | Event owner | No by default | Assigned coordinator | No by default | No by default | Counts only | Own registration only |
| Internal notes/history | External-safe subset | Assignment history and events under supervision | Assigned scope | Relevant portion | Relevant portion | Relevant portion | Own/published subset only |

Basic information for the unassigned queue is the event title, purpose, organiser organization, proposed date and time, expected attendance and a summary of venue and equipment requirements. It excludes clarification content, internal notes and participant data. "Events under supervision" covers every active event and coordinator while Q7 remains at its temporary baseline (section 12.1.2).

Same-organization visibility begins after submission and does not grant edit rights or participant personal data. Reassignment removes the previous coordinator's mutation rights and grants the new coordinator's rights in the same transaction. Unrelated or private resources should normally respond as not found rather than confirming their existence.

### 4.3 Database and credential boundary

- The browser may communicate directly with Supabase Auth for session operations.
- Business reads and writes go through the Express backend. The browser never connects to PostgreSQL or MongoDB.
- The backend uses private server configuration and least-privilege database access.
- Developer Supabase and MongoDB MCP permissions are separate from the application's runtime identity and end-user permissions. The backend reads `MONGODB_URI`, never the MCP variable `MDB_MCP_CONNECTION_STRING`.
- Database credentials, service-role keys, MongoDB connection strings, email/SMS provider keys and private MCP tokens must not enter frontend code, committed files, logs, Jira or chat output.
- Atlas access is limited by individual database users and the Network Access IP list, both managed by the team's Atlas admin.
- Use parameterized queries, explicit allowed origins, bounded request sizes and redacted errors/logs.
- Audit records are append-only for the application runtime.

If the project temporarily exposes tables through a Supabase Data API, row-level security and grants must prevent the browser from bypassing backend workflow rules. The preferred application boundary remains the Express backend.

## 5. Domain Architecture and Business Rules

Rules marked with a question ID (for example Q6) are provisional or temporary baselines listed in section 12.1. Work that depends on a provisional rule (Q1, Q3, Q4, Q6) must pass the provisional decision gate in section 10.6.

### 5.1 Domain-to-code mapping

The domain modules are logical groupings implemented through the existing layered backend structure.

| Domain | Primary backend files | Responsibilities |
| --- | --- | --- |
| Identity and access | `authRoutes.js`, `authController.js`, `auth.js`, `authorize.js`, `userModel.js` | Auth context, profile, roles (including Lead and Safety Officer), memberships and relationship checks |
| Events | `eventRoutes.js`, `eventController.js`, `eventModel.js` | Drafts, unassigned queue, coordinator assignment and reassignment, review, clarification, lifecycle transitions, arrangement version and readiness |
| Venues | `venueRoutes.js`, `venueController.js`, `venueModel.js`, `venueConflictModel.js`, `venueDetailModel.js` | Catalogue, setup and turnaround buffers, suitability, multiple bookings per event, holds and expiry, blocks, decisions, replacement and preparation |
| Technical/equipment | `equipmentRoutes.js`, `equipmentController.js`, `equipmentModel.js`, `equipmentDetailModel.js` | Inventory, unavailable stock, technical requests, reservations and preparation |
| Safety | `safetyRoutes.js`, `safetyController.js`, `safetyModel.js` | Safety review queue, claims, review rounds, outcomes and approval invalidation |
| Registration | `registrationRoutes.js`, `registrationController.js`, `registrationModel.js` | Registration policy, capacity, queue, offers, withdrawal and attendance |
| Changes/cancellation | `changeRequestRoutes.js`, `changeRequestController.js`, `changeRequestModel.js` | Proposals, impact plans, staff reviews, explicit application and cancellation |
| Notifications/history | `notificationRoutes.js`, `activityRoutes.js` and matching controllers/models | Durable inbox, recipients, read state, email/SMS delivery queue and audience-filtered history |
| Detail sync | `outboxModel.js`, `jobs/mongoSyncJob.js` | Outbox entries and applying them to MongoDB |

A feature may touch several domain files, but it remains one in-process workflow. Controllers coordinate through shared model operations and one transaction for atomic cross-domain changes.

### 5.2 Event lifecycle

Canonical states are:

`DRAFT`, `SUBMITTED`, `UNDER_REVIEW`, `AWAITING_CLARIFICATION`, `PLANNING`, `SAFETY_REVIEW`, `PREPARATION`, `CONFIRMED`, `COMPLETED`, `REJECTED`, `CANCELLED`.

`PREPARATION` is provisional (Q6). There is no separate event-level `APPROVED` state. Feasibility acceptance enters `PLANNING`, safety approval enters `PREPARATION`, and only final coordinator confirmation enters `CONFIRMED`. The unassigned queue is not a separate state: it is every `SUBMITTED` event with no coordinator.

```text
DRAFT ──submit──▶ SUBMITTED (unassigned) ──Lead assigns──▶ SUBMITTED (assigned) ──start review──▶ UNDER_REVIEW
UNDER_REVIEW ──request clarification──▶ AWAITING_CLARIFICATION ──resubmit──▶ SUBMITTED (assigned)
UNDER_REVIEW ──accept feasibility──▶ PLANNING ──submit for safety review──▶ SAFETY_REVIEW
SAFETY_REVIEW ──approve──▶ PREPARATION ──confirm──▶ CONFIRMED ──end passes──▶ COMPLETED
SAFETY_REVIEW ──changes requested / rejected / superseded──▶ PLANNING
PREPARATION or CONFIRMED ──applied significant change──▶ PLANNING                  (section 5.7)
PREPARATION or CONFIRMED ──approved replacement venue──▶ SAFETY_REVIEW              (section 5.4.4, Q3)
Never-confirmed active event ──reject──▶ REJECTED
Eligible active event ──cancel──▶ CANCELLED
```

| Action | Actor | Preconditions | Result and required effects |
| --- | --- | --- | --- |
| Save draft | EO owner | Valid supplied fields; incomplete fields allowed | Remain `DRAFT`; persist only accepted changes |
| Submit | EO owner | Required fields complete | Enter `SUBMITTED` with no coordinator; notify Leads |
| Assign coordinator | ECL | `SUBMITTED` with no coordinator; assignee holds an active `COORDINATOR` role | Set the coordinator, record assignment history, notify assignee and owner |
| Reassign coordinator | ECL | Non-terminal state with a coordinator; new assignee active and different | Replace the coordinator, record history, notify new and previous coordinator and owner; previous coordinator loses mutation rights immediately |
| Start review | Assigned EC | `SUBMITTED` with a coordinator | Enter `UNDER_REVIEW` and record review start |
| Request clarification | Assigned EC | `UNDER_REVIEW` | Store a new round, enter `AWAITING_CLARIFICATION`, notify EO |
| Respond/resubmit | EO owner | Open clarification; valid amendments | Keep the event and coordinator, mark round responded, return to `SUBMITTED` (assigned; not the unassigned queue) |
| Accept feasibility | Assigned EC | Sufficient reviewed requirements | Enter `PLANNING`; do not confirm automatically |
| Submit for safety review | Assigned EC | `PLANNING`; every active venue booking approved, suitable and conflict-free; technical arrangements approved or `NOT_REQUIRED`; no open blocking incident; no approved but unapplied change | Enter `SAFETY_REVIEW`; open a review round bound to the current arrangement version; notify Safety Officers |
| Approve safety | Claiming SO | `SAFETY_REVIEW`; reviewed arrangement version is current | Enter `PREPARATION` (Q6); notify coordinator and relevant staff |
| Request safety changes or reject safety arrangement | Claiming SO | `SAFETY_REVIEW` | Record outcome and named arrangements; return to `PLANNING`; notify coordinator (section 5.9) |
| Confirm | Assigned EC | `PREPARATION`; every readiness check in section 5.3 passes | Enter `CONFIRMED`, store confirmation snapshot and notify relevant users |
| Complete | Internal job or assigned EC | `CONFIRMED`; event end has passed; no unapplied blocking change | Enter `COMPLETED` and close registration |
| Reject | Assigned EC | Never previously confirmed; state from `UNDER_REVIEW` to `PREPARATION` | Enter `REJECTED`; release holds, bookings and reservations; preserve history |
| Apply significant change | Assigned EC | Versioned proposal and plan fully reviewed; all rechecks pass | Replace arrangements atomically, invalidate safety approval and return to `PLANNING` |
| Cancel | Assigned EC, directly or by approving an EO request | Active eligible event and reason | Enter `CANCELLED`; release resources and close registrations/offers |

Submission requires title, purpose, start/end interval, positive expected attendance and venue/layout requirements. Submission does not assign a coordinator and does not fail for lack of an available coordinator (section 5.8). An event without a coordinator cannot be reviewed, clarified, accepted, rejected or planned.

Clarification preserves all question/response rounds. Do not start new planning arrangements while clarification is outstanding. Ordinary comments cannot substitute for formal review steps.

After submission, ordinary descriptive/contact changes may be permitted. Date, duration, attendance, venue/layout and equipment changes are significant and must use the reviewed change workflow, except when explicitly amended during the pre-planning clarification loop.

New venue holds, venue bookings and technical requests are created only while the event is in `PLANNING`. The exceptions are replacement bookings under section 5.4.4 and arrangements built by a significant-change plan under section 5.7.

`events.arrangement_version` increases in the same transaction whenever the event's active venue bookings, booking decisions, blocking incidents, technical arrangements or expected attendance change. Safety approval is valid only for the arrangement version it reviewed.

### 5.3 Readiness and publication

Confirmation requires:

- the event is in `PREPARATION` (Q6);
- at least one active venue booking, and every active venue booking approved, suitable and free of conflicts over its occupied range (section 5.4.1);
- exactly one active booking marked as the main space (Q4);
- approved equipment and support arrangements for every requested technical need, or `NOT_REQUIRED`;
- a safety approval for the current arrangement version;
- preparation status `READY` on every active venue booking and technical request (Q6);
- matching current requirement versions;
- valid registration settings when registration is enabled, with registration capacity no greater than the main space's capacity (Q4);
- no unresolved blocking incident;
- no approved but unapplied significant change.

Holds, and rejected, expired, released or cancelled bookings never count toward readiness. If no technical need exists, the technical state is `NOT_REQUIRED`. Venue Staff and Technical Support record preparation progress only while the event is in `PREPARATION` or `CONFIRMED` (Q6). Coordinators cannot override a missing readiness item.

Attendee discovery is limited to events that are both confirmed and explicitly published. A new event defaults to unpublished until the assigned coordinator chooses publication. Existing participants retain an attendee-safe history if an event returns to an earlier state, completes or is cancelled.

### 5.4 Venue rules

- The baseline treats each venue as one independently bookable space; the draft `Room` entity is not authoritative.
- Venue booking states are `HELD`, `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`, `RELEASED` and `CANCELLED`. `HELD`, `PENDING` and `APPROVED` are active and occupy the venue.
- Blocking checks read PostgreSQL only. Layout, facility and accessibility information comes from MongoDB `venue_details` (section 6.4).
- Each booking is checked on its own requirements. Capacity against the booking's expected attendance, and availability over the booking's occupied range against active bookings, active holds and blocks, are blocking checks. Supported layout, required facilities, accessibility and operating hours produce warnings shown to the coordinator and Venue Staff; Venue Staff decide.
- The event interval must fall within the venue's operating hours; setup and turnaround time may fall outside them (Q8).
- Coordinators cannot override blocking checks or Venue Staff decisions. There are no staff overrides for venue conflicts.
- Venue search may return partial matches with suitability warnings (section 5.4.5). Search is advisory; the PostgreSQL recheck inside the decision transaction is authoritative.
- Time ranges are half-open: `[start, end)`. Adjacent ranges are allowed; any overlap, including one second, is a conflict. Competing requests are decided strictly first come, first served.
- Venue rejection releases the rejected booking but keeps the event in planning so an alternative can be selected. Other bookings for the same event are unaffected.
- Edits to a venue's capacity, facilities or operating hours notify Venue Staff and the coordinators of affected future events for manual review; existing bookings are not recalculated automatically. Changes to setup and turnaround time follow section 5.4.1.

#### 5.4.1 Setup and turnaround time

- Venue Staff configure `setup_minutes` and `turnaround_minutes` per venue as non-negative integers defaulting to `0`. There is no per-event override.
- Every hold and booking stores the setup and turnaround values in effect when it is created, and its occupied range `[event_start − setup, event_end + turnaround)`.
- Availability, suitability, conflict detection and the booking exclusion constraint use the occupied range, not the advertised event interval. For example, an event from 10:00 to 12:00 at a venue with 30 minutes of setup and 45 minutes of turnaround occupies `[09:30, 12:45)`. Another booking whose occupied range starts at 12:45 is allowed; one starting at 12:44 is a conflict.
- Changing a venue's setup or turnaround time never edits existing holds or bookings. In the same transaction, the system recomputes the occupied ranges of future active holds and bookings at that venue using the new values. For each pair that would overlap, it opens a `BUFFER_CONFLICT` incident linked to both bookings and notifies both coordinators and Venue Staff. Nothing is removed. New holds and bookings use the new values.
- A `BUFFER_CONFLICT` incident is resolved when the overlap no longer exists, for example after a booking is replaced or released, or the buffers are reduced.
- When buffers are first introduced, existing bookings are backfilled with zero buffers before venue values are set, so the conflict scan identifies bookings that become problematic.
- Holds and bookings created by a significant-change plan or a replacement use the venue's current values.
- Equipment reservations do not use venue buffers (section 5.5).

#### 5.4.2 Multiple venues for one event

- An event may have several active venue bookings, at most one per venue. Each booking carries its own label (for example "Main hall" or "Breakout A"), expected attendance, layout and required facilities/accessibility, and is checked independently for suitability, availability and conflicts.
- Every booking uses the full event interval (Q4).
- Exactly one active booking is marked as the main space before confirmation; registration capacity cannot exceed the main space's capacity (Q4). A replacement for the main space inherits the flag.
- Rejecting, releasing or cancelling one booking does not change the event's other bookings. Other bookings are released only by an explicit coordinator action, event rejection or event cancellation.
- A significant change to date or time rechecks every booking named in the replacement plan.

#### 5.4.3 Tentative holds

- Venue Staff create a hold for an event in `PLANNING` at the coordinator's request (Q1). A hold is a venue booking in `HELD` state with a required `hold_expires_at`.
- A hold expires 7 days after creation by default and never later than the start of its occupied range. Venue Staff may extend a hold once before it expires, within the same cap (Q2).
- Active holds occupy the venue. Two events cannot hold overlapping occupied ranges at the same venue.
- The coordinator converts a hold by submitting the booking request for it before expiry. The booking moves from `HELD` to `PENDING`, keeping the slot (Q1), and then follows the normal decision.
- At expiry a hold moves to `EXPIRED`, the venue becomes available to other requests, and the hold can no longer be converted or extended. An expired hold is never treated as a booking. A later attempt for the same venue creates a new row.
- A PostgreSQL exclusion constraint cannot depend on the current time, so an overdue hold that the expiry job has not yet processed would still block the venue. Every operation that creates, converts or extends a hold or booking at a venue therefore first moves that venue's overdue holds to `EXPIRED` inside the same transaction, using database time. Converting or extending an overdue hold fails even if the job has not run.
- The coordinator and Venue Staff are notified 24 hours before a hold expires and when it expires.
- A hold is released when the event is rejected or cancelled, when the coordinator or Venue Staff release it, or when the booking is updated.

#### 5.4.4 Operational blocks and venue replacement

- Venue Staff create venue blocks with a reason (`MAINTENANCE`, `EQUIPMENT_FAILURE`, `RENOVATION`, `SAFETY`, `OTHER`), an interval and a note. Blocks have no setup or turnaround time and are shown on the venue calendar.
- Creating a block is never refused because of existing bookings. Blocks are not part of the booking exclusion constraint; new holds and bookings are checked against blocks under the venue lock.
- In the block transaction, every active hold or booking whose occupied range overlaps the block receives a `VENUE_BLOCK` incident. The event's arrangement version increases, and the coordinator and Venue Staff are notified that alternative arrangements are required. The event is not cancelled, the booking is not deleted, and the original event information is preserved.
- Effect on the event (Q3): an event in `PLANNING` stays in `PLANNING`. An open safety review is superseded and the event returns to `PLANNING`. An event in `PREPARATION` or `CONFIRMED` keeps its state while the incident is open; the incident blocks confirmation.
- The coordinator searches for a replacement and submits a replacement booking request that references the affected booking. This is allowed in any non-terminal state and is subject to all normal checks.
- When Venue Staff approve the replacement, one transaction releases the replaced booking, resolves its incident and increases the arrangement version. If the event was in `PREPARATION` or `CONFIRMED`, it moves to `SAFETY_REVIEW` and must be reconfirmed (Q3). Registrations are retained; attendees are notified of the new venue when the event is reconfirmed.
- If a block is lifted or shortened so that it no longer overlaps an affected booking, that booking's incident is resolved in the same transaction.
- Moving an event on the day it takes place is coordinated by staff offline and then recorded in the system.

#### 5.4.5 Venue search and calendar data

- Search runs in two steps. First, `venueDetailModel.js` filters `venue_details` on required layout, facilities and accessibility to produce candidate IDs and warnings. Second, `venueModel.js` checks those candidates in PostgreSQL for active state, capacity, operating hours and availability over the occupied range. Results combine blocking failures and warnings.
- When MongoDB is unavailable, search returns PostgreSQL-only results with layout, facility and accessibility marked "not checked" (M4).
- The venue availability calendar is computed from PostgreSQL holds, bookings and blocks. MongoDB holds no calendar or availability data.

### 5.5 Equipment and technical-support rules

- Inventory total is not the same as interval availability.
- Availability equals total usable stock minus active reservations and applicable unavailability during every segment of the requested interval.
- Reservations use the event interval. Venue setup and turnaround time does not apply to equipment, and equipment transit time between venues is zero.
- A technical request is fulfilled completely or rejected; partial approval is not allowed. All lines in one technical approval succeed and reserve atomically or all fail.
- Damaged or maintenance stock is represented explicitly and is not double-counted.
- Quantities, unavailability and reservations live in PostgreSQL. Equipment specifications live in MongoDB `equipment_details` and are display information only.
- Support-only requests still require technical review when on-site support is requested.
- Resource approval does not confirm the event. The event must still pass the safety review, and the assigned coordinator performs final confirmation after all readiness checks pass.

### 5.6 Registration and waiting-list rules

- The Event Organiser decides whether registration is enabled and sets the registration window. When registration is disabled, attendees may view the published event but cannot attend it.
- Registration requires a confirmed, published event, enabled registration, an open registration window and an active user. Registration is unavailable while a previously confirmed event is back in an earlier state; existing registrations are retained.
- Registration capacity cannot exceed the capacity of the main-space booking (Q4).
- Each attendee has one registration record per event. A withdrawn attendee may re-enter only under the agreed policy and receives a new queue position.
- Capacity changes, registration, withdrawal, offer acceptance and invitation allocation lock the event and recheck capacity.
- When capacity is full, eligible users join a FIFO waitlist.
- An invitation reserves a place until accepted, declined, expired or cancelled.
- Accepting an expired invitation cannot consume capacity even if the expiry job has not yet run.
- Withdrawal or expiry may invite the next eligible waiting attendee in the same transaction.
- Attendees can view only their own registration, invitation and queue information.

### 5.7 Significant changes and cancellation

A proposed significant change never overwrites current confirmed details immediately. Store the proposal against the base event version, assess impact, build a versioned replacement plan naming each affected venue booking and technical request, and obtain the required venue/technical reviews.

Approval of a plan is not application. During explicit apply, lock the event and affected resources; recheck event, proposal, plan, review and resource versions; validate all target arrangements; then replace only the arrangements named by the reviewed plan. Any failure rolls back the entire operation and preserves the previous complete arrangement.

After application, the safety approval is invalid and the event returns to `PLANNING`. It must pass the safety review again before preparation and reconfirmation. Notify attendees only about applied changes, not proposed dates or venues. Retain registrations under the provisional policy, but block capacity reduction below confirmed registrations plus active invitation holds.

The Event Organiser may request cancellation at any time; the assigned coordinator approves or rejects the request. The assigned coordinator may also cancel an event directly with a recorded reason. An organiser's withdrawal before confirmation is handled as a cancellation request (Q9). Cancellation releases active holds, venue bookings and equipment commitments, closes registrations and offers, closes pending changes and open safety reviews, records history and sends audience-appropriate notifications. A never-confirmed request may be rejected; a previously confirmed event must use cancellation rather than rejection.

### 5.8 Coordinator assignment

- Submitted events enter the unassigned queue, ordered oldest first. Events are not assigned automatically.
- An Event Coordinator Lead reviews basic event information and assigns exactly one active coordinator. An event has at most one coordinator at any time.
- A Lead may reassign the coordinator in any non-terminal state. Coordinators cannot reassign events; a coordinator who needs reassignment asks a Lead through a comment or offline.
- Resubmission after clarification returns the event to its existing coordinator, not to the unassigned queue.
- Every Lead sees every coordinator, assignment and active event (Q7).
- Every assignment and reassignment writes an assignment-history row and notifies the new coordinator, the previous coordinator where there is one, and the owner.
- Events assigned before v0.8 keep their current coordinators.

### 5.9 Operational safety check

- The assigned coordinator submits an event for safety review from `PLANNING` once the preconditions in section 5.2 hold. An event without technical needs can be submitted once all its venue bookings are approved.
- Open reviews form a shared queue. Any active Safety Officer may claim one; each review round has one claimant.
- The review considers expected attendance, the capacity and layout of every booked venue, emergency access, accessibility requirements, equipment placement, crowd movement and known venue restrictions. Emergency-access information and known restrictions are recorded in `venue_details` for this purpose; if MongoDB is unavailable, the review cannot be decided until the detail can be read. The completed checklist is stored with the round.
- Outcomes: `APPROVED` moves the event to `PREPARATION` (Q6). `CHANGES_REQUESTED` returns the event to `PLANNING` with the arrangements that need rework named. `REJECTED` returns the event to `PLANNING` and means the whole safety arrangement must be reworked (Q5); ending the event still uses rejection or cancellation. Revised venue bookings or technical requests go through Venue Staff or Technical Support review again.
- The Safety Officer always gives a response; there is no review timeout.
- Any change to the event's venue bookings, technical arrangements or expected attendance invalidates a safety approval. An open review whose arrangement version is no longer current is closed as `SUPERSEDED` and the event returns to `PLANNING`, except for the replacement path in section 5.4.4, which opens a new round.
- All review rounds are preserved. Safety Officers see attendance counts but not participant personal data.

## 6. Data Ownership and Persistence

The supplied database and UML diagrams are design references and may contain errors. Use the following catalogues and actual verified migrations as the working data baseline. Never generate migrations or collections solely by copying a draft diagram.

PostgreSQL is the system of record. MongoDB holds descriptive detail that no blocking rule depends on. Each field has exactly one owning store; the other store may hold only a reference or a read copy.

### 6.1 Storage conventions

In PostgreSQL, use UUID primary keys, `timestamptz` instants and positive integer versions for mutable aggregates. Auth owns passwords; the application profile ID links to the Auth user. Draft-only mandatory fields may be null; submitted events require their mandatory data, while the coordinator stays null until a Lead assigns one.

Status and state columns use `text` with check constraints, not PostgreSQL enum types, so that lifecycle changes, including resolution of provisional decisions, remain small migrations.

Retain events, bookings, requests, registrations, assignments, safety reviews and activity after closure. Restrict deletion of referenced business records. Do not cascade deletion of an Auth account into event or audit history. JSON requirement/plan/checklist fields require bounded documented schemas and cannot replace foreign keys or allocation constraints.

### 6.2 PostgreSQL table catalogue

| Table | Ownership and key constraints |
| --- | --- |
| `profiles` | Auth-linked user ID, name, phone, active state and timestamps; no password |
| `user_roles` | Unique user/role pairs for the seven application roles; staff assignment is trusted only |
| `organisations`, `organisation_memberships` | Verified memberships; never infer membership from editable email/domain text |
| `events` | Owner, optional organization, nullable coordinator, lifecycle, requirements, timing, attendance, registration policy, publication, versions including `arrangement_version`, and confirmation history |
| `event_assignments` | Assignment history: event, coordinator, assigning Lead, assigned and ended times, optional reason |
| `clarifications` | Preserved question/response rounds with state and timestamps |
| `event_comments` | Event conversation with organizer-shared or internal visibility; not a formal approval |
| `venues` | Rule-bearing venue fields: name, location, capacity, operating hours, non-negative `setup_minutes` and `turnaround_minutes`, active state and version. Descriptive detail lives in MongoDB `venue_details` (section 6.4). |
| `venue_blocks` | Reason, time-bounded operational unavailability, note, creator, and lift/shorten history |
| `venue_bookings` | Event, venue, label, per-booking expected attendance/layout/requirements, main-space flag, event interval, stored setup/turnaround minutes, occupied range, state (`HELD` to `CANCELLED`), hold expiry/extension/reminder times, `replaces_booking_id`, requirement version, decision and preparation states |
| `equipment` | Rule-bearing equipment fields: name, category, location, nonnegative total quantity, active state and version. Specifications live in MongoDB `equipment_details`. |
| `equipment_unavailability` | Time-bounded damaged/maintenance/other unavailable quantities |
| `technical_requests` | Event requirement version, assigned reviewer, support need, decision/preparation state and version |
| `technical_request_lines` | Unique equipment lines and positive requested quantities within a technical request |
| `equipment_reservations` | Active/released interval allocations tied to a request line and event |
| `safety_reviews` | Event, round number, reviewed arrangement version, claiming Safety Officer, outcome (`OPEN`, `APPROVED`, `CHANGES_REQUESTED`, `REJECTED`, `SUPERSEDED`), bounded checklist, notes, named arrangements needing rework and timestamps |
| `registrations` | Unique event/attendee record, state, queue order, registration/withdrawal/attendance data and version |
| `waitlist_offers` | One active offer per registration with offer, expiry and response times |
| `event_change_requests` | Base event version, typed proposed values, impact, versioned replacement plan, reviews and application state |
| `event_cancellation_requests` | Requester/reviewer, reason, decision state and timestamps |
| `resource_incidents` | Type (`VENUE_BLOCK`, `BUFFER_CONFLICT`, `EQUIPMENT_UNAVAILABLE`), linked bookings, block or equipment, open/resolved state and resolution detail |
| `notifications` | Safe durable message plus unique originating domain-action key |
| `notification_recipients` | Unique notification/recipient pair and nullable `read_at` |
| `activity_logs` | Append-only actor, entity, action, safe before/after detail, request ID and time |
| `idempotency_records` | Unique actor/operation/key, request hash and stored outcome |
| `outbox_entries` | MongoDB writes waiting to be applied: target collection, document ID, PostgreSQL version, bounded payload, state, attempts, next attempt time and lease |
| `notification_deliveries` | Email/SMS delivery per notification recipient and channel: state, attempts, next attempt time, lease, provider message ID and redacted last error |

The round-robin `staff_assignment_cursors` table from earlier baselines is retired. Do not create it; if it already exists remotely, remove it with a corrective migration once no code reads it.

The initial draft diagrams include names such as `User`, `Registration`, `Event`, `VenueBooking`, `EquipmentRequest`, `EventChangeRequest`, `Notification`, `NotificationRecipient`, `ActivityLog`, `EventComments`, `Venue`, `Room` and `EventDocument`. Reconcile existing remote names carefully. Do not create duplicate singular/plural tables or keep passwords in an application `User` table. `Room` and `EventDocument` are outside the current baseline unless a ticket brings them into scope.

### 6.3 PostgreSQL invariants

| Invariant | Enforcement expectation |
| --- | --- |
| At most one coordinator per event; required from `UNDER_REVIEW` onward | Nullable coordinator, check constraint on state, and locked assignment/reassignment |
| At most one active booking per event and venue | Partial unique constraint on event and venue for `HELD`, `PENDING` and `APPROVED` |
| No active occupied-range overlap per venue | PostgreSQL range/exclusion constraint on venue and occupied range, using half-open intervals, for `HELD`, `PENDING` and `APPROVED` |
| Every hold has an expiry | Check constraint: `HELD` requires `hold_expires_at` |
| At most one main-space booking per event | Partial unique constraint on active bookings with the main-space flag |
| No equipment reservation beyond usable stock | Locked stock/commitment rows and segment-based calculation in one transaction |
| One active canonical technical request per event | Partial unique constraint and explicit versioned replacement |
| At most one open safety review per event | Partial unique constraint on `OPEN` reviews |
| One registration per event and attendee | Unique pair; re-entry updates the record under policy |
| One active waitlist offer per registration | Partial unique constraint |
| Capacity never exceeded | Event lock around every allocation-changing operation |
| One active significant change per event | Partial unique constraint across active change states |
| Replayed command does not duplicate work | Unique actor/operation/idempotency key |
| One pending outbox entry per document and version | Unique target collection, document ID and version |
| One delivery per notification, recipient and channel | Unique triple |
| Audit and inbox recipient history remains stable | Append-only audit permissions and unique recipient pairs |

Index event owner/organization/coordinator and status (including the unassigned queue: `SUBMITTED` with null coordinator); venue-booking occupied ranges and hold expiry; venue-block intervals; equipment reservation and unavailability intervals; open safety reviews; pending outbox entries and deliveries by next attempt time; registration event/state/queue order; notification recipient/read state; and activity event/time/ID. Add indexes only from real query needs and verify them with query plans when performance matters.

### 6.4 MongoDB collections

The MongoDB database is `connectsphere_dev` for shared development (M3). Automated tests use their own database (section 11). Collection names, validators and indexes are defined in `mongodb/schemas` and applied by numbered scripts in `mongodb/migrations`, which record each applied script in a `_schema_migrations` collection (M8). Never create, alter or drop collections, validators or indexes by hand or in the Atlas UI.

| Collection | Contents |
| --- | --- |
| `venue_details` | `_id` equal to the PostgreSQL venue UUID; `pg_version`; description; facilities; accessibility features; supported layouts with per-layout notes; emergency-access information; known restrictions; display-only copies of name and location |
| `equipment_details` | `_id` equal to the PostgreSQL equipment UUID; `pg_version`; specifications; technical notes; handling and setup notes; display-only copies of name and category |
| `_schema_migrations` | Applied script names and timestamps |

Every collection has a JSON Schema validator with bounded field sizes. Documents must not hold rule-bearing values (capacity, operating hours, setup/turnaround time, quantities, availability, holds or bookings), participant data or credentials. Display-only copies are refreshed by the outbox and are never used for decisions. Files such as photos or floor plans are outside the baseline (section 3.3).

### 6.5 Cross-store rules

| Rule | Detail |
| --- | --- |
| Shared identity | Venue and equipment UUIDs are generated in PostgreSQL and reused as the MongoDB `_id`. |
| Single write path | Every application write to MongoDB is an outbox entry created inside the PostgreSQL transaction of the operation that caused it, then applied after commit (section 7.3). Nothing writes to MongoDB directly from a controller. |
| Ordering | Detail edits also increase the PostgreSQL record's version. An entry carries the PostgreSQL version it reflects. Applying it is a conditional update that succeeds only when the document's `pg_version` is lower, so a late or repeated entry cannot overwrite newer data. |
| New records | A new venue or equipment item stays inactive in PostgreSQL until its detail document has been applied. |
| Reads | Models may read MongoDB directly through the detail models. A document whose `pg_version` is behind PostgreSQL is returned with a "details may be out of date" flag. |
| Rule checks | Blocking checks (capacity, availability, conflicts, quantities, readiness) read PostgreSQL only. MongoDB detail feeds warnings, search filters, the safety checklist and display. |
| Audit | Activity logs for detail edits are written in PostgreSQL in the same transaction as the outbox entry. |

## 7. Transactions and Concurrency

Use one checked-out PostgreSQL client for `BEGIN`, every related query, `COMMIT` and `ROLLBACK`. Separate client/pool calls do not form one transaction. Cross-domain work stays in the single monolith and shares the same transaction context. MongoDB is never written inside that transaction (section 7.3).

Use an explicit lock order: event IDs, then venue IDs, then equipment IDs, each in stable order. Operations that start from a venue, such as block creation or a setup/turnaround change, first read the affected event IDs, then acquire locks in the standard order and re-read the affected set; if the set has changed, the operation restarts. Scarce-resource operations should use appropriate isolation and bounded retry for serialization/deadlock failures. A retry must re-run every validation; a genuine resource conflict returns a business conflict instead of being retried blindly.

### 7.1 Atomic operations

| Operation | Changes that commit together |
| --- | --- |
| Event submission | Required-field check, lifecycle/version, activity and notification to Leads |
| Coordinator assignment/reassignment | Current state and assignee role check, coordinator change, assignment history, permission handover, activity and notification |
| Clarification/resubmission | Round, response/amendments, lifecycle, activity and notification |
| Hold create/extend/convert/expire | Overdue-hold expiry for the venue, suitability and occupied-range checks, hold state, arrangement version, activity and notification |
| Venue decision/replacement | Overdue-hold expiry, current event/venue checks, new commitment, explicit release of the replaced booking, incident resolution, arrangement version, any lifecycle move, activity and notification |
| Venue block create/lift | Block, overlap scan, incident creation or resolution, arrangement versions, safety-review supersession, activity and notification |
| Setup/turnaround change | Venue values, recomputed overlap scan for future active bookings, `BUFFER_CONFLICT` incidents, activity and notification |
| Technical approval | Every availability check, every reservation, support decision, request state, arrangement version, activity and notification |
| Safety submission/decision | Preconditions, review round, outcome, lifecycle, activity and notification |
| Registration/withdrawal/offer | Policy/capacity, registration, offer allocation/release, next invitation, activity and notification |
| Significant-change apply | Current versions/reviews, all resource checks, complete replacement, event update, safety invalidation, registration impact, activity and notification |
| Cancellation | Event state, hold/booking/equipment releases, registration/offer closure, pending-change and safety-review closure, activity and notification |
| Venue or equipment detail edit | Rule-bearing field changes and their scans, version increase, outbox entry for the detail document, activity and notification |

Never publish a success notification or response before commit. Any failure rolls back the complete operation. Notification rows and their delivery rows are created inside the transaction; email and SMS are sent only after commit (section 8).

### 7.2 Interval and equipment calculation

All scheduling uses half-open intervals. Venue availability and conflicts use each booking's occupied range: `[event_start − setup_minutes, event_end + turnaround_minutes)`, using the minutes stored on the booking (section 5.4.1).

Equipment uses the event interval without venue buffers. For equipment, split the request interval at reservation and unavailability start/end points. For each segment calculate total stock minus active reserved quantity minus unavailable quantity. The minimum across all segments is the available amount.

For example, stock is five; one reservation uses three from 09:00–10:00 and another uses three from 10:00–11:00. A 09:00–11:00 request can reserve two because the existing reservations do not overlap. Subtracting both as six across the whole interval is incorrect.

### 7.3 Applying MongoDB writes

1. The operation's PostgreSQL transaction writes its own changes and an `outbox_entries` row, then commits.
2. After commit, the request handler attempts to apply the entry once through the detail model. The response does not wait for or depend on that attempt beyond reporting whether the detail is current.
3. `jobs/mongoSyncJob.js` claims unapplied entries with a lease, applies them with the conditional update in section 6.5 and retries failures with backoff.
4. An entry that keeps failing is marked failed after a bounded number of attempts, logged without credentials and surfaced to the developer through consistency monitoring. It is never deleted silently.

| Failure | Behavior |
| --- | --- |
| MongoDB unavailable after commit | PostgreSQL changes stand; the entry is retried; reads flag the detail as possibly out of date |
| Entry applied twice or out of order | The version condition ignores the stale or repeated write |
| MongoDB unavailable during venue search or a booking decision | Results come from PostgreSQL only; layout, facility and accessibility warnings show as "not checked" (M4); blocking checks are unaffected |
| PostgreSQL transaction rolls back | No outbox entry exists, so MongoDB is never touched |

## 8. Notifications and Internal Work

Notification and recipient rows are durable data written in the originating business transaction. They are the source of truth and the in-app inbox reads them. Network failure after commit does not remove them. The frontend refreshes after relevant actions/focus and may poll while active. There is no guaranteed instant-delivery SLA in the baseline.

Email and SMS are additional channels. The originating transaction creates one `notification_deliveries` row per recipient and channel; `jobs/notificationDeliveryJob.js` sends them after commit, retries with backoff and records the outcome. Email covers every notification type. SMS is limited to urgent triggers: cancellation, and venue blocks affecting an event that starts within 48 hours (M5). Provider failure never rolls back business data or removes the in-app notification. Provider credentials stay in backend environment variables; message bodies use the same audience-safe wording as the in-app notification.

| Trigger | Required audience behavior |
| --- | --- |
| Submission | Notify owner and every Event Coordinator Lead |
| Assignment or reassignment | Notify new coordinator, previous coordinator where there is one, and owner; previous coordinator loses mutation rights |
| Clarification, response, feasibility or rejection | Notify owner/coordinator with role-appropriate wording |
| Venue or technical decision | Notify responsible queue/staff, coordinator and safe owner summary |
| Hold reminder or expiry | Notify coordinator and Venue Staff 24 hours before expiry and at expiry |
| Venue block or buffer conflict affecting a booking | Notify the affected event's coordinator and Venue Staff that alternative arrangements are required |
| Safety review submitted or decided | Notify Safety Officers on submission; notify coordinator and relevant staff of the outcome |
| Confirmation or applied significant change | Notify owner/staff and affected participants using published-safe details |
| Registration, withdrawal or waitlist offer | Notify the acting attendee without exposing other users' data |
| Cancellation | Notify owner, relevant staff and affected registered/waitlisted users |
| Resource incident | Notify responsible staff and coordinator; attendee wording contains only approved operational information |

Use a unique originating action key to prevent duplicate notifications, and the unique delivery triple (section 6.3) to prevent duplicate email or SMS. Notification possession never restores access to an event after permissions change.

Internal work such as waitlist-offer expiry, hold reminders and expiry, completion of events whose end has passed, MongoDB sync, email/SMS delivery, registration-window reconciliation and consistency monitoring stays inside the backend repository. It must use database time, durable claiming/leases and bounded batches so restarts or multiple processes cannot duplicate work. Correctness cannot rely on a browser being open or an in-memory timer; for holds, the in-transaction expiry in section 5.4.3 guarantees correctness even when the job is late. There are no public maintenance-job triggers.

## 9. Cross-Repository Development

### 9.1 Ownership

| Backend repository | Frontend repository |
| --- | --- |
| Canonical master document | Accessible synchronized master copy or pinned artifact |
| Business rules and authorization | Presentation and role-aware control visibility |
| PostgreSQL migrations, MongoDB schema scripts and seed fixtures for both stores | No separately maintained database schema |
| Routes, controllers, middleware and models | App Router pages, components and API/auth helpers |
| Unit/integration tests for business behavior | Component and browser journey tests |
| Shared-development Supabase and Atlas changes | Synthetic UI test usage through approved setup |

The frontend must not duplicate lifecycle or allocation truth. It may use types and validation helpers, but backend behavior and database constraints remain authoritative. A link to an inaccessible sibling repository is not enough context for an agent; keep the synchronized master readable in both working environments.

### 9.2 Ticket workflow

1. As soon as the prompt is received, run the design reference gate in section 10.5 and the start-of-task check of the provisional decision gate in section 10.6. For a task that creates or changes UI, do not plan, start servers or edit files until the design gate is satisfied.
2. Read the repository's `AGENTS.md` or equivalent instructions, README, this master, relevant source files and current git status.
3. Pass the startup gate in section 2.7.7 for both repositories, including the environment file check in section 2.7.6. Do not continue until it passes.
4. Read the Jira ticket, acceptance criteria, linked test cases, dependencies and relevant comments.
5. Identify the owning repository and whether coordinated work is needed in the other repository.
6. Verify current package versions, scripts, PostgreSQL schema/migrations, MongoDB collections/validators and existing implementation before designing the change.
7. After planning and before editing any file, run the plan-time check of the provisional decision gate in section 10.6 and settle any match with the developer.
8. Implement within the file-placement rules in section 2. Keep business decisions in the backend.
9. Add or update PostgreSQL migrations or MongoDB schema scripts before applying schema changes. Use namespaced synthetic fixtures.
10. Run the real repository's lint/test/build commands and the relevant role journeys.
11. Update the README if setup, scripts, environment variables or actual structure changed. Update this master if an enduring architecture or business rule changed.
12. Report the startup gate result, including the environment check; the design reference used (Figma frame and frame-to-URL mapping, existing reference page, or developer override and reason) or that the design gate did not apply; the provisional gate result (`Provisional gate: none matched`, or each matched question with the developer's choice); what changed; commands/results; database mutations; unresolved gaps; and counterpart work still required.

If Jira acceptance criteria or linked tests are inaccessible, report the exact gap. Do not invent them and do not mark the ticket complete based only on assumptions in this document.

### 9.3 Compatibility between repositories

Coordinate related frontend and backend work with the same Jira issue. Prefer additive backend changes while the frontend adopts them. Do not remove behavior still used by the other repository. Test mocks must remain clearly distinguishable from live integration and must be updated when the implemented backend behavior changes.

## 10. MCP-Assisted Agent Workflow

MCP connections assist development; they are not runtime dependencies of ConnectSphere. An agent must check whether each connection already exists and works before attempting installation or reconfiguration.

### 10.1 Connection inventory

| Server | Connection | Project use |
| --- | --- | --- |
| Jira / Atlassian | `https://mcp.atlassian.com/v2/mcp` | Site `https://yvery.atlassian.net`, project `SPM`, individual OAuth |
| Playwright | `@playwright/mcp` | Inspect and exercise approved local/test browser workflows |
| Context7 | `https://mcp.context7.com/mcp` | Retrieve version-aware documentation for installed libraries |
| Sequential Thinking | `@modelcontextprotocol/server-sequential-thinking` | Optional planning aid for complex cross-domain work |
| Supabase | `https://mcp.supabase.com/mcp?project_ref=rvwiflsedoujspmzfrbq&features=database,docs` | Project-scoped, write-enabled shared development database |
| Figma | `https://mcp.figma.com/mcp` | Read team designs (frame screenshots and design context) for UI tasks under section 10.5 |
| MongoDB | `mongodb-mcp-server@latest` through `npx` (Windows: `cmd /c npx -y mongodb-mcp-server@latest`); registered at user scope as `MongoDB`, without `--readOnly` | Write-enabled access to Atlas cluster `spm.ldi4ulx.mongodb.net` using the developer's own Atlas user; tools use `connectionId: "preconfigured"` |

The MongoDB server reads its connection string only from the developer's user-level environment variable `MDB_MCP_CONNECTION_STRING`. Agents never ask for, print, log or write that value, never place it in a configuration file or command, and report only whether the variable is set. When setting up or checking the server, agents use read tools only (`list-databases`, `list-collections`) and must not change other MCP servers or add files to the ConnectSphere repositories. After the variable or registration changes, VS Code must be fully quit and reopened. Typical failures: missing tools (restart VS Code), a timeout (IP not on Atlas Network Access), authentication failure (wrong credentials or a password that is not URL-encoded) and a permission error on writes (the Atlas user lacks the "Read and write to any database" role).

### 10.2 Usage rules

| Server | Required use and boundary |
| --- | --- |
| Jira | Read assigned work, acceptance criteria, linked tests and dependencies before implementation. Jira writes require explicit authorization. |
| Playwright | Reproduce and inspect actual role workflows with synthetic accounts. Exploratory MCP runs do not replace maintained automated tests. |
| Context7 | Inspect lockfiles first, then query documentation for the installed version. If only a nearby version is indexed, state the mismatch and confirm material differences with official documentation. |
| Sequential Thinking | Use for decomposition and edge-case review when useful. It does not verify facts, source code, acceptance criteria or test results. Do not expose private chain-of-thought; record concise decisions and checks. |
| Supabase | Inspect schema/migrations, apply reviewed versioned migrations and create/clean task-related synthetic data. Preserve project scope, migration history and team coordination. |
| MongoDB | Inspect databases, collections, validators and indexes before designing a change; create and clean task-related synthetic documents under section 10.3.2. Work only in ConnectSphere databases. |
| Figma | Read designs for UI tasks as required by section 10.5, using frame-specific links for screenshots and design context. Load the agent's Figma design-to-code instructions or skill first when one is available. Never request metadata for a whole Figma page. Figma writes (editing or creating files, Code Connect mappings) require explicit developer authorization. |

Store credentials only in private developer agent configuration. Never commit or paste tokens. A saved configuration, completed authentication and successful tool call are three different states; verify all relevant stages. Reuse working connections rather than reinstalling them.

### 10.3 Shared development database writes

#### 10.3.1 Supabase

Every developer may use an individual OAuth-authenticated, project-scoped write-enabled Supabase MCP connection for development project `rvwiflsedoujspmzfrbq`. Routine development writes needed by an assigned ticket are permitted. Production changes, broad resets, unrelated deletions and privilege administration are not implied.

| Operation | Rule |
| --- | --- |
| Inspect | Check actual schemas, constraints and migration history before designing a change |
| Change schema | Add the exact SQL to a uniquely ordered backend migration first, review it, then apply it using the supported migration capability |
| Coordinate | Check the current migration head and overlapping teammate work; serialize migration application when needed |
| Change data | Use bounded statements, explicit identifiers and transactions where supported; tag fixtures by developer/run |
| Verify permissions | Test the operation actually needed; distinguish DML, schema/DDL, transaction mode and Auth Admin capabilities |
| Handle failure | Report the exact missing permission or owner action; do not self-elevate, weaken RLS or broaden project scope |
| Finish | Report affected objects, migration/seed identifier, verification and cleanup status |

Never reset the shared project because migration history appears empty. Inspect the actual remote schema and baseline it deliberately. Do not rewrite already applied migrations; add a corrective migration.

#### 10.3.2 MongoDB Atlas

Every developer's Atlas user can write to every database on the shared cluster, so the boundary is set by these rules rather than by permissions.

| Operation | Rule |
| --- | --- |
| Scope | Work only in `connectsphere_dev` and the test databases named in section 11. Never write to `admin`, `local` or `sample_mflix`; `sample_mflix` exists only to verify MCP setup. |
| Inspect | Check actual collections, validators, indexes and `_schema_migrations` before designing a change |
| Change schema | Add a numbered script and schema file in `mongodb/` first, review it, then apply it. Never change collections, validators or indexes through MCP tools directly or in the Atlas UI. |
| Change data | Use explicit `_id` filters; tag fixture documents by developer/run; never write rule-bearing values (section 6.4) |
| Forbidden | Dropping databases or collections, unfiltered deletes or updates, and changes to Atlas users, roles or Network Access |
| Handle failure | Report the exact error and the owner action needed (section 10.1); do not work around a permission error |
| Finish | Report affected collections, script or seed identifier, verification and cleanup status |

### 10.4 Test accounts and fixtures

Use synthetic organiser, coordinator lead, coordinator, venue staff, technical support, safety officer and attendee identities. Include separate organizations, multiple coordinators and at least one multi-role user when access, assignment or reassignment behavior needs them.

Venue and equipment fixtures need both a PostgreSQL row and a matching MongoDB document with the same UUID. Create the PostgreSQL row first and apply the document through the normal outbox path or the seed script, then clean up the document before the row.

Auth account creation and database seeding are separate capabilities and are not one SQL transaction. Create login-capable accounts through supported signup or Auth Admin mechanisms, then create matching profile/role/membership data through trusted setup. Never insert, update or delete Auth-managed records directly with raw SQL.

Maintain repeatable backend seed/fixture files for both stores (`supabase/seed`, `mongodb/seed`) plus a manifest of created IDs. Make setup idempotent and record partial progress. Cleanup only records and Auth accounts owned by the current test run, in dependency-safe order. Never use a shared-database reset as routine cleanup and never send test invitations to real users.

### 10.5 Design reference gate

UI work is built from a team design reference, preferably a Figma frame. Every agent runs this gate when it receives a prompt, before planning, starting servers or editing files. Reading files, the ticket and the design is permitted while the gate runs.

#### 10.5.1 Scope

The gate applies only to tasks that create or change UI: a new page, a new component, or a change to layout, styling or visible content. It does not apply to backend work, or to integration work that connects the frontend to the backend without changing how existing UI looks. If integration work adds new visible UI, such as a new error banner component, the gate applies to that part. State in the plan whether the gate applies and why.

#### 10.5.2 Figma link in the prompt

A Figma link is any `figma.com` or `*.figma.com` URL, including `/design/`, `/file/`, `/proto/`, `/board/`, `/slides/`, `/make/` and `embed.figma.com` links, also when it appears inside pasted text.

When the prompt contains a Figma link:

1. The link must identify a frame through its `node-id`. If it identifies only a file, ask the developer for the frame link. Never request metadata for a whole Figma page; the team file is too large for an agent to read that way.
2. Retrieve the frame screenshot and design context through the Figma MCP before planning.
3. If the link cannot be opened (Figma MCP not authenticated, no file access, wrong file or node), stop and report the exact problem. Do not continue without the design.
4. If the file contains several versions of the same screen and it is unclear which one applies, ask the developer.

#### 10.5.3 No Figma link

- **Changing an existing page or component:** the existing page or component is the reference.
- **Creating a new page:** a Figma frame link pasted by the developer is the standard. Without one, use an existing ConnectSphere page with the same kind of layout (for example another list, form, detail or dashboard page), state which page will be used, and continue. If no such page exists, stop, do not edit files, and ask the developer for a Figma frame link.

The `create-next-app` starter content is not a valid reference: the template `app/page.tsx`, `next.svg`, `vercel.svg` and the default `--background`/`--foreground` tokens. Generic Tailwind or component-library defaults and the agent's own preferences are not references either.

If no design exists for the screen, the developer may explicitly instruct the agent to proceed without one. Record the override and the developer's reason in the ticket report, follow existing project conventions, and list the visual decisions the agent made so they can be reviewed.

#### 10.5.4 Page URLs from Figma frames

The URL of a page built from a Figma frame is named after the page's purpose, not copied from the frame name.

1. Determine the purpose from the frame name, the screen's contents and the ticket.
2. If the purpose matches a URL in section 3.4, use that URL exactly. For example, the "Event Discovery" frame becomes `localhost:3000/events`, "Create & Draft Event Request Form" becomes `/events/new` and a sign-in frame becomes `/login`.
3. If no listed URL fits, propose one in the same style: lowercase, hyphen-separated words, plural resource nouns and App Router dynamic segments such as `[eventId]`. Confirm it with the developer, then add it to section 3.4 in the same work item.
4. Frames that share a name: separate screens each receive their own purpose-based URL; versions of the same screen share one URL, and the developer chooses which version to build. If it is unclear which case applies, ask.
5. Visible text follows the design wording; the URL follows this section. For example, a navigation link may read "My Events" while the page remains `/my-registrations`.
6. List each frame-to-URL mapping in the ticket report, for example `5:7673 "Event Discovery" → /events`.

#### 10.5.5 Authority of the design

A design reference controls visual presentation only. Jira acceptance criteria, the business rules in this master and backend authorization still apply, and every page still needs the states required by section 3.4. In particular:

- Notes and questions written on the Figma canvas are open design discussion, not requirements.
- Design elements outside the baseline or the ticket (for example preferences, live-update indicators or footer links to unbuilt pages) are raised with the developer, not built silently.
- Names, dates and figures shown in designs are placeholder content, not data.
- Conflicts between a design and this master or Jira are surfaced to the developer as described in section 12.2.

#### 10.5.6 Follow-up prompts

Run the gate once per task. Follow-up prompts in the same task reuse the reference already confirmed. If it is unclear whether that reference still covers a follow-up request, for example a new page or component the design does not show, ask the developer.

#### 10.5.7 Design reference list

| Design | Link | Notes |
| --- | --- | --- |
| ConnectSphere screens (Figma file "SPM") | `https://www.figma.com/design/4yEqzlF2xryGHF7f9a5s7d/SPM` | One page ("Page 1") with screens grouped under attendee, organiser, coordinator, venue staff and technical support headings. Use it for context; build from frame-specific links. |

Add a row when the team creates another design file or library. Screenshot URLs returned by the Figma MCP are short-lived and private; do not paste them into Jira or committed files.

### 10.6 Provisional decision gate

Some business rules are marked **provisional** in section 12.1.1: the baseline is usable for development but awaits customer or team confirmation, and it shapes tables or the event lifecycle. This gate prevents an agent from silently building on, or silently departing from, a provisional rule. Do not add or change Jira labels for this gate; detect affected work from the ticket and the plan.

#### 10.6.1 When to check

Check twice per task:

1. **At the start**, alongside section 10.5: compare the ticket title, description and acceptance criteria with the trigger table in section 10.6.4.
2. **After planning, before editing any file**: compare the planned files, tables, columns, states and operations with the trigger table. This check catches tickets whose wording does not mention the affected rule.

If it is unclear whether a trigger applies, treat it as a match and ask.

#### 10.6.2 On a match

1. State the question and its provisional baseline in one or two sentences.
2. Ask the developer to choose: proceed on the baseline, supply a team decision, or defer the affected part of the ticket. Do not choose silently.
3. Record the choice in the ticket report. A developer's choice is recorded as a team decision; the question stays provisional until section 12.1 is updated.
4. Ask once per task. Follow-up prompts reuse the answer unless they introduce a new trigger.

#### 10.6.3 Building on a provisional rule

- Mark each dependent code location with a single comment line, `// PROVISIONAL Qn: <rule>`, and prefix dependent test names with `[Qn]`. These markers are how affected work is found when the question is resolved.
- Keep provisional rules cheap to change: `text` columns with check constraints rather than enums (section 6.1), event transitions in one transition table in `eventModel.js`, and registration capacity computed in one function in `registrationModel.js`.
- Applying a migration that encodes a provisional rule to the shared development database requires explicit developer confirmation, even after the developer has chosen to proceed on the baseline.

#### 10.6.4 Trigger table

| Q | Provisional baseline | Triggers |
| --- | --- | --- |
| Q1 | Venue Staff create holds at the coordinator's request; the coordinator submitting the booking request before expiry converts the hold (section 5.4.3) | `HELD` state or `hold_expires_at` in `venue_bookings`; hold create, convert, extend, release or expire operations in `venueModel.js`; the hold reminder or expiry job |
| Q3 | A block affecting a `PREPARATION` or `CONFIRMED` event leaves its state unchanged with a blocking incident; an approved replacement moves the event to `SAFETY_REVIEW` (section 5.4.4) | `venue_blocks` inserts or lifts that scan overlapping bookings; `VENUE_BLOCK` incidents; `replaces_booking_id`; any event state change caused by a block or replacement |
| Q4 | Every booking uses the full event interval; one booking is the main space and caps registration (section 5.4.2) | Registration capacity checks in `registrationModel.js`; per-booking interval, requirement or main-space columns in `venue_bookings`; readiness checks on the main space |
| Q6 | `PREPARATION` sits between `SAFETY_REVIEW` and `CONFIRMED`; confirmation requires preparation status `READY` (sections 5.2, 5.3) | The event state check constraint; the transition table; safety approval; the confirm action; preparation-status updates in `venue_bookings` or `technical_requests` |

#### 10.6.5 On resolution

When a provisional question is resolved: update the affected rules in sections 5 to 8 and move the question to section 12.1.4; delete its row from section 10.6.4; search both repositories for `PROVISIONAL Qn` and `[Qn]` to find dependent code and tests; raise any rework as tickets; and add a changelog entry. Remove this section when the trigger table is empty.

## 11. Verification Requirements

Jira contains ticket-specific acceptance criteria and test cases. The matrix below defines architectural regression coverage; it does not replace those ticket tests.

| Area | Minimum checks |
| --- | --- |
| Identity/access | Seven roles, multi-role user scoped per role, private draft, unrelated organization, same-organization read-only boundary, Lead sees basic queue information only, and removed access after reassignment |
| Assignment | Submission enters the unassigned queue without failing, Lead-only assignment, assignee must be an active coordinator, reassignment in non-terminal states, resubmission keeps the coordinator, assignment history and notifications |
| Draft/review | Incomplete save/reopen, required submission fields, unassigned events cannot be reviewed, repeated clarification rounds and rejection boundaries |
| Lifecycle | Feasibility enters planning, safety review required before preparation, missing readiness blocks confirmation, coordinator-only confirmation, completion after end and cancellation for previously confirmed events |
| Venues | Validation, suitability per booking, occupied range with setup/turnaround (adjacent at 12:45 allowed, 12:44 conflict), one-second overlap, buffer change flags conflicts without removing bookings, blocks never refused and never delete bookings, block incidents and replacement, rejection release, concurrent conflict attempts |
| Multiple venues | Several bookings per event, duplicate venue rejected, independent suitability and rejection, one main space, event cancellation releases all |
| Holds | Expiry required, overlapping holds rejected, conversion before expiry, overdue hold cannot convert even before the job runs, in-transaction expiry frees the venue, single extension cap, reminders |
| Safety | Submission preconditions, single claimant, approve/request changes/reject outcomes, arrangement change invalidates approval, superseded rounds, rounds preserved, no participant data exposed |
| Equipment | Segment availability, no venue buffers on equipment, overlapping/non-overlapping commitments, unavailable stock, multi-line rollback and concurrent last-stock approval |
| Registration | Window/capacity checks, capacity capped by main space, registration paused outside `CONFIRMED`, duplicate attempt, concurrent last place, FIFO invitations, expiry, withdrawal/re-entry and participant privacy |
| Changes/cancellation | Current values preserved during proposal, stale review rejection, atomic apply rollback, safety re-review after apply, capacity-reduction conflict and cancellation release |
| Notifications/history | Correct audiences, no proposed-change announcement, durability, deduplication and filtered history |
| Cross-store | PostgreSQL commits before any MongoDB write, rollback leaves MongoDB untouched, MongoDB down after commit is retried, stale or repeated entries are ignored, stale detail is flagged, new records stay inactive until detail exists, blocking checks never read MongoDB, search falls back to PostgreSQL-only results |
| Notification delivery | Email/SMS sent only after commit, one delivery per recipient and channel, retry with backoff, provider failure keeps the in-app notification, SMS only for urgent triggers |
| Database/security | Frontend cannot bypass backend or reach either store, runtime cannot grant roles/alter schema/delete audit, MongoDB validators reject rule-bearing or oversized fields, migrations and schema scripts remain compatible and fixtures in both stores clean up safely |
| UI | Loading/empty/error/conflict states, preserved form input, role-aware controls, keyboard use, mobile usability and live backend journeys |

Use unit tests for pure rules, real PostgreSQL integration tests for constraints/locks/transactions and focused Playwright journeys for complete user flows. Automated tests that need MongoDB run against a local in-memory MongoDB (`mongodb-memory-server`) locally and in CI, never against Atlas: CI runners have changing IP addresses that the Atlas Network Access list will not accept (M7). Concurrency tests require separate connections. Tests that depend on a provisional rule carry its `[Qn]` prefix (section 10.6.3). Record the actual commands, environment and results. Never claim a check ran when it did not.

## 12. Open Decisions and Change Control

### 12.1 Decisions awaiting customer/team confirmation

Customer clarifications come from the Week 1 briefing, the Week 4 project instructions, the customer clarification workbook (tabs "Session 1 Instructors version" and "Session 2" only) and the Week 7 customer changes. The customer does not expect further Release 1 changes after Week 7. Where the customer has left a matter to the team, the team's choice needs a recorded rationale.

IDs: `D` items predate v0.8, `Q` items are questions raised during the Week 7 review, `T` items are team decisions adopted in v0.8, and `M` items are MongoDB and delivery defaults adopted in v0.8 that the team has not yet confirmed.

#### 12.1.1 Provisional decisions (gated by section 10.6)

These shape tables or the event lifecycle. Development may proceed on the baseline only through the provisional decision gate.

| ID | Question | Provisional baseline |
| --- | --- | --- |
| Q1 | What action stops a tentative hold expiring, and who creates holds? | Venue Staff create holds at the coordinator's request; the coordinator submitting the booking request before expiry converts the hold |
| Q3 | What happens to a confirmed or preparing event when a block affects its venue? Must the organiser agree to the replacement? | State unchanged with a blocking incident; the coordinator chooses the replacement and informs the organiser; an approved replacement moves the event to `SAFETY_REVIEW` for reconfirmation |
| Q4 | Which capacity caps registration when an event has several venues? Can a booking cover only part of the event? | One active booking is the main space and caps registration; every booking uses the full event interval |
| Q6 | Is preparation a stage before or after confirmation? | `PREPARATION` sits between `SAFETY_REVIEW` and `CONFIRMED`; confirmation requires every active booking and technical request to be `READY` |

#### 12.1.2 Temporary baselines

These do not require the gate. Change them through section 12.2.

| ID | Decision | Temporary baseline |
| --- | --- | --- |
| Q2 | Hold duration and extension | 7 days by default, never past the start of the occupied range; one extension by Venue Staff within the same cap |
| Q5 | Safety "reject" versus "request changes" | Both return the event to `PLANNING`; reject means the whole safety arrangement is reworked, request changes names specific arrangements; ending the event still uses rejection or cancellation |
| Q7 | Lead supervision scope | One pool: every Lead sees every coordinator, assignment and active event |
| Q8 | Setup and turnaround versus operating hours | The event interval must be within operating hours; buffers are not constrained |
| Q9 | Organiser cancellation before confirmation | Allowed as a cancellation request that the assigned coordinator approves |
| D02 | Attendee publication | Explicit coordinator-controlled publication at confirmation; default unpublished |
| D04 | No technical requirements | Use `NOT_REQUIRED` only when no equipment or on-site support is requested |
| D05 | Waitlist and withdrawal | FIFO with invitation to apply rather than automatic promotion (Session 1); configurable invitation period capped at registration close; expiry withdraws; re-entry receives a new queue position |
| D07 | Organization onboarding | Trusted invitation or pre-provisioning; users cannot self-assert membership |
| D09 | Significant changes | Versioned proposal/plan reviews, explicit atomic apply, safety re-review and coordinator reconfirmation |
| D10 | Repository alignment | Confirm actual packages, scripts, environment names, migration layout and implemented routes as work proceeds |
| D11 | Jira test visibility | Resolve custom-field/test-management permissions or obtain an export before claiming ticket completion |
| M1 | MongoDB driver | Native `mongodb` driver; collection validators enforce structure, so no second schema layer (Mongoose) |
| M2 | Backend language | Stays JavaScript (CommonJS); the C4 diagrams' TypeScript labels are corrected rather than the code migrated |
| M3 | MongoDB names | Database `connectsphere_dev`; collections `venue_details` and `equipment_details`, with `_id` equal to the PostgreSQL UUID |
| M4 | Search when MongoDB is unavailable | Return PostgreSQL-only results with layout, facility and accessibility marked "not checked" |
| M5 | Notification channels | In-app for everything; email for every notification type; SMS only for cancellation and venue blocks affecting events starting within 48 hours |
| M6 | Email and SMS providers | Not chosen; decided by the first ticket that sends each channel, with environment variables added to section 2.7.2 |
| M7 | MongoDB in automated tests | `mongodb-memory-server` locally and in CI; Atlas is for development and demos only |
| M8 | MongoDB schema history | Numbered Node scripts in `mongodb/migrations` using the native driver, recorded in `_schema_migrations`; no extra migration library |

#### 12.1.3 Team decisions adopted in v0.8

| ID | Decision | Rationale |
| --- | --- | --- |
| T1 | Holds and bookings store the setup/turnaround minutes in effect at creation; buffer changes trigger a conflict scan | Keeps the exclusion constraint valid while still identifying problem bookings, as Week 7 change #1 requires |
| T2 | Existing bookings are backfilled with zero buffers before venue values are set | Makes the migration surface conflicts through the normal scan instead of failing |
| T3 | Buffers are per venue only, with no per-event override | Week 7 change #1 specifies per-venue configuration |
| T4 | Block reasons follow Week 7 change #2; blocks have no buffers | Matches the customer's listed reasons; a block already describes the unavailable period |
| T5 | Hold reminders 24 hours before expiry and at expiry | Week 7 change #4 asks for notice before or when a hold expires |
| T6 | Safety reviews form a shared queue claimed by one Safety Officer | No assignment rule was given; a claim prevents duplicate reviews |
| T7 | Any change to venue bookings, technical arrangements or expected attendance invalidates safety approval | Week 7 change #6 lists these as review factors |
| T8 | Events without technical needs can be submitted for safety review once all venue bookings are approved | Week 7 change #6 requires review after arrangements are confirmed; no technical arrangement exists to wait for |
| T9 | Only Leads reassign; coordinators may ask a Lead; reassignment allowed in any non-terminal state | Week 7 change #5 gives reassignment to the Lead |
| T10 | Events assigned before v0.8 keep their coordinators | Avoids disrupting work in progress |
| T11 | Completion runs automatically after the event end, and the coordinator may also complete manually | Session 2 defines completed as the event date/time having passed |
| T12 | New pages use `/assignments` and `/safety-reviews` | Follows the URL style in section 10.5.4 |
| T13 | Equipment reservations use the event interval without venue buffers | Session 1 set equipment transit and setup time to zero |
| T14 | The coordinator explicitly submits an event for safety review | Keeps lifecycle moves explicit, as with feasibility and confirmation |
| T15 | New holds, bookings and technical requests are created only in `PLANNING`, except replacements and significant-change plans | Prevents arrangement changes from bypassing the safety review |

#### 12.1.4 Resolved in v0.8

| ID | Decision | Resolution and source |
| --- | --- | --- |
| D01 | Cancellation lifecycle boundaries | The organiser may request cancellation at any time and the coordinator approves or rejects it (Session 1); the coordinator may cancel directly with a reason (Session 2); pre-confirmation withdrawal is Q9 |
| D03 | Venue suitability | Capacity and availability, including setup/turnaround and blocks, are blocking; layout, facilities, accessibility and hours are warnings for Venue Staff to decide (Session 1, Session 2, Week 7 change #1) |
| D06 | Disabled registration | Attendees can view the event but cannot attend without registering; the organiser decides whether registration is enabled (Session 2) |
| D08 | Multi-session or multi-room | Multiple venues per event are in scope (Week 7 change #3); multi-session and recurring events remain out of baseline |

#### 12.1.5 Superseded customer clarifications

Do not implement these earlier answers; the Week 7 changes replace them.

| Earlier clarification | Superseded by |
| --- | --- |
| Turnaround time is assumed zero or ignored (Session 1) | Week 7 change #1: configurable setup and turnaround time per venue |
| For simplicity, one venue per event (Session 1) | Week 7 change #3: multiple venues per event |
| Hold duration limits are not enforced (Sessions 1 and 2) | Week 7 change #4: every hold has an expiry |
| Coordinators are assigned automatically by the system (Sessions 1 and 2) | Week 7 change #5: unassigned queue and assignment by the Event Coordinator Lead |
| Reassignment is initiated by the assigned coordinator (Session 2) | Week 7 change #5: the Lead reassigns |
| "Approved" and "confirmed" refer to the same thing (Session 1) | Week 7 change #6: safety approval and preparation sit between resource approval and confirmation |

### 12.2 Change procedure

For an accepted customer change:

1. Record the request, decision and acceptance criteria in Jira.
2. Identify affected roles, lifecycle states, business rules, tables/constraints, notifications, frontend pages and both repositories.
3. Update the active sections of this master in place. Remove superseded instructions rather than leaving contradictory rules.
4. Update implementation, migrations, READMEs and tests together where applicable.
5. State whether the change is proposed, accepted or implemented. Implemented changes require code/database identifiers and actual verification evidence.
6. When a provisional decision is resolved, also follow section 10.6.5.

If this master, Jira, a repository README and implemented code disagree, surface the conflict. Jira controls the ticket's accepted behavior; this master controls enduring architecture/business intent; the code and migrations show current implementation; the README controls runnable repository setup. A design reference (section 10.5) controls visual presentation only. Do not silently select whichever source is easiest.

### 12.3 Changelog

| Version | Date | Status | Change |
| --- | --- | --- | --- |
| 0.8 | 2026-10-07 | Week 7 customer changes; MongoDB Atlas detail store; provisional decision gate | Applied the six Week 7 customer changes: configurable venue setup/turnaround time with occupied-range conflict checks and conflict flagging (5.4.1); venue blocks after booking with incidents and replacement (5.4.4); multiple venues per event (5.4.2); expiring tentative holds with in-transaction expiry (5.4.3); the Event Coordinator Lead role with an unassigned queue replacing round-robin assignment (5.8); and the Safety Officer role with the `SAFETY_REVIEW` and provisional `PREPARATION` states (5.2, 5.3, 5.9). Added MongoDB Atlas as a second data store for descriptive venue and equipment detail, with PostgreSQL remaining the system of record: rewrote section 1 (two stores, engines as backend modules, C4 alignment in 1.3); added `config/mongodb.js`, `mongodb/`, `jobs/` and detail/conflict/outbox models (2.2, 2.3); added Atlas prerequisites, environment variables and troubleshooting, and a new environment file check that reports only names and pass/fail (2.7.6; startup gate and troubleshooting renumbered to 2.7.7 and 2.7.8); split section 6 into PostgreSQL and MongoDB catalogues with cross-store rules (6.4, 6.5); added the outbox write path (7.3); added email/SMS delivery after commit (8); added the MongoDB MCP server and Atlas write rules (10.1–10.4). Also updated sections 3, 4.2, 4.3, 5, 9, 11, 12.1 and 12.2; added section 10.6 (provisional decision gate for Q1, Q3, Q4, Q6); recorded temporary baselines (including M1–M8), team decisions, resolved decisions (D01, D03, D06, D08) and superseded clarifications in 12.1. Jira request: none recorded (Week 7 Customer Changes document; team MongoDB setup). Compatibility: schema changes required in PostgreSQL (new `event_assignments`, `safety_reviews`, `outbox_entries` and `notification_deliveries` tables; new `venue_bookings` columns; descriptive venue and equipment fields move out of `venues` and `equipment`; occupied-range exclusion constraint replaces the event-interval constraint; one-primary-booking constraint removed; `staff_assignment_cursors` retired; seven roles) and a new MongoDB database `connectsphere_dev`. New backend variables `MONGODB_URI` and `MONGODB_DB_NAME`. No migrations or schema scripts written yet. Verified implementation/database version: none (documentation only) |
| 0.7 | 2026-09-30 | Design reference gate added | Added section 10.5: a design reference gate for UI tasks covering Figma frame links, fallback to existing pages, developer override, purpose-based page URLs, design authority, follow-up prompts and the team design reference list. Added Figma to sections 10.1 and 10.2, made the gate step 1 of the section 9.2 ticket workflow and added design precedence to section 12.2. Jira request: none (direct developer request). Compatibility: documentation only; no code or database change |
| 0.6 | 2026-09-23 | Startup gate added | Rewrote section 2.7 with the actual backend (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY`, `PORT`) and frontend (`BACKEND_URL`) environment variables, backend and end-to-end startup checks, a mandatory startup gate before ticket work and troubleshooting; added the gate to the section 9.2 ticket workflow |
| 0.5 | 2026-09-22 | Backend coding convention added | Established the supplied backend examples as the default CommonJS, Express route → controller → model structure and writing-style reference, with safeguards against copying placeholder names or error-swallowing behavior |
| 0.4 | 2026-09-22 | Repository-aligned redesign | Rebased architecture on the backend and frontend READMEs; confirmed Next.js App Router and JavaScript/Express structures; replaced invented source trees; added current/target layouts and setup conventions; removed the API contract and runtime architecture/deployment sections |
| 0.3 | 2026-09-22 | Development access policy | Enabled project-scoped database writes for every developer and added migration, fixture and Auth-account controls |
| 0.2 | 2026-09-22 | Design baseline | Established the initial standalone architecture, business, data, workflow and MCP context |

Future changelog entries must include version, date, status, Jira request, affected sections, compatibility impact and verified implementation/database version.
