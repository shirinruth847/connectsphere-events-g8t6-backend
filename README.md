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

HTTP 200 confirms both stores: the Supabase key is accepted and MongoDB answers a `ping`. Without `MONGODB_URI`, or when Atlas is unreachable, it returns `500 INTERNAL_ERROR` and the backend log names the cause.
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

HTTP 200 confirms both stores: the Supabase key is accepted and MongoDB answers a `ping`. Without `MONGODB_URI`, or when Atlas is unreachable, it returns `500 INTERNAL_ERROR` and the backend log names the cause.

### Event Requests (SPM-35, SPM-36, SPM-37)

These routes require an `ORGANISER` bearer token, except `GET /api/events/:id`, which follows the SPM-33 viewing rules below. All use the error shape described under Authentication. Request and response fields are camelCase. Coordinators separately read their own assigned events through `GET /api/events/assigned`. Lead queue, assignment and reassignment routes exist only when `ENABLE_COORDINATOR_WORKFLOWS=true`; shared development sets it, because SPM-33's coordinator view needs assigned events.

The attendee discovery routes, `GET /api/events/discovery` and `GET /api/events/discovery/:id` (SPM-34), require an `ATTENDEE` bearer token instead.

| Method & path | Input | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/events` | Event fields; `Idempotency-Key` header | `201 { message, event }`, organiser event includes `statusLabel: "Submitted"` | `400 VALIDATION_FAILED`, `409 IDEMPOTENCY_KEY_REUSED` |
| `POST /api/events/drafts` | Any event fields, `title` required; `Idempotency-Key` header | `201 { message, event, savedAt }`, status `DRAFT` | `400`, `409 IDEMPOTENCY_KEY_REUSED` |
| `PUT /api/events/:id/draft` | Changed fields, plus `"isAutoSave": true` from the idle timer. Optional `version` and `Idempotency-Key` (see SPM-33) | `200 { message, event, savedAt }`; auto-saves skip the activity log | `400`, `403` (see SPM-33), `404 EVENT_NOT_FOUND`, `409 EVENT_VERSION_CONFLICT` |
| `PUT /api/events/:id/submit` | Final edits or `{}` | `200 { message, event }`, organiser event includes `statusLabel: "Submitted"` | `400` (draft unchanged), `404`, `409 EVENT_NOT_DRAFT` |
| `GET /api/events/:id` | — | `200 { event }` with `isOwner`, `version`, `viewerRelationship` and `permissions` | `404 EVENT_NOT_FOUND` (missing, or outside the user's viewing scope) |
| `GET /api/events/mine` | `?status=<event status>` or `?label=<organiser label>`, `?limit=1..100` (default 50), `?cursor=<nextCursor>` | `200 { events: [{ eventId, requestId, statusLabel, statusNote, title, startDatetime, endDatetime, expectedAttendance, organisation, isOwner, createdAt, updatedAt }], nextCursor }`, newest edit first; the stored `status` is not returned to organisers | `400 VALIDATION_FAILED` (including `offset`, which this list does not accept) |
| `GET /api/events/discovery` | `?limit=1..100` (default 50), `?cursor=<nextCursor>` | `200 { events: [{ eventId, title, description, startDatetime, endDatetime, organisationName, location, registrationAvailability }], nextCursor }`, soonest start first (ties by event ID) | `400 VALIDATION_FAILED`, `401 UNAUTHENTICATED`, `403 FORBIDDEN` |
| `GET /api/events/discovery/:id` | — | `200 { event: { eventId, title, description, startDatetime, endDatetime, organisationName, registrationOpenAt, registrationCloseAt, location, registrationAvailability } }` | `404 EVENT_NOT_FOUND`, `401 UNAUTHENTICATED`, `403 FORBIDDEN` |

- **Event fields:** `title` (≤ 200 chars), `purpose` (≤ 2000), `description` (≤ 5000), `startDatetime` and `endDatetime` (ISO 8601 **with** a timezone offset, e.g. `2026-10-08T09:00:00+08:00`), `expectedAttendance` (positive whole number), `preferredLayoutType` (an existing room layout or `NO_PREFERENCE`), `accessibilityNeeds` (up to 20 short strings), `isRegistrationEnabled`, `registrationCapacity`, `venuePreferences` (ordered venue IDs) and `equipmentRequirements` (`[{ "equipmentId": number, "quantity": number }]`). Numeric strings are accepted for numbers.
- **Attendee discovery** exposes only public, published events whose status is exactly `CONFIRMED` and whose end time is still in the future, so events already in progress are listed too. Events in `PREPARATION` or any other state are hidden from the list and return `404` from the detail route (SPM-44, Master 1.5). Apply the versioned SPM-34 preparation migration before deploying to databases without the `PREPARATION` enum value, which the lifecycle still uses. The `registrationAvailability` value is one of `OPEN`, `FULL_WAITLIST`, `CLOSED`, or `NOT_ENABLED`.
- **Registration window and capacity:** registration enabled requires a capacity (DB constraint). Registration is open from `registration_open_at` up to, but not including, `registration_close_at`; `registration_open_at = null` means registration opens immediately and `registration_close_at = null` means there is no deadline. `is_registration_enabled = false` returns `NOT_ENABLED`.
- **Attendee location:** list and detail return the name and address of the unique approved venue through the existing `venue_booking → room → venue` relationship. Pending, rejected and cancelled bookings are excluded. Multiple bookings at one venue count as one location. The current schema has no primary-venue marker: if approved bookings reference multiple venues, location remains `null` until the primary-venue model is available; discovery never chooses an arbitrary venue. No booking, room or venue IDs are returned.
- **Server-controlled fields** (`status`, `organiserId`, `requestId`, …) are never silently ignored: the two `POST` routes reject them with `400`, and the update routes (`PUT /api/events/:id`, `PUT /api/events/:id/draft`) with `403 FIELD_NOT_EDITABLE` (see SPM-33).
- **Status label and note:** organiser-facing responses carry `statusLabel`, one of the eight Master section 3.5 labels, and `statusNote`: "Waiting for a coordinator" while a submitted request has no coordinator (added by SPM-33; not yet listed in the Master), "Returned – action required" while awaiting clarification, "Reconfirmation pending" when a previously confirmed event is back in `PLANNING` or `SAFETY_REVIEW` (SPM-173), otherwise `null`. Organiser event responses expose the label and note rather than stored `status`; staff responses continue to include stored status.
- **List filters:** `GET /api/events/mine` takes either `status` (a stored state) or `label` (one of the eight labels, expanded to its states on the backend, e.g. `label=Approved%20%26%20Planning` returns `PLANNING` and `SAFETY_REVIEW`), not both.
- **`Idempotency-Key`:** 8–128 characters from `A-Z a-z 0-9 . _ : -`; a UUID per form submission works. Re-sending the same key and body returns the original result with an `Idempotent-Replayed: true` header and creates nothing new. Reusing a key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- **Drafts** need only a title. Other supplied values must still be valid, so a draft may enable registration before entering a capacity.
- **Submission** leaves the request unassigned in the Leads' queue (SPM-174) and writes the event, its activity record and the receipt notification for the organiser and active Coordinator Leads in one database transaction (`submit_event_request`, which changes the state through the shared lifecycle function since SPM-173). A new request's `version` is 2 after submission, because it is created as a draft and then submitted. The database files the request under the organiser's organisation (see SPM-33). If the database rejects a submission, the `400` still carries field-level `fields`.
- **Assignment** (`POST /api/events/:id/coordinator`, Coordinator Lead only, requires `ENABLE_COORDINATOR_WORKFLOWS=true`) takes a request from the queue: in one transaction (`assign_event_coordinator`) it sets the coordinator, moves the request from `SUBMITTED` to `UNDER_REVIEW` (Master section 5.2), records the staff-only history entry `COORDINATOR_ASSIGNED` and notifies the organiser and the coordinator.
- **Paging:** pass `nextCursor` back as `cursor`; it is `null` on the last page.

### Choosing a Venue (SPM-72, SPM-74, SPM-75)

The pending venue-suggestion migration extends the existing idempotency-operation
constraint rather than replacing it with an older operation list. This preserves
clarification commands and replay records when upgrading a database that already
has the newer SPM-41 migrations. Already-applied migrations do not rerun: inspect
the target's migration history and constraint before deployment; do not replay the
whole suggestion migration against its existing table. This source fix does not
repair a database whose constraint was previously narrowed.

Coordinators and Leads search and browse venues inside each event request, starting from the organiser's ranked venue preferences. There is no separate catalogue page for them. `requireVisibleEvent` answers `404` unless the caller is the event's assigned coordinator or its supervising Lead (the Lead who made the open assignment, or any Lead for an event assigned before supervision, Master T23).

| Method & path | Access | Input | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /api/events/:id/venue-options` | Assigned `COORDINATOR`, supervising `COORDINATOR_LEAD` | Optional `search` (name or address), `minCapacity`, `layout`, `facility`, `accessibility` (these filter), `requiredFacilities` (comma-separated, up to 10; these rank and highlight, never filter), `sort` (`match` default, `name`, `capacity`, `setup`, `turnaround`), `order` (`asc`, `desc`); anything else is rejected | `200 { event, venues: [{ …catalogue fields, coverPhotoId, availability: { status, label, occupiedStart, occupiedEnd, conflicts, operatingHoursWarning }, requirements: [{ key, label, status, detail }], unmetCount, allRequirementsMet }], preferredVenues: [{ rank, venueId, name, option }], detailsAvailable, availabilityChecked, filtersNotChecked, canSuggestVenue }`; `preferredVenues` are the organiser's ranked choices whatever the filters (`option: null` when the venue is no longer available) | `400 VALIDATION_FAILED`, `401`, `403` (other roles), `404 EVENT_NOT_FOUND` |
| `GET /api/venues/options/:venueId/photos` | `COORDINATOR`, `COORDINATOR_LEAD` | — | `200 { photos: [{ photoId, position, caption, contentType, size, uploadedAt, updatedAt, version }] }` | `404 VENUE_NOT_FOUND` (venue not `ACTIVE`), `503 VENUE_PHOTOS_UNAVAILABLE` |
| `GET /api/venues/options/:venueId/photos/:photoId` | As above | — | `200` image bytes, `X-Content-Type-Options: nosniff` | `404 VENUE_NOT_FOUND`, `404 PHOTO_NOT_FOUND`, `503` |
| `PUT /api/events/:id/venue-suggestion` | Assigned `COORDINATOR` only | Body `{ venueId, version }` (`version`: the suggestion version loaded, `0` when there is none); `Idempotency-Key` header required | `200 { message, suggestion: { venueId, name, address, maxCapacity, suggestedAt, suggestedBy, version } }` | `400 VALIDATION_FAILED`, `403` (Lead and other roles), `404 EVENT_NOT_FOUND`, `409 VENUE_SUGGESTION_NOT_ALLOWED_IN_STATUS` (not `UNDER_REVIEW`/`PLANNING`), `409 VENUE_NOT_SELECTABLE`, `409 VENUE_CAPACITY_TOO_SMALL`, `409 VENUE_SUGGESTION_VERSION_CONFLICT`, `409 IDEMPOTENCY_KEY_REUSED` |

