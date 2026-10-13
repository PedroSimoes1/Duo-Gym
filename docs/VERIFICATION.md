# Frontend foundation verification

Verified locally on October 8, 2026. This report covers the new local codebase, not the previous Base44 project.

## Results

| Check               | Result                         | Scope                                                                                           |
| ------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `npm run build`     | Passed                         | TypeScript checks, including browser tests; Vite production bundle                              |
| `npm test`          | 44 passed                      | 23 date/unit/scoring, 6 nutrition, 15 gateway/persistence tests                                 |
| `npm run test:e2e`  | 30 passed                      | Ten browser stories × three viewport configurations                                             |
| Horizontal overflow | None found                     | All six screens at 375px, 390px and 1440px                                                      |
| Runtime exceptions  | None in screen-navigation test | All six rendered screens in Chromium                                                            |
| Screenshots         | Captured and inspected         | Today, Competition, Progress, exercise picker and nutrition rings; mobile and desktop artifacts |

Test browser: Playwright Chromium, with a fixed New York test clock. Viewports: **375 × 812**, **390 × 844**, and **1440 × 1000**. Device scale is 1 for reviewable screenshots. This is viewport/touch emulation, **not actual iPhone Safari testing**.

## User stories exercised

1. Backend unavailable → explicit welcome screen → manually choose local preview → navigate all six screens through their navigation buttons. No automatic demo fallback after a failed API request.
2. Create a completed workout → save feedback → browser-persisted record → copy as an unsaved draft without creating a log → edit → reload and recover persisted record → delete.
3. Update today's existing water total → saved total displayed → create a meal without an uploaded photo → visibly unscored record. Preview file input remains disabled.
4. Toggle a sample body record's individual share/revoke control → propose next-week targets → only the current preview person's approval exists → proposal stays pending → change weekly leaderboard filter without changing all-time totals → open/close scoring rules.
5. Save profile preferences → download own-record export → confirm no partner records in export → reload and verify saved preference.
6. Open **Common exercises** → search exercise/equipment names case-insensitively → select bench press and squat variants → preserve previously entered numeric values → edit equipment → repeat the last set → explicitly complete/save → reload and verify the exact stored sets. Both default pounds and selected kilograms are covered. Picker dialog has no horizontal overflow at all three sizes.
7. Filter exercise categories → empty search result → custom-entry fallback → keyboard arrow/Home tab navigation → Enter in search does not submit a completed form → selecting a shortcut preserves custom and copied sets → cancel leaves persisted preview data byte-for-byte unchanged. This also confirms selection alone cannot award points.
8. Set optional personal nutrition goals → save two meals without photos → daily rings show exact summed calories/macros, optional nutrients and incomplete-data notice → reload restores entries/goals → edit and delete recalculate rings and persisted values. Nutrition screenshots and overflow checks cover all three viewports.
9. Reject zero goal → save positive goal → log explicit zero vs blank nutrient → show an over-goal amount while ring stays capped at 100% → previous date has its applicable goal history → partner selector is read-only and does not display own totals → clear optional goals while keeping logged totals.
10. An API fixture omitting `nutritionTracking` capability shows an unavailable notice and no nutrition entry fields or goal-write action. This is compatibility verification, not real backend authentication/security coverage.

## Focused calculations and adapter tests

- Exact 48-hour boundary and one millisecond later; original activity deadline cannot restart after editing; elapsed-hour behavior across DST.
- New York calendar days/Monday weeks, inclusive start/exclusive end, 167-hour spring week and 169-hour autumn week, next Monday/year/leap-day boundaries.
- Mass, distance and US fluid-ounce conversions; full precision until display.
- Daily caps, distinct strength/cardio activities, copied drafts, historical/unscored/body exclusions, highest record version and duplicate IDs, deletion recomputation, photo-reference reuse, required meal checklist, hydration totals rather than additions.
- Preview save/reload/delete, request replay without duplicate creation, request-key payload conflict, stale versions, own-record mutation checks and export projection. These are **local adapter behavior**, not server security tests.
- HTTP cookies/CSRF/idempotency/version headers; missing CSRF blocks writes; 401 stays an error; network failure never becomes simulated success; selected-file retries reuse one key; unsupported HEIC returns an explicit fallback.
- Private-data deletion does not keep raw deleted values in the local idempotency cache.
- Nutrition: unknown vs zero; invalid amounts/fields; independent member and date totals, DST transitions, unscored/historical meals, latest-version deduplication, edit/delete recomputation, effective-dated goal carry-forward, own-only versioned goal writes, replay protection, persistence/export, and no effect on existing points. No dietary target recommendations or image-based inference are implemented.

The original week-filter and new weight-preference browser tests timed out because their label selectors did not identify the select elements. The final suite uses accessible combobox roles and passes. No test is skipped or marked expected-failure.

The exercise catalog is a frontend-only set of name/equipment shortcuts, not a routine, medical recommendation, automatic benchmark assignment, or new scoring rule. It uses the existing workout payload and adds no dependency or service. Copying a set keeps its values editable; a workout is not persisted until explicitly saved.

## Boundary not yet crossed

**Browser → local preview adapter → browser storage → calculated preview → UI: verified.**

**Browser → real authentication/API → database/private storage → authoritative score → second account: not implemented or verified.**

There is no production backend in this deliverable. No genuine third-account/signed-out API or file denial, server authorization, private byte deletion/revocation, two-user approval transaction, secure concurrency, benchmark bonus, frozen late-correction ceiling, or account-removal claim is made. Claude's backend assignment and contract identify these requirements.

No real image was selected or uploaded. No user identities, invitations, secret keys, external service accounts, public deployments or paid runtime AI calls were created.

## Manual iPhone checks remaining

- Safari sign-in/session behavior once the private backend is integrated.
- Single existing-image picker selection; no in-app capture or broad library permission; JPEG/PNG/WebP upload and unsupported HEIC fallback.
- Decimal/numeric keyboards for weight, reps, duration, hydration and nutrition; timezone input around DST.
- Portrait/landscape layouts, notch/home-indicator safe areas, keyboard-open form scrolling, VoiceOver navigation and pinch/text zoom.
- Share → Add to Home Screen for the eventual private hosted URL. A localhost address on an iPhone refers to that iPhone, not this computer.
- Actual two-device saved-state refresh, allowed sharing, immediate revocation and file deletion against the real backend.

## Reproduce

```sh
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser suite starts and stops its own loopback development server. Source screenshots live under `artifacts/`; failed-test traces, if any, go under ignored `test-results/`.
