# ConnectSphere — Application Architecture Master

| Document field | Value |
| --- | --- |
| Version | 0.5 |
| Updated | 22 September 2026 |
| Status | Architecture and implementation baseline; repository verification required per ticket |
| Application style | Next.js frontend with one JavaScript/Express modular-monolith backend |
| Repositories | `connectsphere-g8t6` (frontend) and `connectsphere-events-g8t6-backend` (backend) |
| Data platform | Supabase PostgreSQL and Supabase Auth |
| Canonical copy | Backend repository; frontend consumes an accessible synchronized copy |

This document gives developers and coding agents the durable context needed to build ConnectSphere. It defines the repository layout, architectural boundaries, roles, business rules, data ownership, workflow guarantees, test expectations and agent workflow.

This document intentionally does **not** define a route-by-route API contract, request/response payload catalogue, OpenAPI specification or deployment/runtime architecture. Ticket acceptance criteria, implemented route definitions and tests determine the transport details for each feature. When a ticket changes an enduring business rule or structure, update this master in the same work item.

## 1. Architecture Decision

ConnectSphere is a **modular monolith**, not a microservices system.

- The browser application is a separate Next.js repository.
- All business operations are handled by one Node.js/Express backend application.
- The backend is started from `server.js` and is organized using the existing `routes`, `controller`, `middleware`, `model` and `config` layers.
- All business modules share one Supabase PostgreSQL database and can participate in one database transaction.
- Supabase Auth provides identity. The backend remains the authority for application roles, relationships, workflow state and business-data writes.
- Business areas are code modules inside the same backend process. Do not create independently deployed services, service-to-service APIs, separate module databases or message brokers unless a future approved architecture decision requires them.

The two repositories are a source-code ownership boundary, not a microservice boundary. The Next.js frontend is a client of the single backend monolith.

### 1.1 Confirmed technology baseline

| Area | Confirmed baseline | Agent instruction |
| --- | --- | --- |
| Frontend | Next.js App Router, React, TypeScript, `next/font`, Geist | Follow the installed versions in `package.json` and the lockfile. Do not replace Next.js with Vite or a generic SPA layout. |
| Backend | Node.js, Express-style routing, JavaScript files, nodemon development command | Preserve the JavaScript and folder conventions in the backend README unless a ticket explicitly approves a migration. |
| Database | Supabase PostgreSQL | Keep schema changes versioned in the backend repository before applying them to the shared development project. |
| Identity | Supabase Auth | Passwords and login identities remain Auth-managed; application profiles and roles remain business data. |
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
| Backend models | Supabase/PostgreSQL access, domain state changes, transactional checks and persistence rules |
| Backend configuration | Construct external clients and read validated environment configuration |
| PostgreSQL | Durable state, referential integrity, uniqueness, conflict prevention and transaction isolation |
| Supabase Auth | Signup, login, token issuance, refresh and Auth-user lifecycle |

Never put privileged database credentials, authorization decisions or scarce-resource allocation logic in browser code. Never use Next.js API routes to duplicate the core Express backend. A Next.js route handler may be introduced only for a documented frontend-specific need and must not become a second business backend.

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
│   └── supabase.js
├── controller/
│   ├── authController.js
│   ├── eventController.js
│   ├── venueController.js
│   ├── equipmentController.js
│   ├── registrationController.js
│   ├── changeRequestController.js
│   ├── notificationController.js
│   └── activityController.js
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
│   ├── equipmentModel.js
│   ├── registrationModel.js
│   ├── changeRequestModel.js
│   ├── notificationModel.js
│   └── activityModel.js
├── routes/
│   ├── authRoutes.js
│   ├── eventRoutes.js
│   ├── venueRoutes.js
│   ├── equipmentRoutes.js
│   ├── registrationRoutes.js
│   ├── changeRequestRoutes.js
│   ├── notificationRoutes.js
│   ├── activityRoutes.js
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

The `supabase` and `tests` directories are controlled extensions needed for database change history and repeatable verification. If the repositories already use different names when this document is adopted, retain the established names and update this tree rather than creating duplicates.

### 2.3 Backend placement rules

