# Gym Progress Duo — integrated foundation

A React + TypeScript app with Claude's Supabase backend imported and a first frontend connection layer. It has no Base44 dependency or connection. The frontend is deployed to Vercel behind Vercel Authentication at [gym-progress-duo.vercel.app](https://gym-progress-duo.vercel.app); local fictional preview mode remains available without creating accounts.

## Start here

Use Node.js **24 LTS** and npm. Open a terminal in this `gym-progress-duo` folder:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173` on this computer and choose **Explore local preview**. The first screen is intentionally honest about the backend not being connected. The development server listens only on this computer. A phone cannot open its own `127.0.0.1` address to reach this server.

To use real accounts, copy `.env.example` to `.env.local`, fill in the Supabase project URL and **publishable** key, apply every migration in `supabase/migrations`, and follow [the private setup checklist](docs/INTEGRATION_STATUS.md). Never place the secret/service-role key in a `VITE_` variable.

Use fictional values in the preview. Its records are stored in this browser's local storage, readable to anyone using that browser profile. It is not secure multi-user storage. Reloading returns to the welcome screen; selecting preview again restores its saved data. Settings → Reset fictional preview clears only this app's preview data.

## What works now

- Six responsive screens: Today, Workouts, Meals & water, Progress, Competition, and Settings.
- Large logging controls, an obsidian/champagne luxury theme, mobile bottom navigation, safe-area spacing, keyboard focus, reduced-motion support, and system fonts without external font requests.
- Workout and cardio logging; sets, units, date/time and notes; editing and deletion.
- A **Common exercises** tab in the workout form: 24 exercise/equipment shortcuts, search and upper-body/lower-body/core filters. Selection fills an unnamed row or adds a new one; existing exercises and entered reps/load remain unchanged. **Custom entry** is always available, and choosing exercises never saves or awards points by itself.
- Saved workout templates and copying a previous workout into an unsaved draft. Copying itself never creates an award.
- Daily hydration totals (editing an existing day's total instead of adding repeated credit), meal descriptions/checklists, and optional sample body measurements with individual sharing controls.
- Manual meal nutrition: calories, protein, carbs, fat, fiber, sugar and sodium. The Food screen totals each day's entries into calorie/macro/fiber rings, with optional personal goals, date history and a read-only partner view. Unknown values remain unknown, and over-goal amounts do not earn rewards. These descriptive totals are separate from competition points.
- Browser persistence, visible save/error states, request replay protection within the local adapter, stale-version rejection, own-record export, and a correction/activity list.
- Personal strength and cardio charts; weekly breakdowns and a separate permanent all-time sum in the preview.
- Pending next-week target proposals. The preview cannot impersonate a partner to give the second approval.
- A Supabase connection layer for invited-email code login, authorized reads, RPC mutations, scoring, private uploads, exports and logout. The earlier same-origin HTTP adapter remains for compatibility but is not the selected Claude backend.
- Pure reference helpers and tests for weekly habit scoring, DST-aware weeks, units, and 48-hour deadlines.

The preview contains two clearly fictional sample profiles and logs. Fixture meals have fictional photo IDs but no image bytes. They show the scoring layout; they are not real uploads. New preview meals without secure photos remain unscored.

For the nutrition tracker, open **Food → Set nutrition goals**, choose your own optional amounts, then **Add meal nutrition**. Enter values for the portion eaten; the app sums saved meal values, without estimating from photos or prescribing calorie targets. Goal changes apply from today in the competition timezone, retaining prior-day snapshots. Sugar and sodium have optional totals, not completion goals. Existing preview meals have no invented nutrition values. Nutrition is shared with the duo under meal-sharing rules; only the owner edits it. Local preview is still sample-only, not private storage.

## Claude backend integration

Claude's four original migrations, security tests and account-removal function are preserved under `supabase/`. The follow-up migration adds validated manual nutrition values and owner-only, effective-dated nutrition goals. The app now maps that backend to the existing frontend contract; it does not use Claude's replacement screens.

## Intentionally not complete yet

The code for login, invite-only membership, persistence, scoring, approvals and storage is present, but this copy is not connected to a real Supabase project and the imported database suite has not been run on this computer because no local Postgres/Docker runtime is available. Account deletion stays disabled in the frontend until the Edge Function is deployed and its media-byte deletion is verified. Record-version checks, changed-payload idempotency checks for Claude's original log RPCs, and failure-safe media deletion remain genuine integrity gaps; see [the integration status](docs/INTEGRATION_STATUS.md).

Photo upload is disabled in local preview. Connected mode accepts a single existing JPEG/PNG/WebP up to 10 MB, has no `capture` attribute, re-encodes the selected image to strip metadata, and gives a clear HEIC-to-JPEG fallback. No real image selection/upload flow has been tested on an iPhone. No sensors, library scanning, camera capture, push permissions, AI grading or paid AI services are used.

The local scoring reference awards habit consistency only (up to **90**); improvement is **0** until the server implements the two bonuses. The product maximum remains 100. Body records never earn points. Late preview edits are blocked instead of pretending to enforce production reduction-only correction rules. Deletion recomputes the local consistency total. Production must enforce correction ceilings and benchmark-history effects transactionally.

The current Vercel project uses the owner's existing plan. Future database, auth and storage costs depend on the Supabase setup; no paid plan is assumed. The old Base44 project was not changed or deleted as part of this replan.

## Verification

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

See [verification details](docs/VERIFICATION.md). Browser tests cover local preview flows at 375 × 812, 390 × 844, and 1440 × 1000 in Chromium. This is not actual iPhone Safari coverage or production security testing. Test screenshots go in `artifacts/`.

## Change the look

Edit the variables at the top of `src/styles.css`: background/panel colors, champagne accent, category colors, corner radius and sidebar width. All charts and controls inherit those values. The UI uses system fonts, inline icons and lightweight SVG charts; no chart service or remote image dependency.

## Project map

```text
src/
  App.tsx                 screens and app state
  components/             logging form and reusable UI
  data/supabase.ts        selected Supabase adapter
  data/http.ts            earlier same-origin adapter
  data/preview.ts         explicitly fictional browser-only adapter
  styles.css              theme and responsive layouts
shared/
  contracts.ts            frontend/backend payload types
  scoring.ts              preview/reference consistency calculations
  time.ts, units.ts       timezone and conversion helpers
tests/                    gateway/persistence tests
e2e/                      browser flow and viewport tests
docs/                     setup, API, scoring and verification
supabase/                 schema, RPCs, RLS, storage policy, functions and database tests
```