- **Available venues only:** venues with `is_active` and `status = 'ACTIVE'`, as in the catalogue below.
- **Requirements** come from the event: capacity against expected attendance, availability over the event window, the preferred layout, each accessibility need, plus the coordinator's `requiredFacilities`. Each is `MET`, `UNMET` or `NOT_CHECKED` (MongoDB unavailable, Master M4; never shown as met). Venues meeting every requirement sort first, then fewest unmet, then the chosen sort. Matching is advisory (Master 5.4); bookings recheck everything that blocks.
- **Availability** checks the event window's occupied range (setup and turnaround from MongoDB) against `PENDING`/`APPROVED` bookings and active holds and blocks, leaving out the event's own bookings and holds. A multi-day event is one occupied range from its first start to its last end, so every day is checked (Master 5.4.1, T30). `NOT_CHECKED` ("Error checking availability") when MongoDB is unavailable (`availabilityChecked: false`), `NOT_BOOKABLE` when the venue has no setup/turnaround minutes. The availability requirement's `detail` is the short label (e.g. "Available", "Unavailable – booking"). Other events' titles are never returned.
- **Suggestion** (`model/venueModel.suggestEventVenue` → RPC `suggest_event_venue`, migrations `20261023041402`, `20261023041519`, `20261023042520`): one transaction locks the event, then the venue, saves `event_venue_suggestion`, appends an `ORGANISER_SAFE` `VENUE_SUGGESTED` activity entry (`changes.suggestedVenue`: the replaced and new venue names; the change history shows it as "Venue suggested") and notifies the organiser (`VENUE_SUGGESTION`). It does not hold or book the venue or change `arrangement_version`. Suggesting the current venue again changes nothing. `GET /api/events/:id` returns `venueSuggestion` to everyone who can see the event and `permissions.canSuggestVenue`.

### Venue Catalogue (Venue Staff)

| Method & path | Access | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/venues` | `VENUE_STAFF` (coordinators and Leads use the event venue section above). Optional `?search=` (name or address), `?minCapacity=`, `?layout=`, `?facility=`, `?accessibility=`; any other parameter is rejected | `200 { venues: [{ venueId, name, address, maxCapacity, operatingHours, accessibilityFeatures, setupTurnaroundMinutes, setupMinutes, turnaroundMinutes, rooms: [{ roomId, layoutType, capacity }], detailStatus, description, facilities, supportedLayouts, emergencyAccess, knownRestrictions }], detailsAvailable, filtersNotChecked }`, ordered by name | `400 VALIDATION_FAILED`, `401 UNAUTHENTICATED`, `403 FORBIDDEN` (other roles), `500 INTERNAL_ERROR` (PostgreSQL failure) |

- **Read-only:** the catalogue changes nothing. Only Venue Staff maintain venues (SPM-73, below); bookings and equipment requests belong to SPM-179/181/186. `SAFETY_OFFICER` gets access when its ticket adds the role to `user_role`.
- **Available venues only:** PostgreSQL is the source of which venues exist. The catalogue lists venues with `is_active` and `status = 'ACTIVE'`. A venue deleted as unusable keeps its row (bookings may still reference it) with `venue.is_active = false` (migration `20261019025616_spm72_venue_active_state`); `INACTIVE` and `UNDER_MAINTENANCE` venues are left out too (SPM-73). An empty `venues` list means no venue is currently available.
- **Details:** MongoDB `venue_details` documents (`_id` = the PostgreSQL `venue_id` as a string) add the descriptive fields. `detailStatus` is the only signal for them: `CURRENT` (document read), `NOT_AVAILABLE` (no document for this venue) or `NOT_CHECKED` (MongoDB unavailable; `detailsAvailable` is then `false`, Master M4). Fields without a value are `null`. `accessibilityFeatures` is the document's list, or else the PostgreSQL accessibility note as a one-item list.
- **MongoDB outages:** a failed connection is retried on the next request, and server selection times out after 3 seconds, so the catalogue still answers from PostgreSQL.
- **Search and filters:** `search` matches name or address case-insensitively and literally (`%`, `_`, commas and brackets have no special meaning); `minCapacity` uses PostgreSQL. `layout`, `facility` and `accessibility` match any entry of the detail document's lists (layout also matches room layouts). Without MongoDB, layout and accessibility fall back to the PostgreSQL room layouts and accessibility note, and `filtersNotChecked: ["facility"]` says the facility filter was not applied.
- **Setup/turnaround:** `setupMinutes` and `turnaroundMinutes` come from MongoDB (Master 1.2, T27). `setupTurnaroundMinutes` is the legacy PostgreSQL value, read-only until it is removed.

### Venue Maintenance (SPM-73)

Venue Staff only; every other role gets `403 FORBIDDEN`, and the database re-checks the role inside each write. Needs migration `20261020090836_spm73_venue_catalogue_maintenance`.

| Method & path | Input | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/venues/manage` | `?search=` (name), `?location=` (address), `?status=ACTIVE\|INACTIVE\|UNDER_MAINTENANCE`, `?sort=name\|capacity\|updatedAt\|setupMinutes\|turnaroundMinutes` (default `name`), `?order=asc\|desc`, `?limit=1..100` (default 50), `?offset=` | `200 { venues: [venue + setupMinutes, turnaroundMinutes, coverPhotoId], nextOffset, detailsAvailable, sortNotChecked }`; every status, deleted venues excluded | `400 VALIDATION_FAILED` |
| `GET /api/venues/manage/options` | — | `200 { venues: [{ venueId, name, status }] }`: every venue not deleted, by name, for filters and pickers | `401`, `403` |
| `GET /api/venues/:venueId` | — | `200 { venue, details, detailStatus }`; `details` holds the MongoDB document's editable fields plus `version` and `updatedAt` (version `0` when no document exists), or is `null` with `detailStatus: "NOT_CHECKED"` when MongoDB is unavailable | `404 VENUE_NOT_FOUND` |
| `POST /api/venues` | `{ name, address, maxCapacity, contactPerson, contactEmail, contactNumber, status?, statusReason? }` | `201 { message, venue }`, status `ACTIVE` unless sent | `400 VALIDATION_FAILED` with `fields`, `409 VENUE_NAME_TAKEN` |
| `PUT /api/venues/:venueId` | Changed details plus the `version` loaded | `200 { message, venue, changed }` | `400`, `404`, `409 VENUE_NAME_TAKEN`, `409 VENUE_VERSION_CONFLICT` |
| `PUT /api/venues/:venueId/status` | `{ status, reason?, version, confirmUpcomingBookings? }` | `200 { message, venue, changed, upcomingBookings, affectedEvents }` | `400`, `404`, `409 VENUE_VERSION_CONFLICT`, `409 VENUE_HAS_UPCOMING_BOOKINGS` with `upcomingBookings`, `firstStart` and `affectedEvents` (`eventId`, `requestId`, `title`, `status`, `firstStart`, `bookings`) |
| `PUT /api/venues/:venueId/details` | Changed MongoDB fields (`description`, `facilities`, `accessibilityFeatures`, `supportedLayouts`, `emergencyAccess`, `knownRestrictions`, `setupMinutes`, `turnaroundMinutes`) plus the details `version` loaded (`0` for a venue without details) | `200 { message, details, changed }` | `400 VALIDATION_FAILED`, `404`, `409 VENUE_DETAILS_VERSION_CONFLICT`, `409 VENUE_BUFFERS_LOCKED` with field messages, `503 VENUE_DETAILS_UNAVAILABLE` |