- `server.js` configures Express, shared middleware, route mounting, error handling, startup and shutdown. It must not contain feature SQL or workflow rules.
- `routes/*.js` declare route paths and middleware order. Route files must remain thin.
- `controller/*.js` deal with transport input and output. A controller must not trust actor IDs or roles supplied by the request body.
- `model/*.js` own database queries and domain changes. Cross-domain changes must share one transaction/client rather than opening unrelated writes.
- `middleware/auth.js` verifies the Supabase access token and establishes the authenticated identity.
- `middleware/authorize.js` applies role and relationship policies after authentication. Hiding a frontend button is not authorization.
- `config/supabase.js` reads private server environment values. It must not export service credentials to the frontend or log them.
- `supabase/migrations` is the only durable history for schema changes. Do not make undocumented remote-only schema edits.
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

`.next` and `node_modules` are generated directories and must remain ignored. `AGENTS.md` and `CLAUDE.md` contain repository-local agent guidance and must be read before editing. The current landing page is `app/page.tsx` until the planned `src` migration is performed.

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
│   │       ├── events/
│   │       │   ├── page.tsx
│   │       │   ├── new/page.tsx
│   │       │   └── [eventId]/page.tsx
│   │       ├── venues/
│   │       │   ├── page.tsx
│   │       │   └── [venueId]/page.tsx
│   │       ├── technical-requests/page.tsx
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

### 2.7 Local development commands

Backend:

```bash
git clone [backend-clone-url]
cd connectsphere-events-g8t6-backend
npm install
```

Create `.env` in the backend root. The README-confirmed minimum is:

```dotenv
PORT=8000
```

Add Supabase and other server-only values under the exact names used by `config/supabase.js`; update the backend README and `.env.example` when those names are implemented. Never commit `.env`.

Start the backend:

```bash
npm run dev
```

The current backend smoke check is `GET http://localhost:8000/api/healthcheck`, which returns a successful application-health message. This health check is an operational baseline, not a complete API specification.

Frontend:

```bash
cd connectsphere-g8t6
npm install
npm run dev
```

Open `http://localhost:3000`. Use `.env.local` for frontend configuration. Any browser-exposed variable must use the repository's established Next.js public-variable convention and must never contain a service-role key, database password or private MCP credential.

Before claiming a task is verified, inspect `package.json` in the relevant repository and run its actual lint, test and build scripts. Do not invent missing scripts or infer success from the development server alone.

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

ConnectSphere manages event requests from draft through review, resource planning, confirmation, attendee registration and completion. It also handles clarification, coordinator reassignment, venue and equipment allocation, significant changes, cancellation, incidents, notifications and audit history.

### 3.1 Roles

| Code | Role | Main responsibility |
| --- | --- | --- |
| `ORGANISER` | Event Organiser (EO) | Create event requests, answer clarifications, request changes and manage registration policy |
| `COORDINATOR` | Event Coordinator (EC) | Review assigned events, coordinate resources and make lifecycle decisions |
| `VENUE_STAFF` | Venue Staff (VS) | Maintain venue data and decide venue-booking requests |
| `TECH_SUPPORT` | Technical Support Staff (TS) | Review technical needs and reserve equipment/support |
| `ATTENDEE` | Attendee (AT) | View published events and manage personal participation |

Users may hold multiple roles. There is no baseline application System Administrator role. External users may self-register as organiser or attendee only. Staff accounts and staff roles require trusted provisioning.

### 3.2 Included capabilities

- Authentication, profile provisioning, roles and organization membership.
- Draft event creation, submission, review, clarification, resubmission, feasibility acceptance, confirmation, rejection and completion.
- Automatic coordinator assignment and controlled reassignment.
- Venue catalogue, availability, suitability, booking review, conflict prevention and preparation status.
- Equipment inventory, time-based availability, technical review, reservation and preparation status.
- Attendee registration, capacity enforcement, waiting list, offers, withdrawal and attendance history.
- Significant event changes, cancellation and resource incidents.
- Durable in-app notifications and audience-filtered activity history.

### 3.3 Baseline exclusions

Payments, pricing, full reporting/export suites, general document management, recurring or multi-session events, multi-room scheduling, demographics, favorites and detailed staff rostering are outside the baseline. The draft database diagrams may show fields or tables for excluded capabilities; those diagrams are reference material, not authority to implement them.

### 3.4 Frontend surfaces

