# Gym Progress Duo — scoring contract

These are agreed habit and logged-performance points, not a medical assessment or a ranking of overall health. They never reward body changes, appearance, extreme hydration, or one person's absolute performance against the other's. Logging is honor-based.

## What this foundation implements

`shared/scoring.ts` is a **non-authoritative local preview** of consistency scoring. It does not implement a secure leaderboard or a complete backend scoring engine. Production screens must use server-returned scores. The local preview never awards an improvement bonus: its current maximum is **90 points**, while the intended complete V1 maximum is **100**.

| Category    | Formula                                                                 | Full V1 maximum     |
| ----------- | ----------------------------------------------------------------------- | ------------------- |
| Strength    | `40 × min(distinct completed workout days / personal weekly target, 1)` | 40                  |
| Meals       | `25 × min(distinct qualifying meal days / 5, 1)`                        | 25                  |
| Cardio      | `15 × min(distinct qualifying cardio days / personal weekly target, 1)` | 15                  |
| Hydration   | `10 × min(days meeting personal target / 7, 1)`                         | 10                  |
| Improvement | One 5-point strength bonus and one 5-point cardio bonus                 | 10; pending backend |

Example: 2 of 3 strength days, 3 meal days, 1 of 2 cardio days, and 4 hydration days produce `26.666… + 15 + 7.5 + 5.714… = 54.88095…`, displayed as **54.88**. Full consistency is **90.00**. With both verified improvement bonuses it would be **100.00**. All-time total is the sum of every competition week; filters never reset it.

The same record ID is counted once. Its highest version replaces older copies; inconsistent copies of that same version are excluded. Multiple strength/cardio/meal records on the same local date cannot create extra consistency days. Strength and cardio can each count when represented by distinct activities. Completed strength requires a recorded exercise set. Cardio must meet that person's agreed activity and duration criteria, chosen by the participants rather than prescribed by the app. Meals require a selected photo reference and every agreed checklist item. Meal points remain self-reported; an image does not prove nutrition or calories.

Hydration entries represent a **daily total, not additional water**. Multiple current records on one date use the latest server-created record's total. The eventual backend should enforce one active daily-total record per person/date and update that record. Excess water earns no extra points. Unit conversion uses US fluid ounces: 1 fl oz = 29.5735295625 ml; 1 lb = 0.45359237 kg; 1 mi = 1.609344 km. Calculations retain precision; rounding is only for display.

## Calendar and eligibility

The competition default is America/New_York. A week begins Monday 00:00 and ends exclusively at the following Monday 00:00 in that timezone. Store activity and server timestamps in UTC. Calendar days are not fixed 24-hour durations: a DST transition week can span 167 or 169 elapsed hours. The next-start helper chooses the next strictly upcoming Monday, including when setup happens on a Monday.

New eligible submissions must arrive no more than **48 elapsed hours** after activity. The exact deadline is accepted; one millisecond later is historical and cannot earn consistency or benchmark credit. Future activity and dates before the shared start are rejected. A draft is not a submission of a completed workout. On-time existing records remain eligible after their submission window closes.

Preserve the immutable original activity time and server creation time. Editing the displayed date never restarts the original deadline. `evaluateEligibility` returns `canIncrease: false` after the deadline, but this flag is only a reference for the future backend. **The preview calculator cannot enforce reduction-only corrections because it has no historical award ledger.** A production mutation must compare against the prior committed award state under transaction before accepting/recomputing late changes.

A week stays provisional through the last possible entry deadline, conservatively until the next Monday's boundary plus 48 elapsed hours. Finalized weeks can still receive audited corrections that reduce points.

## Required backend implementation

- Authenticate the requester; authorize exactly the two memberships. Derive owner, approval identity, server time, eligibility, and scores on the server. Never accept those fields from a client command.
- Snapshot rules and each person's approved targets per week. Require both members to approve a proposal. Apply it no earlier than the following week; carry existing settings forward otherwise. Never rescore a past week with the latest settings.
- Atomically enforce idempotency and mutation versions. Duplicate request keys with the same payload return the original outcome; reused keys with different payloads fail. Use database uniqueness and transactions to prevent concurrent award duplication or conflicting proposals.
- Store private photos in private storage. Authorize every download through an authenticated byte response that checks the current record permission; do not expose bearer URLs that remain usable after sharing is revoked. Compare uploaded meal-file content hashes to block identical-photo reuse; the preview only recognizes reuse of the same media ID within the supplied owner's history. It cannot detect reuploaded bytes or prove activity occurred.
- Register up to three exercise/equipment/fixed-repetition strength benchmarks and one comparable cardio protocol. Baseline week earns normal eligible consistency but no bonus. In later weeks, compare against each benchmark's best prior eligible result using normalized units: higher strength load, shorter time at fixed distance, or greater distance at fixed duration. Cap bonuses at one per category per week. Changes require dual approval and a new baseline week; never lower an existing baseline.
- Recompute benchmark history in order after corrections/deletions, including downstream weeks. Preserve previous award ceilings for late corrections: deletion of an earlier best must not create a new award elsewhere. Changes after the original deadline may remove/reduce committed awards, never increase them or introduce a new award. Use an immutable, versioned award/audit history so this is enforceable and reviewable.
- Keep body records separate, private by default, and unscored. Apply explicit record sharing and revocation to data **and media**. Audits must not retain deleted photos or leak private measurements. Export only the requester's own data. Remove all private media on account deletion; any retained anonymized competition total must have a documented policy and cannot identify the departed person.

## Verification boundary

The focused unit suite covers consistency caps, precision, daily counting, drafts/history, duplicate IDs, version replacement, deletion recomputation, meal-reference reuse, original deadlines, exact 48-hour boundaries, local weeks, DST, and unit conversion. These tests do **not** establish production authentication, access controls, private file protection, concurrent database integrity, dual approval, benchmark bonuses, or reduction-only historical corrections. Those require connected backend tests with two members, a third account, and a signed-out caller.
