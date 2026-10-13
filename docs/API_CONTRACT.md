# Gym Progress Duo — frontend/backend boundary v1

The frontend is implemented in this project. No production backend or real authentication is included. Claude owns the implementation behind this contract. The shared TypeScript schema is `shared/contracts.ts`; preserve it or coordinate changes before integration. This project has no Base44 dependency and must not connect to the old Base44 app.

## Modes and transport

`PreviewGateway` uses fictional `preview-you` and `preview-partner` accounts and local browser storage under `gym-progress-duo.preview.v1`. It is an explicitly selected UI preview, not authentication or an access-control boundary. It never uploads files. Preview data is not safe for real personal health information. Preview proposals stay pending, improvement bonuses are zero, and late edits are disabled. Deletions still recalculate consistency totals.

`HttpGateway` uses same-origin `/api/v1`, `credentials: include`, `mode: same-origin`, and `cache: no-store`. There is no token storage and no automatic fallback to fictional data on backend errors. Serve the frontend and API through the same trusted origin. Authentication must use secure, HttpOnly cookies, with appropriate SameSite policy, origin validation and server-side CSRF validation. Rotate sessions on sign-in, and expire them on logout/removal. Never ship a service credential to the browser.

All authenticated responses must use `Cache-Control: private, no-store`. No service worker or shared caching should store personal API responses or image bytes.

## Endpoints consumed by the frontend

| Method/path                   | Request                                                       | Successful response                                                             |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/v1/bootstrap`       | Session cookie                                                | `Bootstrap` JSON; `X-CSRF-Token` response header                                |
| `GET /api/v1/auth/sign-in`    | Browser navigation                                            | Backend-owned invited-account sign-in flow, redirects to frontend after success |
| `POST /api/v1/commands`       | `CommandEnvelope` JSON, CSRF, idempotency and version headers | Fresh authorized `Bootstrap` JSON                                               |
| `GET /api/v1/export`          | Session cookie                                                | Own-record JSON export; no partner private data or private file URLs            |
| `POST /api/v1/media`          | Multipart field `file`, CSRF and idempotency headers          | `{ "mediaId": "opaque-id" }`; never a public URL                                |
| `POST /api/v1/session/logout` | CSRF header                                                   | `204`; server expires session cookie                                            |

The server must return API JSON, including errors, rather than redirecting these endpoints to an HTML login page. HTTP 401 opens the unauthenticated frontend state; 403 means the signed-in account is not one of the two authorized members. Login/verification UI and routes are backend integration work. They must not provision arbitrary accounts into the competition.

`GET /api/v1/session` may provide session status and `X-CSRF-Token` for a future authentication UI, but the current gateway obtains its token from `/bootstrap`. `HttpGateway` refuses mutations if it cannot obtain a token. Backend success responses may rotate the token using the same response header.

Every mutation uses `X-CSRF-Token`. The command body is:

```json
{
  "requestId": "client-generated-unique-id",
  "command": {
    "type": "log.update",
    "id": "record-id",
    "expectedVersion": 3,
    "log": {
      "kind": "hydration",
      "occurredAt": "2026-10-08T15:00:00.000Z",
      "title": "Daily water",
      "notes": "",
      "water": 2000,
      "waterUnit": "ml"
    }
  }
}
```

`Idempotency-Key` must equal `requestId`. For `log.update`, `log.delete`, `body.share`, and `nutrition.goals.set`, `If-Match` is the quoted decimal `expectedVersion`, for example `"3"`. Validate both values agree; use an atomic conditional write. Return 409 or 412 on version conflicts. A retry uses the same request ID and unchanged command, even after an uncertain network result. Reusing an ID with different content returns 409 `IDEMPOTENCY_CONFLICT`.

Bind idempotency to authenticated membership plus operation, and store a canonical request digest in a database transaction with the mutation. Concurrent duplicate requests must apply once. Replay may return the latest permitted bootstrap instead of retaining a historical response containing deleted/private values. Never persist raw private record values just to support request replay. A new deliberate edit gets a new ID. Browser preview only demonstrates request replay in a single browser context; it does not provide database isolation across tabs or devices.

The upload gateway retains the same idempotency key for retries of the same selected File object. Reselecting a file or reloading creates a new selection, so the backend must also content-hash original bytes and deduplicate the same user's identical upload. Purge unattached uploads after a short documented retention period. The attached record, not possession of `mediaId`, grants access.

## Commands

The complete discriminated union is in `shared/contracts.ts`:

- `log.create`: allowed `LogInput` fields only. Server derives owner, ID, version, creation/original-activity timestamps and eligibility.
- `log.update`: own record plus `expectedVersion`. Preserve immutable original activity and trusted creation timestamps. Apply deadline rules and recalculate dependent weeks.
- `log.delete`: own record plus version. Delete private media bytes, purge grants/cache entries, retain only a minimal value-free audit and recalculate dependents.
- `body.share`: own body record plus version and explicit boolean. Revoke access immediately for future requests; already downloaded copies cannot be recalled.
- `template.save`: name and sets only. A template is not a log, and copying it must create an unsaved/incomplete draft until explicitly completed.
- `targets.propose`: validated own target values only. Server records proposing user and their approval. Effective week is the next Monday in the competition zone, determined on the server.
- `proposal.approve`: proposal ID only. Server records the authenticated approver; never accept approval user IDs from the browser. Enforce two distinct existing members, immutable proposal content and an unexpired future effective week. Approval and weekly snapshot creation require transactional conflict handling.
- `competition.agree`: no identity field. Server records agreement from the session. Both users must agree before competition becomes active.
- `profile.update`: display name and supported preferred units only. Targets do not change via profiles, and private body data never lives in shared profile fields.
- `nutrition.goals.set`: own optional daily tracking goals plus `expectedVersion`; no owner or effective date supplied by the client. This does not change competition rules or points. See the addendum below.

The initial frontend contract does **not yet expose** editing the shared start date/rules, choosing/changing benchmarks, account removal, or reading private images. Add these as coordinated typed endpoints/commands in a subsequent integration stage. Do not silently overload `profile.update` or set capability flags to imply these flows are complete.

Error schema:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "This record changed. Refresh before editing it.",
    "retryable": false
  }
}
```