| URL | Main purpose |
| --- | --- |
| `/login`, `/signup` | Authentication and permitted external onboarding |
| `/dashboard` | Role-specific drafts, assignments and outstanding work |
| `/events`, `/events/new`, `/events/[eventId]` | Event discovery/list, creation and role-aware workspace |
| `/venues`, `/venues/[venueId]` | Venue catalogue, details, suitability and calendar information |
| `/technical-requests` | Technical review and preparation queue |
| `/my-registrations` | Current user's registrations, invitations and withdrawal actions |
| `/notifications` | Durable inbox and read state |

The event workspace should expose overview, requirements, clarification, venue, technical arrangements, changes, registrations and history according to permissions. Display current and proposed values separately. A saved draft is not submitted, a waitlist entry is not a confirmed registration, an approved resource is not a confirmed event, and an approved change is not applied until the explicit apply step succeeds.

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

| Data/action | EO | EC | VS | TS | AT |
| --- | --- | --- | --- | --- | --- |
| Private draft | Owner read/write only | No access | No access | No access | No access |
| Submitted event | Own and permitted organization events; limited editing | Assigned events | Relevant venue information | Assigned technical information | Published attendee-safe view only |
| Lifecycle decision or reassignment | No | Assigned coordinator only | No | No | No |
| Venue catalogue and decision | Read candidate data through event planning | Request/read | Maintain and decide within scope | Relevant operational read | Published summary only |
| Equipment/technical decision | State requirements | Request/refine | No decision | Assigned review and reservation | No |
| Change/cancellation request | Owner may request | Review and explicitly apply/decide | Review affected venue plan | Review affected technical plan | No |
| Participant list | Event owner | Assigned coordinator | No by default | No by default | Own registration only |
| Internal notes/history | External-safe subset | Assigned scope | Relevant portion | Relevant portion | Own/published subset only |

Same-organization visibility begins after submission and does not grant edit rights or participant personal data. Reassignment removes the previous coordinator's mutation rights immediately. Unrelated or private resources should normally respond as not found rather than confirming their existence.

### 4.3 Database and credential boundary

- The browser may communicate directly with Supabase Auth for session operations.
- Business reads and writes go through the Express backend.
- The backend uses private server configuration and least-privilege database access.
- Developer Supabase MCP permissions are separate from the application's runtime identity and end-user permissions.
- Database credentials, service-role keys and private MCP tokens must not enter frontend code, committed files, logs, Jira or chat output.
- Use parameterized queries, explicit allowed origins, bounded request sizes and redacted errors/logs.
- Audit records are append-only for the application runtime.

If the project temporarily exposes tables through a Supabase Data API, row-level security and grants must prevent the browser from bypassing backend workflow rules. The preferred application boundary remains the Express backend.

## 5. Domain Architecture and Business Rules

### 5.1 Domain-to-code mapping

The domain modules are logical groupings implemented through the existing layered backend structure.

| Domain | Primary backend files | Responsibilities |
| --- | --- | --- |
| Identity and access | `authRoutes.js`, `authController.js`, `auth.js`, `authorize.js`, `userModel.js` | Auth context, profile, roles, memberships and relationship checks |
| Events | `eventRoutes.js`, `eventController.js`, `eventModel.js` | Drafts, review, clarification, lifecycle, coordinator and readiness |
| Venues | `venueRoutes.js`, `venueController.js`, `venueModel.js` | Catalogue, blocks, suitability, bookings, decisions and preparation |
| Technical/equipment | `equipmentRoutes.js`, `equipmentController.js`, `equipmentModel.js` | Inventory, unavailable stock, technical requests, reservations and preparation |
| Registration | `registrationRoutes.js`, `registrationController.js`, `registrationModel.js` | Registration policy, capacity, queue, offers, withdrawal and attendance |
| Changes/cancellation | `changeRequestRoutes.js`, `changeRequestController.js`, `changeRequestModel.js` | Proposals, impact plans, staff reviews, explicit application and cancellation |
| Notifications/history | `notificationRoutes.js`, `activityRoutes.js` and matching controllers/models | Durable inbox, recipients, read state and audience-filtered history |

A feature may touch several domain files, but it remains one in-process workflow. Controllers coordinate through shared model operations and one transaction for atomic cross-domain changes.

### 5.2 Event lifecycle

Canonical states are:

`DRAFT`, `SUBMITTED`, `UNDER_REVIEW`, `AWAITING_CLARIFICATION`, `PLANNING`, `CONFIRMED`, `COMPLETED`, `REJECTED`, `CANCELLED`.

