# Claude's backend assignment — Gym Progress Duo

We have changed direction. Do not use Base44 or modify the Base44 app. Build the backend for the local Gym Progress Duo frontend in this folder. The user is new to development; give concrete setup steps and never ask for secrets in chat.

## Work split

Codex owns `src/`, `shared/`, the frontend package/configuration, UI tests, and design. Claude owns a new `server/` directory, database migrations, backend/security tests, and backend setup documentation. Do not rewrite the frontend or shared contract. If a contract needs changing, propose the exact change in a separate note for Codex. Keep existing work. Do not deploy publicly or purchase services.

Start by reading `shared/contracts.ts`, `docs/API_CONTRACT.md`, `docs/SCORING_RULES.md`, `docs/PRODUCT_SPEC.md`, and `README.md`. These files preserve the product requirements with the new local-codebase workflow. The first backend deliverable is authenticated bootstrap -> own log -> persisted record -> authoritative score -> friend sees allowed records, with third-account and signed-out denial. No invented real accounts.

**October 8 frontend addition:** the user requested a manual nutrition tracker. Read the nutrition addendum in `docs/API_CONTRACT.md`: meal nutrient values, versioned/effective-dated personal goals, `nutrition.goals.set`, and `capabilities.nutritionTracking`. Keep that flag false until the server persists/authorizes the addition. Nutrition goals and rings are descriptive only, not competition points or scoring-target changes. Preserve missing-vs-zero values, own-only writes, shared permitted meal reads, export/deletion, and prior-day goal snapshots. The existing common-exercise picker remains frontend-only and needs no additional backend command.

## Required implementation

Implement the versioned API described in `docs/API_CONTRACT.md`. Prefer a small TypeScript backend so the shared scoring reference can be reviewed/reused on the server. Choose and document a database with actual transactions and unique constraints. Do not make an external account, subscribe to a service, or publish anything without the user's approval. A development database and migration scripts are fine. Production authentication must use a maintained auth solution; no homemade password cryptography.

Enforce exactly two invited verified identities in the backend. No public registration, frontend allowlist, client-supplied owner, approval identity, score, creation time, or eligibility fields. Keep body records separate and private by default. Use HTTP-only secure same-site session cookies, CSRF protection, input validation, ownership checks, and deny-by-default APIs. Export only the current user's logs. Protect all media retrieval; sharing revocation must affect future reads. Never use public file URLs. Delete media bytes on deletion/account removal, retaining only non-sensitive correction metadata. Store secrets exclusively server-side.

Preserve the original scoring specification: Monday weeks in America/New_York, UTC storage, versioned weekly targets, dual approvals effective next week, 48 elapsed hours anchored to original activity time, no future entries or point-earning entries before competition start, historical entries ineligible, reduction-only late corrections, immutable server creation times, deterministic recomputation, capped daily awards, comparable benchmark baselines and personal improvements, permanent all-time sum. The pure helpers under `shared/` are reference calculations, not a verified production scoring service. Complete and test the full rules on the server, especially benchmark history/corrections and dual approval races.

Transactions must atomically persist mutation, deduplicated request result, audit and score changes. Unique `(actor_id, request_id)` with a request-payload hash must reject reused keys with different bodies. Optimistic versions prevent lost updates. Concurrent approval requests must not create multiple rule versions. No find-then-create idempotency claims without database enforcement.

No tracking, sensors, HealthKit, camera capture, push permissions, third-party fitness integrations, AI grading, or paid AI calls. Only deliberately selected files. Support JPEG/PNG/WebP; add tested HEIC conversion or a clear fallback. Verify MIME bytes and limits. Strip metadata before storing image derivatives. No photo appearance/body changes earn points.

## Finish with evidence

Run backend tests for signed-out/third-person denial, owner-only mutation, cross-user body/media denial, per-record share/revoke, byte deletion, duplicate and concurrent requests, 48-hour boundaries, DST weeks, units, baseline/progression rules, reduction-only corrections/deletion and dual approval. Return test results, local startup instructions, `.env.example` without secrets, migrations, genuine limitations, and contract changes requested. Keep all deployment private and local until explicitly authorized.

If you cannot access this folder, ask the user to upload the `gym-progress-duo` source ZIP. Do not create a separate incompatible frontend.