Use 400/422 for validation, 401 for no session, 403 for nonmember access, 404 for inaccessible record IDs, 409/412 for version/idempotency conflicts, 413 for file size, 415 for unsupported files, and 429/5xx with a truthful retryable indicator. Do not return internal stack traces, private filenames, owner identifiers or signed URLs in errors.

## Server requirements before connecting real accounts

Exactly two invited identities may join. Enforce this with database-backed membership and a transaction/constraint when admitting members. A frontend email test, secret URL, or invitation UI alone is insufficient. Deny signed-out and third-account reads/writes at every API and media endpoint. Members may read permitted competition logs, but edit/delete only their own. Exclude partner private body records from bootstrap, exports, charts, audits, IDs and search results. API authorization must not trust IDs supplied by the browser.

`Bootstrap.weeks`, `allTime`, `eligibility`, `createdAt`, `originalOccurredAt`, `version`, approval identities and `capabilities.authoritativeScoring` are server-owned. Reject attempts to submit these values even if extra JSON properties are supplied. `allTime` is the sum of all weekly scores since the agreed start, independent of chart filters. Return full-precision numbers; round only for presentation. Weekly targets and rules are immutable versioned snapshots, not live profile values.

Persist an IANA competition zone, default `America/New_York`, and UTC instants. Reject future activity times. Entries before the start cannot earn competition credit. Entries more than 48 elapsed hours late are historical, never benchmark-eligible. The original activity timestamp cannot be reset by editing. Finalize each week after its closing Monday plus 48 elapsed hours. Late corrections/deletions can reduce but never create/increase awards, including when rebuilding benchmark history after removing a prior best. Store the award/eligibility evidence required to enforce that ceiling; recomputing only current records is insufficient. Serialize affected competition writes or use appropriate database transactions/locks. Test race conditions as well as ordinary requests.

Implement both improvement bonuses only on the server with exact benchmark exercise/equipment/repetition or cardio protocol matching and normalized comparable units. The first baseline week never earns a bonus. Rebuild qualifying history after corrections/deletions. A benchmark definition change needs both approvals and a new future baseline week; existing baselines cannot be lowered to manufacture improvement. No body measurements, appearance or absolute partner performance affect score.

## Nutrition tracking addendum — October 8, 2026

The user requested a manual calorie/macro tracker after the original frontend delivery. It is implemented locally; the production backend must add support before setting **`capabilities.nutritionTracking: true`**. Absent/false means the frontend displays an unavailable notice and does not offer nutrition entry or goal writes. No new dependency, AI call or food database is involved.