There is no separate event-level `APPROVED` state. Feasibility acceptance enters `PLANNING`; only final coordinator confirmation enters `CONFIRMED`.

| Action | Actor | Preconditions | Result and required effects |
| --- | --- | --- | --- |
| Save draft | EO owner | Valid supplied fields; incomplete fields allowed | Remain `DRAFT`; persist only accepted changes |
| Submit | EO owner | Required fields complete; eligible coordinator exists | Assign exactly one coordinator and enter `SUBMITTED` atomically |
| Start review | Assigned EC | `SUBMITTED` | Enter `UNDER_REVIEW` and record review start |
| Request clarification | Assigned EC | `UNDER_REVIEW` | Store a new round, enter `AWAITING_CLARIFICATION`, notify EO |
| Respond/resubmit | EO owner | Open clarification; valid amendments | Preserve event/coordinator, mark round responded, return to `SUBMITTED` |
| Accept feasibility | Assigned EC | Sufficient reviewed requirements | Enter `PLANNING`; do not confirm automatically |
| Reject | Assigned EC | Never previously confirmed; active pre-confirmation state | Enter `REJECTED`; release active arrangements and preserve history |
| Confirm | Assigned EC | `PLANNING`; every readiness check passes | Enter `CONFIRMED`, store confirmation snapshot and notify relevant users |
| Complete | Assigned EC | Confirmed event has ended; no unapplied blocking change | Enter `COMPLETED` and close registration |
| Apply significant change | Assigned EC | Versioned proposal and plan fully reviewed; all rechecks pass | Replace arrangements atomically and return to `PLANNING` for reconfirmation |
| Cancel | Authorized EC through agreed policy | Active eligible event and reason | Enter `CANCELLED`; release resources and close registrations/offers |

Submission requires title, purpose, start/end interval, positive expected attendance and venue/layout requirements. Coordinator assignment uses one deterministic, transaction-protected round-robin cursor. If no eligible coordinator exists, submission fails and the draft remains unchanged.

Clarification preserves all question/response rounds. Do not start new planning arrangements while clarification is outstanding. Ordinary comments cannot substitute for formal review steps.

After submission, ordinary descriptive/contact changes may be permitted. Date, duration, attendance, venue/layout and equipment changes are significant and must use the reviewed change workflow, except when explicitly amended during the pre-planning clarification loop.

### 5.3 Readiness and publication

Confirmation requires:

- an approved, suitable and non-conflicting venue;
- approved equipment and support arrangements for every requested technical need;
- matching current requirement versions;
- valid registration settings when registration is enabled;
- no unresolved blocking incident;
- no approved but unapplied significant change.

If no technical need exists, the provisional state is `NOT_REQUIRED`. Preparation progress is separate from approval and may continue after confirmation.

Attendee discovery is limited to events that are both confirmed and explicitly published. A new event defaults to unpublished until the assigned coordinator chooses publication. Existing participants retain an attendee-safe history if an event returns to planning, completes or is cancelled.

### 5.4 Venue rules

- The baseline treats each venue as one independently bookable space; the draft `Room` entity is not authoritative.
- Capacity, supported layout, required facilities/accessibility, operating hours, active blocks and overlapping bookings contribute to suitability.
- Availability search is advisory. The database recheck inside the decision transaction is authoritative.
- Time ranges are half-open: `[start, end)`. Adjacent bookings are allowed; overlapping bookings are not.
- At most one pending or approved primary venue booking exists for an event.
- Venue rejection releases the rejected commitment but keeps the event in planning so an alternative can be selected.
- A new operational block may create an incident for an existing event; it must not silently erase the event's booking.

### 5.5 Equipment and technical-support rules

- Inventory total is not the same as interval availability.
- Availability equals total usable stock minus active reservations and applicable unavailability during every segment of the requested interval.
- All lines in one technical approval succeed and reserve atomically or all fail.
- Damaged or maintenance stock is represented explicitly and is not double-counted.
- Support-only requests still require technical review when on-site support is requested.
- Resource approval does not confirm the event. The assigned coordinator performs final confirmation after all readiness checks pass.

### 5.6 Registration and waiting-list rules

