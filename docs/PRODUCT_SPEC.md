# Gym Progress Duo — V1 requirements after replanning

This supersedes the Base44-specific platform instructions. Build a normal, privately hosted responsive web app from this local codebase. Codex implements the frontend foundation; Claude implements the backend and connected security/scoring flows. Do not create a second frontend, connect to Base44, deploy publicly, or purchase services. The UI foundation is not the finished V1.

## Product and access

Two friends, both using iPhones, want consistent exercise and food habits, muscle, strength, endurance, and better overall health. V1 is an iPhone-friendly responsive web app, not an App Store app. Dark theme, readable charts, large controls, bottom navigation and quick logging; visual defaults easy to change.

Require real authentication and exactly two invited accounts, enforced server-side. A secret URL or frontend email check is insufficient. Each person edits only their own records. Either may propose rule/target changes; both must approve. Keep private body data separate from shared profile data. Never expose service credentials to the client.

Shared by default: points, workout details, food photos, cardio and hydration logs. Body weight, measurements and progress photos are private unless the owner explicitly shares each individual record. Allow revocation at any time. Enforce permissions on both API records and file-byte access. If private storage/deletion or integrity cannot be implemented, disclose the exact blocker and practical fix; do not use publicly accessible upload URLs.

## Manual input only

No Apple Health/HealthKit, watches, sensors, location, contacts, background tracking, microphone, camera capture, push permission, or third-party fitness account integrations. No AI meal grading, calorie inference, medical advice, or paid AI calls.

Users may deliberately select one existing image from the system file/photo picker. No library scanning or broad library permission. Explain that the chosen image is uploaded and stored. Provide tested HEIC support or a clear JPEG fallback.

## Onboarding and logs

- Separate profiles and a shared competition start date, defaulting to the next Monday. Both agree on the start date and rules before activation.
- Default competition timezone: America/New_York. Calendar weeks run Monday 00:00 to next Monday 00:00 in that timezone. Store instants in UTC.
- Personal strength and cardio targets: each 1–7 qualifying days/week. Personal daily hydration target and preferred units. Each person defines their own qualifying cardio session; no prescribed exercise plan.
- Version and snapshot settings each week. Both approve changes, effective the following week. No retroactive changes; unapproved proposals leave existing settings in force.
- Strength: exercise, exact equipment/variation, sets, repetitions, load, units, date/time and optional notes. Templates and previous-workout copying create editable drafts that earn nothing until explicitly completed and saved.
- Cardio: activity, duration, optional distance, date/time, notes. Optional manually entered steps; never required.
- Meals: one selected photo, description, timestamp, user-confirmed checklist. Default: protein source and fruit/vegetable/other fiber-rich food. Both may agree an alternative before starting. Label points self-reported; photos do not prove nutrition or calories.
- Hydration: manually entered daily total and unit. Points for meeting the agreed target, never for exceeding it.
- Optional body logs: weight, waist or other measurements and progress photos, dated, private by default, sharing per record. No body-change points.
- Edit/delete, saved-state feedback, loading/errors/empty states, retries without duplicates.

## Scoring

All-time total is the sum of weekly scores since the agreed start date and never resets. Views and filters do not affect this total. Both users have the same maximum of 100 points/full week:

1. Strength: `40 × min(qualifying completed workout days / personal strength target, 1)`.
2. Meals: `25 × min(qualifying meal days / 5, 1)`. At most one meal day/calendar day.
3. Cardio: `15 × min(qualifying cardio days / personal cardio target, 1)`.
4. Hydration: `10 × min(days meeting the personal target / 7, 1)`.
5. Improvement: one 5-point strength bonus plus one 5-point cardio bonus/week.

Calculate with full precision, round display to two decimals. No ranking by absolute loads, body weight lost, distance totals or photo appearance. No negative points, streak penalties, extreme-water incentives, or appearance rankings. Explain that points measure agreed habits and logged performance, not diagnosis or definitive overall health.

## Improvement benchmarks

Before starting, each person chooses up to three strength benchmarks and one cardio benchmark. Strength fixes an exercise, equipment/variation and repetition count; compare load at exactly that count. Cardio fixes an activity and protocol: time for a fixed distance or distance in a fixed duration.

Record each benchmark's initial baseline in the first competition week. Baseline sessions may earn normal consistency points but no bonus. Bonus eligibility begins week two and requires a strictly improved result over the best prior eligible comparable result: heavier load, shorter fixed-distance time, or longer fixed-duration distance. Convert comparable units accurately.

One improved strength benchmark suffices for the weekly strength bonus. Additional records do not increase either bonus beyond five. Normal workout sets may count only with exact exercise, equipment and rep match; never require one-rep-max testing.

Benchmark changes need both approvals, take effect next week, and require a new baseline week without bonus. Never lower an existing baseline to manufacture improvement. Corrections and deletions must rebuild qualifying history and dependent bonuses; no stale or removed bests.

## Integrity, deadlines and deletion

At most one strength day and one cardio day/calendar day. A combined session can earn both when distinctly logged. Meals and water cannot generate unlimited repeat points.

Point-earning submissions must arrive within 48 elapsed hours of the activity. Reject future activities and pre-start point earning. Older history may be retained without points or eligible progression. Retain original activity time and trusted server creation time. Editing a date cannot restart the deadline.

Edits within the original 48-hour window may alter eligibility. Afterward, corrections/deletions may only remove/reduce points, never introduce new awards or increase scores. This includes indirect effects from deleting a baseline or prior best. A week remains provisional through its closing Monday plus 48 elapsed hours; finalized weeks allow audited downward corrections.

Compute authoritative scores on the server from authorized records and versioned rules. Never accept client points, totals, approval identities, eligibility fields or trusted timestamps. Use deterministic recomputation plus transactional idempotency/unique source keys; test double taps, retries and races. If primitives cannot enforce integrity, disclose the blocker.

Maintain visible activity/correction history without deleted private photo bytes or deleted body values. Export only the user's own records. Delete their records/images and recalculate dependent scores. Account removal must delete private media and explicitly define recalculation or anonymization of surviving competition totals. Do not preserve identifying health data under the label "anonymous."

Block identical meal-photo reuse for extra awards where practical, using private content hashes. The competition remains honor-based; software and photos cannot prove what was eaten or exercised.

## Screens and verification

Today, Workouts/templates/history, Meals & water, personal Progress/body sharing, Competition/all-time/week history/shared feed/rules, and Settings/onboarding/approvals/units/export/deletion.

Use real persisted connected flows, no fictional accounts in production. Keep preview fixtures explicitly separate. Test scoring, 48-hour instants, UTC/DST/Monday boundaries, units, private records/files, duplicates/concurrency, edits/deletions and distinct dual approval. Verify invited login → own saved record → persisted data → correct server score → friend's permitted projection, plus private body denial. Test a third identity and signed-out denial at API and file level.

Test widths 375px and 390px; report automated Chromium coverage separately from actual iPhone Safari. Manual device checks: file selection, HEIC fallback, decimal keyboards, safe-area layout, Add to Home Screen. Keep dependencies/costs modest, document manual setup and current plan needs without invented prices. Deliver a private preview only when real privacy is configured, setup instructions, scoring examples, test evidence and genuine limitations.