`venue` is `{ venueId, name, address, maxCapacity, status, statusReason, contactPerson, contactEmail, contactNumber, version, createdAt, updatedAt, createdBy, updatedBy }`, where `createdBy` and `updatedBy` are `{ userId, name }` or `null` for venues older than SPM-73.

- **Fields:** name (≤ 150, unique in any letter case), address (≤ 255), capacity (whole number from 1 to `MAX_VENUE_CAPACITY` = 100,000 in `config/venueConstants.js`), contact person (≤ 100), and a contact email or number (both may be given). Numbers may use digits, spaces, `+`, `-` and brackets, with 7–15 digits. Messages follow the SPM-73 test cases, e.g. "Venue name is required", "Capacity must be a positive whole number", "A venue with this name already exists". Any other field, such as `createdBy` or `version` on create, is rejected with `400` rather than ignored.
- **Status:** `ACTIVE`, `INACTIVE` or `UNDER_MAINTENANCE`; `UNDER_MAINTENANCE` needs a `reason` (≤ 500). Status is separate from `is_active`, which only marks a venue deleted as unusable. Only `ACTIVE` venues appear in the catalogue and in `GET /api/events/request-options`, and only they are accepted as event venue preferences.
- **Upcoming bookings:** taking a venue out of service while it has upcoming `PENDING` or `APPROVED` bookings returns `409 VENUE_HAS_UPCOMING_BOOKINGS`, listing the affected events, until the request repeats with `"confirmUpcomingBookings": true`. Bookings and events are never changed, cancelled or removed. When a venue leaves `ACTIVE` this way, the same transaction increases each affected event's arrangement version (superseding an open safety review), adds an organiser-safe history entry and notifies its coordinator (with the reason) and organiser (without it), plus the other Venue Staff (Master 5.4.4, T32). The coordinator then liaises with the organiser about another venue. Events are locked before the venue (Master 7); if a booking appears meanwhile the database raises `40001` and the model retries up to three times.
- **Stale saves:** every change raises `version`. Send the one you loaded; an older one gets `409 VENUE_VERSION_CONFLICT`. A save that changes nothing keeps the version and writes no history.
- **Audit:** create, detail updates and status changes write the venue and one `activity_log` entry (`VENUE_CREATED`, `VENUE_UPDATED` with before/after values, `VENUE_STATUS_CHANGED` with the reason) in one transaction (`create_venue`, `update_venue`, `set_venue_status`). Entries are `STAFF_ONLY` and never appear in event history.
- **MongoDB details (Master 1.2, T27):** `PUT …/details` writes `venue_details` directly through `venueDetailModel.js`, only while its `version` still matches, then appends a `VENUE_DETAILS_UPDATED` `activity_log` entry (`STAFF_ONLY`, before/after values). Lists are trimmed and de-duplicated (facilities, accessibility and restrictions up to 50 entries, layouts up to 20); minutes are whole numbers from 0 to 1440. Setup and turnaround times are each set once (zero counts as set) and can never be changed afterwards; a change answers `409 VENUE_BUFFERS_LOCKED` (Master 5.4.1, T16). The MongoDB write re-checks that the field is still empty, so two simultaneous first saves cannot both succeed. A new venue is created `ACTIVE`; until its details have setup/turnaround minutes it cannot receive holds or bookings. Venue deletion is SPM-210.

### Venue Photo Gallery (T28, SPM-181)

Venue Staff only (`401` without a token, `403` for every other role). Photos live in MongoDB `venue_photos` (Master 6.4); the venue must exist and not be deleted, otherwise `404 VENUE_NOT_FOUND`. MongoDB down answers `503 VENUE_PHOTOS_UNAVAILABLE`.

| Method & path | Input | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/venues/:venueId/photos` | — | `200 { photos: [{ photoId, position, caption, contentType, size, uploadedAt, updatedAt, version }] }` in gallery order; position `0` is the cover | `404`, `503` |
| `GET /api/venues/:venueId/photos/:photoId` | — | `200` image bytes with the stored `Content-Type` and `X-Content-Type-Options: nosniff` | `404 PHOTO_NOT_FOUND`, `503` |
| `POST /api/venues/:venueId/photos` | Raw image body (`Content-Type: image/jpeg`, `image/png` or `image/webp`), optional `?caption=` (≤ 200) | `201 { message, photo }`, added last | `400` (empty body, caption), `413 PAYLOAD_TOO_LARGE` (over 2 MB), `415 UNSUPPORTED_MEDIA_TYPE`, `409 PHOTO_LIMIT_REACHED` (20 per venue) |
| `PUT /api/venues/:venueId/photos/:photoId` | JSON `{ caption?, position? }` (position 0–19; past the end means last) | `200 { message, photo }`; the others shift to make room | `400 VALIDATION_FAILED`, `404` |
| `PUT /api/venues/:venueId/photos/:photoId/image` | Raw image body, as for upload | `200 { message, photo }`; caption and position kept | `400`, `404`, `413`, `415` |
| `DELETE /api/venues/:venueId/photos/:photoId` | — | `200 { message }`; later photos move up, so the next one becomes the cover | `404` |

- **Type check:** the type is read from the file's own bytes (JPEG, PNG or WebP signature); a body that is not one of these is refused `415` whatever its `Content-Type` said, so HTML or SVG can never be served back.
- **Storage:** `model/venuePhotoModel.js` is the only file that touches `venue_photos`. Positions are renumbered 0..n-1 after every change. Two uploads that race past the 20-photo count are resolved after insert: the later one is removed and answers `409`.
- **Audit:** each change appends a `STAFF_ONLY` `activity_log` entry (`VENUE_PHOTO_ADDED`, `VENUE_PHOTO_UPDATED`, `VENUE_PHOTO_REPLACED`, `VENUE_PHOTO_DELETED`) after the MongoDB write; if the append fails, the change stands and the failure is logged.
- **Cover:** `GET /api/venues/manage` rows carry `coverPhotoId` (the first photo, or `null`; `null` for every row when MongoDB is down).

- **Concurrent photo edits:** migration `0005_venue_photo_galleries` adds a per-venue transaction guard. Upload, reorder, replacement and deletion share a MongoDB transaction, so the 20-photo limit and positions are checked against the latest committed gallery. Requires a replica set (Atlas or local `MongoMemoryReplSet`). Run `npm run mongo:migrate` before deploying this code; no photo backfill is needed. Deploy all backend instances together so older writers cannot bypass the guard. The migration has not been applied by this change. Rollback: stop gallery writes before reverting the code; retain guard documents until no transactional writer remains.

### Venue Availability Calendar (SPM-74)

| Method & path | Access | Input | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET /api/venues/availability` | `COORDINATOR` (from an event's venue section), `VENUE_STAFF` (`/venues?view=availability`); Coordinator Leads and every other role get `403` | `from`, `to` (ISO 8601 with offset, at most 366 days apart, so the calendar's year view loads in one request); optional `venueId` (repeated or comma-separated, up to 20; default every active venue); optional `checkStart` and `checkEnd` (a proposed booking window) | `200 { from, to, generatedAt, venues: [{ venueId, name, address, status, operatingHours, setupMinutes, turnaroundMinutes, buffersRecorded, entries, overlaps, freePeriods, summary, summaryLabel, check }] }` | `400 VALIDATION_FAILED`, `401`, `403`, `503 AVAILABILITY_UNAVAILABLE` |