- Registration requires a confirmed, published event, enabled registration, an open registration window and an active user.
- Each attendee has one registration record per event. A withdrawn attendee may re-enter only under the agreed policy and receives a new queue position.
- Capacity changes, registration, withdrawal, offer acceptance and invitation allocation lock the event and recheck capacity.
- When capacity is full, eligible users join a FIFO waitlist.
- An invitation reserves a place until accepted, declined, expired or cancelled.
- Accepting an expired invitation cannot consume capacity even if the expiry job has not yet run.
- Withdrawal or expiry may invite the next eligible waiting attendee in the same transaction.
- Attendees can view only their own registration, invitation and queue information.

### 5.7 Significant changes and cancellation

A proposed significant change never overwrites current confirmed details immediately. Store the proposal against the base event version, assess impact, build a versioned replacement plan and obtain the required venue/technical reviews.

Approval of a plan is not application. During explicit apply, lock the event and affected resources; recheck event, proposal, plan, review and resource versions; validate all target arrangements; then replace only the arrangements named by the reviewed plan. Any failure rolls back the entire operation and preserves the previous complete arrangement.

After application, return the event to planning for coordinator reconfirmation. Notify attendees only about applied changes, not proposed dates or venues. Retain registrations under the provisional policy, but block capacity reduction below confirmed registrations plus active invitation holds.

Cancellation releases active venue/equipment commitments, closes registrations and offers, closes pending changes, records history and sends audience-appropriate notifications. A never-confirmed request may be rejected; a previously confirmed event must use cancellation rather than rejection.

## 6. Data Ownership and Persistence

The supplied database and UML diagrams are design references and may contain errors. Use the following catalogue and actual verified migrations as the working data baseline. Never generate migrations solely by copying a draft diagram.

### 6.1 Storage conventions

Use UUID primary keys, `timestamptz` instants and positive integer versions for mutable aggregates. Auth owns passwords; the application profile ID links to the Auth user. Draft-only mandatory fields may be null; submitted events require their mandatory data and one coordinator.

Retain events, bookings, requests, registrations and activity after closure. Restrict deletion of referenced business records. Do not cascade deletion of an Auth account into event or audit history. JSON requirement/plan fields require bounded documented schemas and cannot replace foreign keys or allocation constraints.

### 6.2 Table catalogue

| Table | Ownership and key constraints |
| --- | --- |
| `profiles` | Auth-linked user ID, name, phone, active state and timestamps; no password |
| `user_roles` | Unique user/role pairs for the five application roles; staff assignment is trusted only |
| `organisations`, `organisation_memberships` | Verified memberships; never infer membership from editable email/domain text |
| `staff_assignment_cursors` | Transaction-locked cursor for deterministic coordinator rotation |
| `events` | Owner, optional organization, coordinator, lifecycle, requirements, timing, attendance, registration policy, publication, versions and confirmation history |
| `clarifications` | Preserved question/response rounds with state and timestamps |
| `event_comments` | Event conversation with organizer-shared or internal visibility; not a formal approval |
| `venues` | Venue details, capacity, facilities, accessibility, layouts, operating hours, active state and version |
| `venue_blocks` | Time-bounded operational unavailability and release history |
| `venue_bookings` | Event/venue interval, requirement version, decision/preparation states and replacement history |
| `equipment` | Equipment identity, category/location, nonnegative total quantity, active state and version |
| `equipment_unavailability` | Time-bounded damaged/maintenance/other unavailable quantities |
| `technical_requests` | Event requirement version, assigned reviewer, support need, decision/preparation state and version |
| `technical_request_lines` | Unique equipment lines and positive requested quantities within a technical request |
| `equipment_reservations` | Active/released interval allocations tied to a request line and event |
| `registrations` | Unique event/attendee record, state, queue order, registration/withdrawal/attendance data and version |
| `waitlist_offers` | One active offer per registration with offer, expiry and response times |
| `event_change_requests` | Base event version, typed proposed values, impact, versioned replacement plan, reviews and application state |
| `event_cancellation_requests` | Requester/reviewer, reason, decision state and timestamps |
| `resource_incidents` | Open/resolved venue or equipment conflicts affecting readiness |
| `notifications` | Safe durable message plus unique originating domain-action key |
| `notification_recipients` | Unique notification/recipient pair and nullable `read_at` |
| `activity_logs` | Append-only actor, entity, action, safe before/after detail, request ID and time |
| `idempotency_records` | Unique actor/operation/key, request hash and stored outcome |

