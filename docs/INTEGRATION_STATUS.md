# Backend integration status

## What is connected in code

- Supabase invited-email OTP login with arbitrary signup disabled by the client request.
- Membership join/context, authorized shared logs, private/shared body records, weekly scores, all-time totals, targets, proposals, templates, activity history, own export and logout.
- Workout, cardio, meal, hydration and body create/edit/delete RPC calls.
- Private storage uploads to the signed-in user's `meals` or `body` folder. The browser rejects HEIC/HEIF and re-encodes JPEG/PNG/WebP selections before upload to remove metadata.
- Manual meal nutrition and member-visible, owner-writable nutrition-goal snapshots through `20261010132730_integration_hardening_and_nutrition.sql`. Nutrition never changes competition points.

## One-time private setup

1. Create a private Supabase project yourself. Do not share its password or secret/service-role key in chat.
2. Apply the SQL files in `supabase/migrations` in filename order using the Supabase CLI or SQL editor.
3. In the SQL editor, call `app_private.admin_create_competition('first@email', 'second@email')` once with the exact two invited email addresses.
4. Create those two Auth users or invite them from Supabase. Disable public user signup in Auth settings.
5. Copy `.env.example` to `.env.local`; add only the project URL and publishable key. Restart `npm run dev`.
6. Deploy `supabase/functions/delete-account` only when account removal is wanted, then set its allowed app origin. Keep the service-role key in Supabase server secrets only.

New Supabase projects require explicit table/function grants as well as RLS; the migrations include those grants. Customizing the built-in OTP email template may require custom SMTP on newly created projects, so the default email is acceptable for V1.

## Verified here

- `npm run build`: passed.
- `npm test`: 44/44 passed.
- `npm run test:e2e`: 30/30 passed in Chromium at 375 px, 390 px and desktop widths.
- The imported backend files were copied byte-for-byte before the follow-up migration was added.

## Not verified here / genuine limitations

- No Supabase project is linked, so real two-account login, API/RLS denial, private storage and live scoring have not been exercised end to end.
- Claude's database tests require a local Postgres 16 server. This computer currently has neither Postgres nor Docker, so those tests were not rerun here.
- Claude's original log RPCs deduplicate `client_key`, but do not store a request-body hash. Reusing a key with a changed body can silently replay the first result instead of returning an idempotency conflict.
- Original mutable log rows have no optimistic `version` column/check, so the frontend's `expectedVersion` cannot yet prevent a concurrent lost update.
- Meal/body deletion removes the database row before the browser deletes the private object. A failed second step can orphan private bytes. A server-side deletion queue or transactionally coordinated cleanup function is the minimum practical fix.
- Storage access is protected by RLS, but any downloaded or short-lived signed copy cannot be revoked from a device that already saved it.
- Actual iPhone Safari OTP/session behavior, image selection, numeric keyboards, safe areas, home-screen install and the HEIC fallback remain manual-device checks.
- This is an honor-based competition. Manual logs and photos cannot prove what was eaten or exercised.