- **Entries** merge PostgreSQL `PENDING`/`APPROVED` bookings with MongoDB `venue_calendar` holds and blocks. Each has a `type` (`BOOKING`, `HOLD`, `BLOCK`), a backend `label` ("Confirmed booking", "Pending booking request", "Active hold", "Expired hold", "Operational block"), the booked `start`/`end` and the `occupiedStart`/`occupiedEnd` including setup and turnaround, `blocking`, references (`bookingId`, `requestId`), `holdExpiresAt`, block `reason`/`reasonLabel`/`note` and an `operatingHoursWarning`.
- **Event titles:** Venue Staff see them; a coordinator sees only the titles of events assigned to them. Everyone sees the references.
- **Rules (Master 5.4, `model/venueConflictModel.js`):** ranges are half-open, so adjacent periods never conflict and a one-second overlap does. A booking occupies `[start − setupMinutes, end + turnaroundMinutes)`. A hold past `holdExpiresAt` is expired at read time and never blocks. Operating hours (`HH:MM-HH:MM`, Singapore time) only produce warnings. `summary` is `AVAILABLE` or the first of `UNAVAILABLE_BOOKING`, `UNAVAILABLE_HOLD`, `UNAVAILABLE_BLOCK` found in the range; `check` reports `availability` (which can also be `AVAILABLE_WITH_WARNING`), `canRequest` and the conflicting entries for the proposed window.
- **MongoDB unavailable:** the request answers `503 AVAILABILITY_UNAVAILABLE`; no venue is ever shown as available from partial data.
- **Buffers not recorded:** venues with `buffersRecorded: false` are shown with zero buffers and cannot receive holds or bookings until Venue Staff record them.

#### MongoDB scripts

- `npm run mongo:migrate` applies `mongodb/migrations/0003_venue_photos` (the `venue_photos` collection, validator and `venue_position` index; applied to `connectsphere_dev` on 2026-10-21) and, before it, `0002_venue_calendar`: it adds the minutes and `version` to the `venue_details` validator and creates `venue_calendar` with its validator and index.
- `npm run seed:venue-photos` downloads free Unsplash photos (Unsplash License, no attribution required) into `venue_photos` for the ten non-test venues, two or three each chosen to match the venue, tagged `fixture: "spm181-unsplash"`; a venue that already has photos is skipped. `npm run seed:venue-photos:cleanup` removes only those documents. The list of photos and their sources is in `mongodb/seed/venuePhotoSeed.js`.
- `npm run mongo:migrate` also applies `0004_venue_related_venues`: `venue_details.relatedVenueIds`, display-only links between venues of one building (a hall and its rooms, each its own bookable venue).
- `npm run seed:venue-rooms` (needs `npm run seed:accounts` first) creates three `[seed:dev]` halls with two to four rooms each through the Venue Staff `create_venue` RPC, sets their operating hours, saves their `venue_details` (layouts, facilities, accessibility, setup/turnaround, related venues) and photos tagged `fixture: "spm72-rooms"`, and fills `supportedLayouts` on `[seed:dev]` venues that have none, from their room layouts. A hall's capacity is its rooms plus its common area. The IDs it touches are kept in `supabase/seed/manifests/venue-rooms-<namespace>.json`; `npm run seed:venue-rooms:cleanup` takes those venues out of service (venues are never deleted), removes the fixture documents and restores layouts only when the recorded seed values and version are unchanged. Legacy ID-only manifest entries and later staff edits are preserved.
- `npm run seed:venue-calendar` copies the legacy `setup_turnaround_min` into `venue_details` (as both minutes; `[seed:dev] Grand Hall` gets 30/45 for SPM-74 TC3) and adds holds and blocks tagged `fixture: "spm74-dev"`. `npm run seed:venue-calendar:cleanup` removes only those calendar fixtures.

Database changes are recorded under `supabase/migrations/`. Do not apply ad hoc schema SQL; apply reviewed migrations to the project-scoped development database and keep the local migration history aligned with the shared branch.

### Venue Booking Review (SPM-181)

Venue Staff review the venue booking requests that coordinators raise. Every route requires a `VENUE_STAFF` bearer token; any other role gets `403 FORBIDDEN`, no session `401 UNAUTHENTICATED`. Approving and rejecting a booking (SPM-186, SPM-189) are separate action routes, one booking per request.