The initial draft diagrams include names such as `User`, `Registration`, `Event`, `VenueBooking`, `EquipmentRequest`, `EventChangeRequest`, `Notification`, `NotificationRecipient`, `ActivityLog`, `EventComments`, `Venue`, `Room` and `EventDocument`. Reconcile existing remote names carefully. Do not create duplicate singular/plural tables or keep passwords in an application `User` table. `Room` and `EventDocument` are outside the current baseline unless a ticket brings them into scope.

### 6.3 Database invariants

| Invariant | Enforcement expectation |
| --- | --- |
| One coordinator after draft submission | Non-null coordinator plus locked assignment/reassignment |
| One active primary venue booking per event | Partial unique constraint for pending/approved records |
| No active booking overlap per venue | PostgreSQL range/exclusion constraint using half-open intervals |
| No equipment reservation beyond usable stock | Locked stock/commitment rows and segment-based calculation in one transaction |
| One active canonical technical request per event | Partial unique constraint and explicit versioned replacement |
| One registration per event and attendee | Unique pair; re-entry updates the record under policy |
| One active waitlist offer per registration | Partial unique constraint |
| Capacity never exceeded | Event lock around every allocation-changing operation |
| One active significant change per event | Partial unique constraint across active change states |
| Replayed command does not duplicate work | Unique actor/operation/idempotency key |
| Audit and inbox recipient history remains stable | Append-only audit permissions and unique recipient pairs |

Index event owner/organization/coordinator and status; venue-booking intervals; equipment reservation and unavailability intervals; registration event/state/queue order; notification recipient/read state; and activity event/time/ID. Add indexes only from real query needs and verify them with query plans when performance matters.

## 7. Transactions and Concurrency

Use one checked-out database client for `BEGIN`, every related query, `COMMIT` and `ROLLBACK`. Separate client/pool calls do not form one transaction. Cross-domain work stays in the single monolith and shares the same transaction context.

Use an explicit lock order: event IDs, then venue IDs, then equipment IDs, each in stable order. Scarce-resource operations should use appropriate isolation and bounded retry for serialization/deadlock failures. A retry must re-run every validation; a genuine resource conflict returns a business conflict instead of being retried blindly.

### 7.1 Atomic operations

| Operation | Changes that commit together |
| --- | --- |
| Event submission | Required-field check, coordinator assignment, lifecycle/version, activity and notification |
| Clarification/resubmission | Round, response/amendments, lifecycle, activity and notification |
| Venue decision/replacement | Current event/venue checks, new commitment, explicit old release, activity and notification |
| Technical approval | Every availability check, every reservation, support decision, request state, activity and notification |
| Registration/withdrawal/offer | Policy/capacity, registration, offer allocation/release, next invitation, activity and notification |
| Significant-change apply | Current versions/reviews, all resource checks, complete replacement, event update, registration impact, activity and notification |
| Cancellation | Event state, resource releases, registration/offer closure, pending-change closure, activity and notification |

Never publish a success notification or response before commit. Any failure rolls back the complete operation.

### 7.2 Interval and equipment calculation

All scheduling uses half-open intervals. For equipment, split the request interval at reservation and unavailability start/end points. For each segment calculate total stock minus active reserved quantity minus unavailable quantity. The minimum across all segments is the available amount.

For example, stock is five; one reservation uses three from 09:00–10:00 and another uses three from 10:00–11:00. A 09:00–11:00 request can reserve two because the existing reservations do not overlap. Subtracting both as six across the whole interval is incorrect.

## 8. Notifications and Internal Work

Notification and recipient rows are durable data written in the originating business transaction. Network failure after commit does not remove them. The frontend refreshes after relevant actions/focus and may poll while active. There is no guaranteed instant-delivery SLA in the baseline.

| Trigger | Required audience behavior |
| --- | --- |
| Submission, assignment or reassignment | Notify owner and current coordinator; previous coordinator loses mutation rights |
| Clarification, response, feasibility or rejection | Notify owner/coordinator with role-appropriate wording |
| Venue or technical decision | Notify responsible queue/staff, coordinator and safe owner summary |
| Confirmation or applied significant change | Notify owner/staff and affected participants using published-safe details |
| Registration, withdrawal or waitlist offer | Notify the acting attendee without exposing other users' data |
| Cancellation | Notify owner, relevant staff and affected registered/waitlisted users |
| Resource incident | Notify responsible staff and coordinator; attendee wording contains only approved operational information |

Use a unique originating action key to prevent duplicate notifications. Notification possession never restores access to an event after permissions change.