- `LogInput.nutrition?: NutritionValues` is supported for meals only. Allowed optional numeric keys: `calories` (kcal), `protein`, `carbs`, `fat`, `fiber`, `sugar` (all grams), and `sodium` (milligrams). These are manually entered totals for the portion eaten, not per-serving values the system multiplies. Calories are not inferred from grams or photos.
- Missing/blank is unknown; explicit numeric zero is known. Preserve this distinction. `{}` clears recorded nutrition on an edit. Reject null, arrays, nonnumeric/nonfinite/negative values and unknown properties. Input-sanity ceilings are in `shared/nutrition.ts`; they are not suggested dietary limits. Validate on the server, not just the browser.
- Nutrition follows the owning meal's read/write authorization. It is shared within the two-person competition by default; only the meal owner edits/deletes it. Include it in own export and deletion. Do not store body measurements in these shared fields.
- `Profile.nutritionGoalHistory?: { effectiveDate: YYYY-MM-DD; goals: NutritionGoals }[]` and `Profile.nutritionGoalsVersion?: number` are server-owned response fields. Goal keys are the five ring nutrients only: calories/protein/carbs/fat/fiber. A supplied goal must be positive; omission removes that goal. No default targets are prescribed. Sugar/sodium are descriptive totals without completion goals.
- `nutrition.goals.set` accepts `{ goals, expectedVersion }`. Resolve the authenticated profile; compare against its nutrition-goal version (initially zero), assign today's date in the competition timezone using trusted server time, and increment the version atomically. Replace a same-day snapshot or append a new one, preserving earlier days. An empty goals object removes goals from today onward. Never accept a client-provided identity, history, date or resulting version. Apply request idempotency and CSRF just like other writes.
- These goals are **personal tracking preferences**, not competition targets. They apply immediately from the current calendar day and do not require partner approval; strength/cardio/hydration scoring-target changes still require both approvals for the following week. No nutritional amount, calorie goal, over-goal amount or ring completion may add/remove competition points.
- Daily sums use the competition calendar day, one latest saved version per meal, and the selected member only. Count manually recorded nutrition from eligible, unscored and historical meals; a photo/checklist is not required for nutrition totals. Exclude drafts. Editing/deleting a meal must recalculate descriptive totals from the current authorized records.
- Bootstrap must contain all authorized meal records needed for the displayed day/history, or add a coordinated paginated/daily aggregate contract. Returning partial records as a complete daily sum is incorrect. The UI separately warns about missing nutrition fields; that is not protection against truncated backend result sets.

Local preview supports goal history and persistence, but does not add a second real login. The existing preview restriction on editing meal records after their original 48-hour deadline remains; deletion is supported. The production backend must distinguish nutrition-only corrections from eligibility changes so audited nutrition corrections never increase frozen competition awards. Existing previews without nutrition fields load without reset or invented values.

## Private media

Before enabling `capabilities.privateMedia`, implement a private bucket/object store and an authenticated byte-stream endpoint such as `GET /api/v1/media/:mediaId`. Reauthorize every request against the owning log and current share flag. Return no-store responses, no public URLs, and do not redirect to a long-lived bearer URL. The current UI intentionally does not render uploaded images until this endpoint and rendering flow are integrated.

Accept a single deliberately selected image only. No camera, photo-library scanning, location, microphone, sensor, push or third-party integrations. Validate decoded image format, MIME and size server-side; strip EXIF/location metadata and any unnecessary metadata. Client checks allow JPEG/PNG/WebP up to 10 MB. HEIC/HEIF is currently rejected with an explicit JPEG/PNG export fallback. Client MIME checks are not security validation. Deduplicate identical original meal-photo bytes for extra-award prevention, while acknowledging this remains honor-based. A global cross-user hash lookup must not reveal whether another user uploaded a file.

Delete object bytes when the owning record/account is deleted. File grants cannot outlive the record or sharing revocation. Define a backup-deletion retention policy and verify actual deletion. Do not retain deleted bytes in audit entries or idempotency caches. Account removal requires its own verified flow; `capabilities.accountDeletion` stays false until that exists. Decide whether remaining competition totals are recalculated or irreversibly anonymized and disclose this before removal. Do not claim total data erasure while keeping identifiable performance history.

## Required connected verification

Test invited login → own saved log → persisted server data → authoritative score → friend sees permitted projection. Test own private body record/photo absent for the friend, a third identity and signed-out requests; sharing/revocation must apply to file requests as well as JSON. Add concurrent duplicate create/update/approval tests, stale-version tests, deletion and late-correction regression cases, both distinct approvals, UTC/DST/week/48-hour boundaries and cross-unit benchmarks. Verify fixed two-member admission under concurrency. Actual iPhone Safari file selection, HEIC fallback, numeric keyboards, safe areas and home-screen shortcut behavior remain manual device checks.