| Method & path | Input | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/venues/bookings` | Optional `?status=PENDING\|APPROVED\|REJECTED\|CANCELLED`, `venueId`, `eventId`, `from` and `to` (ISO 8601 with offset, both or neither, at most 31 days apart), `q` (search, at most 100 characters), `sort=default\|date\|attendance\|lastEdited\|alphabetical`, `order=asc\|desc`, `limit=1..200` (default 100). Any other parameter is rejected | `200 { bookings: [{ bookingId, label, status, statusLabel, venueId, venueName, startDatetime, endDatetime, expectedAttendance, submittedAt, updatedAt, event: { eventId, requestId, title, status, eventType, eventTypeLabel } }], hasMore, pendingCount, approvedCount }`; by default pending requests first, then the soonest booking | `400 VALIDATION_FAILED` with `fields` |
| `GET /api/venues/bookings/:bookingId` | — | `200 { booking, event, otherBookings }`: the booking with its venue, layout, required facilities, accessibility and special requirements; the event's venue-relevant details and `coordinatorName`; the other bookings under the same event with venue and status | `404 BOOKING_NOT_FOUND` |
| `GET /api/venues/bookings/events/:eventId` | — | `200 { event, bookings }`: every booking under the event, each with its own status | `404 EVENT_NOT_FOUND` (no bookings, missing, or a draft) |
| `POST /api/venues/bookings/:bookingId/approve` | Optional `{ expectedStatus: "PENDING" }`; any other field is rejected | `200 { message, booking, event, otherBookings }` | `400 VALIDATION_FAILED`, `404 BOOKING_NOT_FOUND`, `409 BOOKING_ALREADY_DECIDED` (with `currentStatus`), `409 EVENT_NOT_IN_PLANNING`, `VENUE_NOT_AVAILABLE`, `VENUE_CAPACITY_EXCEEDED`, `VENUE_BUFFERS_NOT_SET`, `VENUE_BOOKING_CONFLICT`, `VENUE_BLOCKED`, `503 VENUE_DETAILS_UNAVAILABLE` |
| `POST /api/venues/bookings/:bookingId/reject` | `{ reason, expectedStatus }`: `reason` 1–1000 characters (may include suggested alternatives); `expectedStatus` is `PENDING` or `APPROVED`, the status the user saw | `200 { message, booking, event, otherBookings }` | `400 VALIDATION_FAILED` with `fields.reason`, `404`, `409 BOOKING_ALREADY_DECIDED`, `409 EVENT_NOT_ACTIVE`, `409 BOOKING_ALREADY_STARTED` |

- **Date filter:** `from`/`to` select bookings whose window overlaps `[from, to)`. The frontend sends the Singapore calendar day it shows.
- **Decisions (SPM-186, SPM-189, Master T32):** `decide_venue_booking` locks the event, the venue and the booking, re-checks every rule and commits the decision, `reviewed_by`/`reviewed_at`, the event's arrangement version (superseding an open safety review), an organiser-safe history entry and notifications to the coordinator and organiser together (migration `20261024100623_spm186_189_venue_booking_decisions`). Approval needs a `PENDING` booking, an event in `PLANNING`, an active `ACTIVE` venue, enough capacity, the venue's setup/turnaround minutes from MongoDB and no other approved booking over the occupied range. An approved booking that has not started may still be rejected when the venue can no longer host it; the event is never cancelled or rejected. Each booking's `actions: { canApprove, canReject }` says which buttons to show, and its `reviewedAt` and `reviewedByName` show who decided. Sending back `expectedStatus` makes a second decision from a stale screen fail with `409 BOOKING_ALREADY_DECIDED`.
- **`pendingCount`** and **`approvedCount`** are the numbers of `PENDING` and `APPROVED` bookings regardless of search and filters; the dashboard shows them at the top right (SPM-186) and says "No pending booking requests." when there are none.
- **What Venue Staff see of an event:** title, type, purpose, description, schedule, attendance, preferred layout, accessibility needs, organisation name and coordinator name. No participant data, organiser contact details, clarifications or history (Master section 4.2).
- **Search and sort (SPM-181 follow-up):** `q` matches a booking ID (`110` or `#110`), a request reference (`REQ-000442`), the booking label, the event title or the venue name, case-insensitively and literally. `sort=default` puts `PENDING` first (the `booking_status` enum order), then the soonest booking; the other sorts order by `start_datetime`, `expected_attendance`, `updated_at` or the event title, with missing values last. "Last opened" is per viewer and sorted by the browser.
- **Booking reference:** the booking's own `booking_id`; migration `20261021090000_spm181_booking_id_and_updated_at` dropped the generated `booking_reference` column and added `updated_at`, kept current by the `venue_booking_touch_updated_at` trigger.
- **Schema:** migration `20261020070631_spm181_venue_booking_details` added `label`, `expected_attendance`, `layout_type`, `required_facilities`, `accessibility_requirements` and `special_requirements`, backfilling attendance from the event and layout from the booked room, plus a nullable `event.event_type` (`CONFERENCE`, `WORKSHOP`, `SEMINAR`, `NETWORKING`, `SOCIAL`, `TRAINING`, `OTHER`). The organiser form does not collect the event type yet. `supabase/seed/spm181_venue_booking_details.sql` fills these fields for the existing mock bookings.

### Submission guarantees (SPM-36)

The agreed deployment has one Coordinator Lead. Submission saves against the
existing draft ID, enters `SUBMITTED` with no Coordinator, and notifies the owner
and that Lead. It succeeds even when no Coordinator is available. Assignment is
still the separate Lead action and enters `UNDER_REVIEW`.

Apply the reviewed migration
`supabase/migrations/20261019183324_spm36_submission_time_and_lead_receipt.sql`
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
- **Coordinator statuses:** the list follows the Master 1.0 lifecycle (section 5.2): `SUBMITTED` is excluded because an event in it has no coordinator, and there is no `APPROVED` state. `SAFETY_REVIEW` and `PREPARATION` are in the `event_status` enum from migration `20261019075257_spm244_status_and_role_values`. The list is one constant, `COORDINATOR_EDITABLE_STATUSES` in `config/eventConstants.js`, passed to the database function, so changing it needs no migration.

### Event Lifecycle (SPM-173)

Every status change goes through one transition table in the database (`_lifecycle_transitions`, Master section 5.2 actions numbered T01–T17 in migration `20261019075510_spm173_lifecycle_transitions`). An action function locks the event, calls `_check_event_transition` (role, relationship, `version`, current state), checks its own preconditions, then calls `_apply_event_transition`, which writes the state and one history entry (`changes.status.before/after`). Simple actions can call `_transition_event`. The helpers are callable only from other database functions.

Coordinator routes (assigned coordinator only; anyone else gets `404`, other roles `403`). Each `POST` takes `{ "version": <the event version you loaded> }` and an optional `Idempotency-Key`, and returns `200 { message, event }` with the coordinator view:

| Route | Action | Refusals |
| --- | --- | --- |
| `GET /api/events/:id/readiness` | Readiness (AC8): `{ ready, failures: [{ code, message }], status, version, arrangementVersion }` | `404` |
| `POST /api/events/:id/submit-for-safety-review` | `PLANNING` → `SAFETY_REVIEW`; opens a review round for the current `arrangement_version`; notifies every active Safety Officer | `409 READINESS_BLOCKED` with `failures` |
| `POST /api/events/:id/confirm` | `SAFETY_REVIEW` → `CONFIRMED` when the latest round is `APPROVED` for the current arrangement version and the event is still ready; stores a confirmation snapshot; notifies the owner and the staff who approved its bookings and equipment; tells registered attendees only when a reconfirmation changed the snapshot | `409 SAFETY_APPROVAL_REQUIRED`, `409 READINESS_BLOCKED` |
| `POST /api/events/:id/start-preparation` | `CONFIRMED` → `PREPARATION`; notifies the staff on the event | — |
| `POST /api/events/:id/complete` | `CONFIRMED`/`PREPARATION` → `COMPLETED` after the event's end (database time) | `409 EVENT_NOT_ENDED` |

All four also answer `403 TRANSITION_NOT_ALLOWED` with `currentStatus` when the action is not allowed in the current state, and `409 EVENT_VERSION_CONFLICT` with the current `event` for a stale `version` (for example, the second of two simultaneous actions).

- **Readiness** (Master 5.3) is checked by `_event_readiness` on today's tables (`20261020112025`, `20261020142915`, `20261021100000`): active bookings are `PENDING`/`APPROVED` `venue_booking` rows, capacity is the venue's `max_capacity`, overlapping active bookings at the same venue report `BOOKING_CONFLICT`, the primary venue is the event's only active booking (several active bookings report `NO_PRIMARY_VENUE` until bookings have a primary flag), every equipment requirement needs an approved `equipment_request`, and a `PENDING` change request blocks. An open resource incident reports `OPEN_BLOCKING_INCIDENT` once `resource_incidents` exists; until then readiness fails closed with `READINESS_DATA_PENDING`. The Master resource draft in `supabase/drafts/` (kept out of `supabase/migrations/` until SPM-179/SPM-181/SPM-186 agree) replaces these functions with the full check; readiness integration tests requiring those tables remain pending.
- **Completion job:** `jobs/eventCompletionJob.js` starts with the server and calls `complete_due_events` every `EVENT_COMPLETION_INTERVAL_MS` (default one minute, `0` turns it off). It completes ended `CONFIRMED` and `PREPARATION` events in batches of 50, using database time and `SKIP LOCKED`, and records them as `System` in the history (`activity_log.user_id` is null, `actor_role` is `SYSTEM`). Registration closes with the state, because it is open only in `CONFIRMED` and `PREPARATION`.
- **Assignment uses the shared function:** migration `20261022100000_spm173_assignment_shared_transition.sql` routes Lead assignment through `_check_event_transition` and `_apply_event_transition`, retaining the assignment conflict guard, assignment row and notifications. Other lifecycle writers must use the shared helpers before a database trigger can safely refuse direct status writes.

### Clarification Threads (SPM-41)

Built on the SPM-173 transition table (migrations `20261024025349_spm41_clarification_lifecycle.sql` and `20261024120000_spm41_clarification_threads.sql`). A clarification round ("Request *n*") is a thread of messages between the owner and the assigned coordinator, which can't be edited. While the thread is open, the event stays `AWAITING_CLARIFICATION` and the owner may save amendments. Only the coordinator completes the thread, which returns the event to `UNDER_REVIEW` with the same coordinator. There is no separate resubmit step, and `POST /:id/resubmit` no longer exists. Each write runs in one transaction under the event lock, and any failure rolls all of it back. Every `POST` except `/read` and `/history/viewed` needs an `Idempotency-Key`.