Internal work such as waitlist-offer expiry, registration-window reconciliation and consistency monitoring stays inside the backend repository. It must use database time, durable claiming/leases and bounded batches so restarts or multiple processes cannot duplicate work. Correctness cannot rely on a browser being open or an in-memory timer. There are no public maintenance-job triggers.

## 9. Cross-Repository Development

### 9.1 Ownership

| Backend repository | Frontend repository |
| --- | --- |
| Canonical master document | Accessible synchronized master copy or pinned artifact |
| Business rules and authorization | Presentation and role-aware control visibility |
| Database migrations and seed fixtures | No separately maintained database schema |
| Routes, controllers, middleware and models | App Router pages, components and API/auth helpers |
| Unit/integration tests for business behavior | Component and browser journey tests |
| Shared-development database changes | Synthetic UI test usage through approved setup |

The frontend must not duplicate lifecycle or allocation truth. It may use types and validation helpers, but backend behavior and database constraints remain authoritative. A link to an inaccessible sibling repository is not enough context for an agent; keep the synchronized master readable in both working environments.

### 9.2 Ticket workflow

1. Read the repository's `AGENTS.md` or equivalent instructions, README, this master, relevant source files and current git status.
2. Read the Jira ticket, acceptance criteria, linked test cases, dependencies and relevant comments.
3. Identify the owning repository and whether coordinated work is needed in the other repository.
4. Verify current package versions, scripts, schema/migrations and existing implementation before designing the change.
5. Implement within the file-placement rules in section 2. Keep business decisions in the backend.
6. Add or update migrations before applying schema changes. Use namespaced synthetic fixtures.
7. Run the real repository's lint/test/build commands and the relevant role journeys.
8. Update the README if setup, scripts or actual structure changed. Update this master if an enduring architecture or business rule changed.
9. Report what changed, commands/results, database mutations, unresolved gaps and counterpart work still required.

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

### 10.2 Usage rules

| Server | Required use and boundary |
| --- | --- |
| Jira | Read assigned work, acceptance criteria, linked tests and dependencies before implementation. Jira writes require explicit authorization. |
| Playwright | Reproduce and inspect actual role workflows with synthetic accounts. Exploratory MCP runs do not replace maintained automated tests. |
| Context7 | Inspect lockfiles first, then query documentation for the installed version. If only a nearby version is indexed, state the mismatch and confirm material differences with official documentation. |
| Sequential Thinking | Use for decomposition and edge-case review when useful. It does not verify facts, source code, acceptance criteria or test results. Do not expose private chain-of-thought; record concise decisions and checks. |
| Supabase | Inspect schema/migrations, apply reviewed versioned migrations and create/clean task-related synthetic data. Preserve project scope, migration history and team coordination. |

Store credentials only in private developer agent configuration. Never commit or paste tokens. A saved configuration, completed authentication and successful tool call are three different states; verify all relevant stages. Reuse working connections rather than reinstalling them.

### 10.3 Shared development database writes

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

### 10.4 Test accounts and fixtures

Use synthetic organiser, coordinator, venue staff, technical support and attendee identities. Include separate organizations and multiple staff identities when access or reassignment behavior needs them.

Auth account creation and database seeding are separate capabilities and are not one SQL transaction. Create login-capable accounts through supported signup or Auth Admin mechanisms, then create matching profile/role/membership data through trusted setup. Never insert, update or delete Auth-managed records directly with raw SQL.

Maintain repeatable backend seed/fixture files plus a manifest of created IDs. Make setup idempotent and record partial progress. Cleanup only records and Auth accounts owned by the current test run, in dependency-safe order. Never use a shared-database reset as routine cleanup and never send test invitations to real users.

## 11. Verification Requirements

Jira contains ticket-specific acceptance criteria and test cases. The matrix below defines architectural regression coverage; it does not replace those ticket tests.

| Area | Minimum checks |
| --- | --- |
| Identity/access | Five roles, multi-role user, private draft, unrelated organization, same-organization read-only boundary and removed access after reassignment |
| Draft/review | Incomplete save/reopen, required submission fields, atomic coordinator assignment, repeated clarification rounds and rejection boundaries |
| Lifecycle | Feasibility enters planning, missing readiness blocks confirmation, coordinator-only confirmation, completion after end and cancellation for previously confirmed events |
| Venues | Validation, suitability, holds/blocks, rejection release, adjacent intervals, one-second overlap and concurrent conflict attempts |
| Equipment | Segment availability, overlapping/non-overlapping commitments, unavailable stock, multi-line rollback and concurrent last-stock approval |
| Registration | Window/capacity checks, duplicate attempt, concurrent last place, FIFO invitations, expiry, withdrawal/re-entry and participant privacy |
| Changes/cancellation | Current values preserved during proposal, stale review rejection, atomic apply rollback, capacity-reduction conflict and cancellation release |
| Notifications/history | Correct audiences, no proposed-change announcement, durability, deduplication and filtered history |
| Database/security | Frontend cannot bypass backend, runtime cannot grant roles/alter schema/delete audit, migrations remain compatible and fixtures clean up safely |
| UI | Loading/empty/error/conflict states, preserved form input, role-aware controls, keyboard use, mobile usability and live backend journeys |

Use unit tests for pure rules, real PostgreSQL integration tests for constraints/locks/transactions and focused Playwright journeys for complete user flows. Concurrency tests require separate connections. Record the actual commands, environment and results. Never claim a check ran when it did not.

## 12. Open Decisions and Change Control

### 12.1 Decisions awaiting customer/team confirmation

| ID | Decision | Temporary baseline |
| --- | --- | --- |
| D01 | Cancellation lifecycle boundaries | Reviewed organiser cancellation for assigned nonterminal requests; coordinator operational cancellation for confirmed/previously confirmed active events |
| D02 | Attendee publication | Explicit coordinator-controlled publication at confirmation; default unpublished |
| D03 | Venue suitability | Required capacity/layout/facility/accessibility/hours are blocking; free-text needs require staff review |
| D04 | No technical requirements | Use `NOT_REQUIRED` only when no equipment or on-site support is requested |
| D05 | Waitlist and withdrawal | Configurable invitation period capped at registration close; expiry withdraws; re-entry receives a new queue position |
| D06 | Disabled registration | View-only; do not infer walk-in entitlement; do not disable while registrations exist without an agreed handling rule |
| D07 | Organization onboarding | Trusted invitation or pre-provisioning; users cannot self-assert membership |
| D08 | Multi-session or multi-room | Out of baseline; introducing it requires coordinated data, workflow and UI redesign |
| D09 | Significant changes | Versioned proposal/plan reviews, explicit atomic apply and coordinator reconfirmation |
| D10 | Repository alignment | Confirm actual packages, scripts, environment names, migration layout and implemented routes as work proceeds |
| D11 | Jira test visibility | Resolve custom-field/test-management permissions or obtain an export before claiming ticket completion |

### 12.2 Change procedure

For an accepted customer change:

1. Record the request, decision and acceptance criteria in Jira.
2. Identify affected roles, lifecycle states, business rules, tables/constraints, notifications, frontend pages and both repositories.
3. Update the active sections of this master in place. Remove superseded instructions rather than leaving contradictory rules.
4. Update implementation, migrations, READMEs and tests together where applicable.
5. State whether the change is proposed, accepted or implemented. Implemented changes require code/database identifiers and actual verification evidence.

If this master, Jira, a repository README and implemented code disagree, surface the conflict. Jira controls the ticket's accepted behavior; this master controls enduring architecture/business intent; the code and migrations show current implementation; the README controls runnable repository setup. Do not silently select whichever source is easiest.

### 12.3 Changelog

| Version | Date | Status | Change |
| --- | --- | --- | --- |
| 0.5 | 2026-09-22 | Backend coding convention added | Established the supplied backend examples as the default CommonJS, Express route → controller → model structure and writing-style reference, with safeguards against copying placeholder names or error-swallowing behavior |
| 0.4 | 2026-09-22 | Repository-aligned redesign | Rebased architecture on the backend and frontend READMEs; confirmed Next.js App Router and JavaScript/Express structures; replaced invented source trees; added current/target layouts and setup conventions; removed the API contract and runtime architecture/deployment sections |
| 0.3 | 2026-09-22 | Development access policy | Enabled project-scoped database writes for every developer and added migration, fixture and Auth-account controls |
| 0.2 | 2026-09-22 | Design baseline | Established the initial standalone architecture, business, data, workflow and MCP context |

Future changelog entries must include version, date, status, Jira request, affected sections, compatibility impact and verified implementation/database version.