| Route | Who | Body | Result and refusals |
| --- | --- | --- | --- |
| `GET /api/events/:id/clarifications` | Owner, same-organisation organisers, assigned coordinator | — | `{ clarifications }`, newest thread first, each with `status` `OPEN` or `COMPLETED`, `completedAt`/`completedBy`, `messages` (oldest first, with author name and role) and `unreadCount`: messages from the other party since this reader last opened the thread, or `null` for readers whose reads are not tracked |
| `POST /api/events/:id/clarifications` | Assigned coordinator (another coordinator `404`) | `{ message, version }`, message required, at most 2,000 characters | `UNDER_REVIEW` → `AWAITING_CLARIFICATION`; new `OPEN` thread whose first message is the question; owner notified with the question; history keeps the full question. `200 { message, event, clarification }` |
| `POST /api/events/:id/clarifications/:round/messages` | Owner or assigned coordinator (same-organisation organisers `403 EVENT_READ_ONLY`) | `{ body }`, required, at most 2,000 characters | `201 { message, clarification }` with the new message. `404 CLARIFICATION_NOT_FOUND`, `409 CLARIFICATION_CLOSED` |
| `POST /api/events/:id/amendments` | Owner (same-organisation organisers `403 EVENT_READ_ONLY`) | `{ changes, version }`, at least one changed field | Event stays `AWAITING_CLARIFICATION`; version increases; recorded as `CLARIFICATION_AMENDED`. `400` with `fields.changes` when nothing changes; `403 FIELD_NOT_EDITABLE` for registration settings, organisation or system fields; `409 CLARIFICATION_NOT_OPEN`; `409 COORDINATOR_CONFLICT` when amended dates clash with the coordinator's schedule. `200 { message, event }` |
| `POST /api/events/:id/clarifications/:round/complete` | Assigned coordinator (another coordinator `404`) | `{ version }` | Thread `COMPLETED`; `AWAITING_CLARIFICATION` → `UNDER_REVIEW`; recorded as `CLARIFICATION_COMPLETED`; owner notified. A version from before the latest amendments is `409`. `200 { message, event, clarification }` |
| `POST /api/events/:id/clarifications/:round/read` | Clarification viewers; reads tracked only for owner/assigned coordinator | `{ lastMessageId }` (0 for an empty thread) | `200 { read }`; false if a newer message arrived, the viewer has no tracked reads, or a legacy client sends no cursor |
| `POST /api/events/:id/history/viewed` | Anyone who can see the event | — | `200 { lastViewedAt }`. `GET /:id/history` also returns this viewer's `lastViewedAt` (or `null`), so the history can mark what is new to them |

Actions that take a `version` also answer `403 TRANSITION_NOT_ALLOWED` with `currentStatus` and `409 EVENT_VERSION_CONFLICT` with the current `event`. Outside the viewing scope, every route answers `404` (`requireVisibleEvent`).

- **Amendable fields:** every submission field except registration settings and the organisation (`AMENDMENT_FIELDS`). They skip the change workflow (Master 5.2). The amended request must still be complete; the 48-hour lead time applies only when `startDatetime` is amended.
- **Notification throttle:** a new message or amendment notifies the other party only if they haven't already been notified since they last opened the thread (`clarification_reads`). Writing in a thread counts as opening it.
- **Displayed messages:** opening a thread refreshes its messages before acknowledging it. Migration `20261025120000_spm41_displayed_message_reads.sql` adds `last_read_message_id`; the read function locks the event and thread, and acknowledges only when the supplied ID is still the latest. Newer replies remain unread. Throttle timestamps use actual database time rather than transaction-start time. Safety Officer event visibility does not grant clarification access.
- **Equipment choices:** organiser-only `GET /api/events/request-options` includes `equipment: [{ equipmentId, name }]`, alongside venues/layouts. The amendment form can add/remove items and change quantities; these requirements do not reserve stock.
- **Review-fix deployment:** apply `20261025120000` before the backend, then deploy the frontend. The old three-argument read function remains as a safe no-op, so old clients cannot clear undisplayed replies during rollout. Application rollback may retain the additive cursor column; do not drop message/read data. Restoring the former read helper would restore the stale-read defect. See `docs/test-plans/spm-41-review-fixes.md` for local checks and hosted verification limits.
- **Permission flags:** event responses carry `permissions.canRequestClarification` (assigned coordinator, `UNDER_REVIEW`), `canPostClarificationMessage` (owner or assigned coordinator, `AWAITING_CLARIFICATION`), `canSaveAmendments` (owner, `AWAITING_CLARIFICATION`) and `canCompleteClarification` (assigned coordinator, `AWAITING_CLARIFICATION`). The frontend shows each action only when it is granted.
- **Rounds from before threads:** the migration copied each round's question, and its answer if there was one, into `clarification_messages`. Rounds closed by the v1 resubmit name the organiser as `completedBy`. Events returned before rounds existed were given one `OPEN` round whose message says the original question was not recorded (seed event 441).
- **Notifications** use SPM-173's `_notify_event_users`; `TODO(SPM-155)` marks the switch to the keyed helper.

### Safety Reviews (SPM-243)

A coordinator's submission for safety review (above) opens a round in `safety_reviews` for the event's current `arrangement_version`. Open rounds form one shared queue; a Safety Officer claims a round, works through a six-factor checklist and decides it (Master 5.9). Every change runs in a database function that locks the round, and the event when the event changes. A decided or superseded round, and a recorded booking rejection, never change afterwards: a trigger refuses it, and the backend's service role has no direct `UPDATE` on either table (`20261022123827`).

Safety Officer routes (`403` for every other role). A Safety Officer sees an event (`GET /api/events/:id`, `/history`) only while it has an open unclaimed round, a round they hold or a round they decided; they see `registeredCount`, never participants, and `safetyReviewId`, the round to open (the open one in their scope, otherwise the latest they decided), history narrowed to attendance, timing, venue, layout, access, equipment and safety entries, and get `403 FORBIDDEN` on any edit or lifecycle action.

| Route | Does | Refusals |
| --- | --- | --- |
| `GET /api/safety-reviews/queue` | Open, unclaimed rounds of events in `SAFETY_REVIEW`, oldest submission first: `{ reviews: [{ reviewId, eventId, requestId, title, startDatetime, endDatetime, expectedAttendance, venues, roundNumber, submittedAt }] }` | — |
| `GET /api/safety-reviews/mine` | Open rounds the caller holds, same shape | — |
| `POST /api/safety-reviews/:reviewId/claim` | Claims the round while its event is in `SAFETY_REVIEW`; first come, first served | `409 ROUND_NOT_CLAIMABLE`, `404 REVIEW_NOT_FOUND` |
| `POST /api/safety-reviews/:reviewId/hand-back` | `{ note? }` (≤500): returns the round to the queue and clears saved progress; staff-only history entry | `403 NOT_CLAIMANT`, `409 ROUND_NOT_OPEN` |
| `PUT /api/safety-reviews/:reviewId/progress` | Any of `{ checklist, organiserComment, internalNotes, requestedChanges }`; the checklist may be partial | `400 VALIDATION_FAILED` naming `checklist.<factor>`, `403 NOT_CLAIMANT`, `409 ROUND_NOT_OPEN` |
| `GET /api/safety-reviews/:reviewId/panel` | The event, active bookings, requested equipment (`placement` = technical notes), relevant history, every round, and each venue's `emergencyAccess` and `knownRestrictions` from MongoDB `venue_details` with `venueDetailsAvailable` | `404` outside the caller's scope |
| `POST /api/safety-reviews/:reviewId/decision` | `Idempotency-Key` required. `{ outcome: APPROVED \| CHANGES_REQUESTED \| REJECTED, checklist (all six), arrangementVersion, organiserComment?, internalNotes?, requestedChanges? (≥1, changes only), rejectedBookings? [{ bookingId, reason }] (≥1 for reject) }`. Approval keeps `SAFETY_REVIEW`; the other two return the event to `PLANNING` (never `REJECTED`, nothing released). Notifies the coordinator, the Venue Staff of the affected bookings and the Technical Support on the event. A replay answers with `Idempotent-Replayed: true`. MongoDB is read only when the claimant decides an open round, so a non-claimant or a replay is answered even while it is down | `400`, `403 NOT_CLAIMANT`, `409 SAFETY_FACTOR_NOT_SATISFACTORY` with `factors`, `409 ARRANGEMENTS_CHANGED` (the round's arrangement version is out of date, so it was superseded instead and the event is in `PLANNING`; or the sent `arrangementVersion` is stale, and nothing changed), `409 ROUND_NOT_OPEN`, `503 VENUE_DETAILS_UNAVAILABLE` |

Checklist factors: `attendanceCapacity`, `layout`, `emergencyAccess`, `accessibility`, `equipmentPlacement`, `venueRestrictions`, each `{ result: SATISFACTORY | NOT_SATISFACTORY | NOT_APPLICABLE, comment }`; a comment is required unless the result is `SATISFACTORY`.

`GET /api/events/:id/safety-reviews` (SPM-251) returns every round in order, shaped for the caller: the coordinator and Safety Officers see everything; the organiser sees `{ roundNumber, status, decidedAt, organiserComment }`; the Lead who supervises the event (made its current assignment, Master 4.2) and Technical Support who reviewed one of its equipment requests see the outcome; Venue Staff who reviewed one of its bookings also see their own rejected bookings. Anyone else gets `404`.

**Arrangement changes (SPM-250).** A change to an event's venue bookings, booking decisions, blocking incidents, technical arrangements or expected attendance invalidates its safety review (Master 5.2, 5.9). Inside the database function that makes the change, call:

```sql
PERFORM public._supersede_safety_review(p_event_id, p_actor_id, 'Venue blocked for maintenance.');
```

It raises `event.arrangement_version` and, when the event is in `SAFETY_REVIEW`, closes an open round as `SUPERSEDED` (an approved round stops counting), returns the event to `PLANNING` and notifies the claimant and the coordinator. Backend code outside a database function uses `safetyModel.recordArrangementChange({ eventId, actorId, reason })`. A decision on a round whose version is out of date supersedes it itself and answers `409 ARRANGEMENTS_CHANGED`.

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

### Attendee Profile (SPM-270)

An attendee keeps reusable details for event registration. Name, email and phone come from the `user` record; dietary restrictions and accessibility requirements are stored in `attendee_profile`. Each route works only on the signed-in attendee's own profile, so there is no profile ID in the path. Every other role gets `403 FORBIDDEN`, and the database re-checks the role inside each read and save.

| Method & path | Input | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/attendee-profile/mine` | — | `200 { profile: { attendeeId, userId, name, email, phone, dietaryRestrictions, accessibilityRequirements, version, createdAt, updatedAt } }`. Before the first save, `attendeeId`, `version` and the timestamps are `null` | `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `500 INTERNAL_ERROR` |
| `PUT /api/attendee-profile/mine` | `{ "dietaryRestrictions", "accessibilityRequirements", "version" }`: both text fields required, each text of up to 1,000 characters or `null`; `version` is the one loaded, or `null` for the first save | `201 { profile }` on the first save, `200 { profile }` afterwards | `400 VALIDATION_FAILED` with `fields` (any other field, including `attendeeId`, `userId`, `role`, `name`, `email`, `phone` or timestamps), `401`, `403`, `409 STALE_PROFILE` (a profile already exists, or it changed since it was loaded: reload and save again), `500 INTERNAL_ERROR` |

- **Blank values:** text is trimmed, and an empty value is saved as `null`. Text containing a NUL character (`\u0000`), which PostgreSQL cannot store, is refused with `400`.
- **One profile per attendee:** `UNIQUE (user_id)` plus a single conditional insert, so simultaneous first saves create one profile and the other request gets `409`.
- **Event Registration** reads the same combined details with `findAttendeeProfile(userId)` in `model/attendeeProfileModel.js` (database function `get_attendee_profile`).
- **Schema:** migration `20261024095646_spm270_attendee_profile`. The development database already had the table without a migration; the migration aligns it in place. `20261025035109_spm270_attendee_profile_role_guard` then checks the rows that were already there: it stops with an error listing every profile owned by a non-`ATTENDEE` user and changes nothing, so those rows must be resolved before it is rerun.
- **Database tests:** `tests/database/spm270AttendeeProfile.test.cjs` runs both migrations on in-memory PostgreSQL (PGlite), on a fresh schema and over the dashboard-created table.

---

## 🧪 Example `.env` File

Create a `.env` file in the root directory:

```bash
PORT=8000
SUPABASE_URL=https://rvwiflsedoujspmzfrbq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only-key>
MONGODB_URI=mongodb+srv://<atlas-user>:<url-encoded-password>@spm.ldi4ulx.mongodb.net/?appName=SPM  # your own Atlas user; server-only
MONGODB_DB_NAME=connectsphere_dev           # shared development database (Master M3)
# Optional
FRONTEND_ORIGIN=http://localhost:3000   # the only browser origin allowed by CORS (default shown)
SUPABASE_ANON_KEY=<anon/publishable key>  # tests sign in with it like the browser; falls back to the service role key
SEED_ACCOUNT_PASSWORD=<private password for seeded dev accounts, 12+ characters>
SEED_NAMESPACE=dev                         # prefix for seeded emails and organisation names
SIGNUP_RATE_LIMIT_MAX=5                    # sign-up attempts per IP per 15 minutes (default 5; tests raise it)
EVENT_COMPLETION_INTERVAL_MS=60000         # how often ended events are completed (default 60000; 0 turns the job off)
```

The code does not read `SUPABASE_PUBLIC_KEY`; name the anon/publishable key `SUPABASE_ANON_KEY`.

`MONGODB_URI` and `MONGODB_DB_NAME` are required: without them the health check fails, the venue catalogue reports its details as `NOT_CHECKED`, and Safety Officers cannot decide a review (`503 VENUE_DETAILS_UNAVAILABLE`, because emergency access and known restrictions come from `venue_details`). Your Atlas user needs read/write access and your current IP on the Atlas Network Access list (Master section 2.7.1).

---

## 👤 Development Accounts

Nobody can log in until an Auth account is linked to an active profile (`user.auth_user_id`). To create one synthetic account per role, plus two organisations (organisers A and B belong to different ones):

```bash
npm run seed:accounts           # idempotent; re-running resets passwords to SEED_ACCOUNT_PASSWORD
npm run seed:accounts:cleanup   # removes exactly what supabase/seed/manifests/ lists
```

Accounts are `<SEED_NAMESPACE>-<organiser-a|organiser-b|coordinator-lead|coordinator|venue-staff|tech-support|safety-officer|attendee>@connectsphere.test`. The `.test` domain is undeliverable, so no email is ever sent.

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

Tests that need MongoDB (`tests/unit/venueDetailModel.test.js`, `tests/integration/venue.integration.test.js`) start a local in-memory server with `mongodb-memory-server`, never Atlas (Master M7). The first run downloads a `mongod` binary into the user cache; later runs work offline. `tests/integration/venue.integration.test.js` covers SPM-72 TC-VC-001 and TC-VC-003 against the live database and needs migration `20261019025616_spm72_venue_active_state`. TC-VC-002 (no available venues) cannot run against the shared database, which always holds other venues; the unit suites and the frontend journey cover it.

`tests/integration/events.integration.test.js` exercises the event request RPCs end to end, including parallel submissions and idempotent replays. It needs migration `20261007075542_event_request_review_fixes` applied to the development project.

`tests/integration/eventEdits.integration.test.js` covers SPM-33 (TC-01 to TC-21, two parallel saves, and an edit racing a reassignment). It needs the four SPM-33 migrations (`spm33_event_edit_history`, `spm33_owner_history_and_edit_notice`, `spm33_request_organisation_and_history_retention`, `spm33_assignment_enters_under_review`) and the `reassign_event_coordinator` function (SPM-180) in the development project. Cleanup deletes everything a run created except the profiles that wrote history entries: those stay, deactivated and without an Auth account, because history is never deleted.

`tests/integration/lifecycle.integration.test.js` covers SPM-173 (the transition table for every action and state, direct status edits, roles, versions, idempotency, Lead notifications, label filter and the completion job). It needs migrations `20261019075257` to `20261019075510`. State-machine cases run inside rolled-back transactions on the privileged connection. `tests/integration/lifecycleReadiness.integration.test.js` covers readiness, submit for safety review and confirmation, and also needs the Master resource tables from the drafts in `supabase/drafts/` (`20261019100300` and `20261019100400`), once agreed and applied.

---

## 🗄️ Database Migrations

Schema changes live in `supabase/migrations/<version>_<name>.sql`. The version matches the one recorded in the remote migration history. Add the SQL file first, review it, then apply it to the development project. Never edit an applied migration; add a corrective one.

MongoDB collections, validators and indexes are defined in `mongodb/schemas/` and created by numbered scripts in `mongodb/migrations/` (Master section 6.4, M8). Apply them to the database in `MONGODB_DB_NAME` with:

```bash
npm run mongo:migrate   # runs each script once and records it in _schema_migrations
```

Never create or change collections by hand or in the Atlas UI.

---

## ✅ Commit Message Format

This project follows a structured commit message format for consistency.

Please refer to the `COMMIT_MESSAGES.md` file in the root directory for details.

---

## 📁 connectsphere-events-g8t6-backend File Structure

```bash
connectsphere-events-g8t6-backend/
├── app.js                 # Express app and middleware composition
├── config/               # External service configurations (Supabase, MongoDB) and shared constants
│   ├── eventConstants.js # Event statuses and the SPM-33 field edit matrix
│   ├── mongodb.js        # Shared MongoDB client; retries after a failed connection
│   ├── roles.js
│   ├── supabase.js
│   └── venueConstants.js # Venue statuses and the maximum capacity
├── controller/           # Route handler logic and controllers
│   ├── attendeeProfileController.js
│   ├── authController.js
│   ├── eventController.js
│   ├── registrationController.js
│   ├── safetyController.js # Safety Officer reviews and safety outcomes (SPM-243)
│   └── venueController.js
├── jobs/                 # Background work started by server.js
│   └── eventCompletionJob.js  # Completes ended events (SPM-173)
├── middleware/           # Request/response middleware functions
│   ├── auth.js           # Verifies the Supabase access token and loads the profile
│   ├── authorize.js      # Role checks, the event access policy and requireVisibleEvent (404 outside viewing scope)
│   ├── errorHandler.js   # Safe responses for unhandled errors
│   ├── rateLimit.js      # Per-IP limit for sign-up attempts
│   └── validate.js       # Offset and cursor pagination bounds, event ID parsing
├── model/                # Data models and logic
│   ├── activityModel.js  # Audience-filtered change history
│   ├── attendeeProfileModel.js # SPM-270 attendee's own profile
│   ├── eventModel.js
│   ├── healthModel.js
│   ├── registrationModel.js
│   ├── safetyModel.js    # Safety review rounds (SPM-243)
│   ├── userModel.js
│   ├── venueCalendarModel.js # MongoDB venue_calendar (holds, blocks)
│   ├── venueConflictModel.js # Occupied ranges, conflicts, availability calendar
│   ├── venueDetailModel.js # MongoDB venue_details reads and writes
│   ├── venuePhotoModel.js  # MongoDB venue_photos (gallery, covers)
│   └── venueModel.js       # Catalogue, maintenance, availability, booking review
├── mongodb/
│   ├── migrate.js        # Applies numbered scripts once (npm run mongo:migrate)
│   ├── migrations/       # Numbered collection/validator scripts
│   ├── schemas/          # JSON Schema validators
│   └── seed/             # Development data (npm run seed:venue-calendar)
├── routes/               # API route definitions
│   ├── attendeeProfileRoutes.js
│   ├── authRoutes.js
│   ├── eventRoutes.js
│   ├── registrationRoutes.js
│   ├── routers.js
│   ├── safetyRoutes.js
│   └── venueRoutes.js
├── supabase/
│   ├── migrations/       # Versioned schema changes
│   └── seed/             # Development account provisioning
├── tests/
│   ├── database/         # In-memory PostgreSQL (PGlite) tests of database functions
│   ├── fixtures/         # Synthetic data setup and cleanup
│   ├── integration/      # Live tests against the development project
│   └── unit/             # Mocked Supabase; run by npm test
├── validators/           # Pure request validation rules
│   ├── attendeeProfileValidator.js # SPM-270 profile save fields
│   ├── authValidator.js
│   ├── eventValidator.js
│   ├── safetyValidator.js
│   ├── venueAvailabilityValidator.js # SPM-74 calendar query
│   ├── venueBookingValidator.js # SPM-181 booking filters
│   ├── venuePhotoValidator.js # T28 image type, size, caption and position
│   └── venueValidator.js # SPM-73 venue fields, details, status, catalogue and list filters
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

The Lead queue and assignment/reassignment integration, staged overlap guard,
deployment order and isolated/hosted test commands are documented in
[the SPM-174 integration plan](docs/test-plans/spm-174.md).

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

To give the seed Safety Officer events to review (SPM-243), create three events at the core seed
venues. Each is submitted through the real database functions: two wait under "Awaiting review",
and one is in the officer's "My reviews" at round 2, after round 1 requested changes. They occupy
the seed coordinator and the Grand Hall, East Wing Auditorium and Rooftop Terrace on 10, 12 and 14
November 2028 (Singapore time), so other fixtures that give `dev-coordinator` an event should avoid
those days (SPM-174 refuses overlapping events for one coordinator). Re-running
replaces the set; cleanup needs `TEST_DATABASE_URL`, because rounds and their history can only be
removed through the privileged test connection.

```bash
npm run seed:safety-reviews
npm run seed:safety-reviews:cleanup
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

SPM-177 Lead-only assignment correction and isolated regression checks are documented
in [the SPM-177 test plan](docs/test-plans/spm-177.md). The corrective migration
retires the obsolete two-argument assignment function and preserves atomic
assignment, history, activity and notifications. Shared deployment requires
review of target migration history; no hosted migration was applied here.

## Organiser event arrangements (SPM-199)

`GET /api/events/:id/arrangements` requires a bearer token and the existing
event visibility check. The owner can read it; permitted organisation members
can read submitted events. Unrelated users and staff receive the same
`404 EVENT_NOT_FOUND` as a missing event; unauthenticated requests receive 401.
The response is private and carries `Cache-Control: no-store`.

The `{ arrangements: { venues, technical, safety } }` response contains
independent sections with `status: READY | UNAVAILABLE`. A failed read never
becomes a successful empty array. Venue data includes individually identified
bookings, primary designation, holds with expiry and safe availability/next
action messages. Technical data separates named equipment requirements from
request decisions and technical support requirements. Safety rounds contain
only the outcome, organiser comment, timestamps and whether they apply to the
current arrangement version. Internal notes, checklists, staff IDs and raw
database errors are excluded. This endpoint performs no writes. A final
read checks the event's arrangement version, event version and lifecycle state;
a concurrent change returns `409 ARRANGEMENTS_CHANGED` with no section data.
Refresh loads a newly authorised request. This optimistic check relies on
arrangement writers advancing the version as required by SPM-250; it does not
create a cross-store transaction. Hold expiry is evaluated after all I/O.
PostgreSQL venue status (`INACTIVE`, `UNDER_MAINTENANCE`, or `is_active = false`)
flags affected active bookings and holds even without a calendar block or
incident record, using a safe pending-coordinator message. Booking decisions
are retained. Inactive bookings/holds and completed occupied periods carry no
current unavailability warning; recorded resolved booking incidents can still
describe their historical action. Occupied periods include turnaround time.

The reader supports the existing room-based bookings and `equipment_request`
tables. It also reads the agreed `venue_id`/`is_primary`, `technical_requests`
and `resource_incidents` structures when deployed, without applying the
resource draft migration. On the current baseline, the sole active booking
is primary (the existing SPM-173 rule); multiple legacy bookings have no
designated primary. Missing combined technical support or incident storage is
reported as unavailable rather than inferred. Free-form legacy technical
notes and draft support notes have no external visibility marker and are
never returned. MongoDB holds are scoped to the event and overdue active
holds are returned as expired, even before the expiry job runs.

Verification and dependency boundaries: [SPM-199 test plan](docs/test-plans/spm-199.md).
