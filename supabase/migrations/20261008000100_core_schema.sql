-- =====================================================================
-- Gym Progress Duo — 1/4 core schema
-- Tables, internal helpers, unit/time math.
-- Clients get READ access only (see 0400 security file); every write goes
-- through SECURITY DEFINER functions in 0200 so the server, not the phone,
-- sets timestamps, eligibility and points.
-- =====================================================================

create schema if not exists app_private;
revoke all on schema app_private from public;

-- ---------------------------------------------------------------------
-- Clock. Production: always now(). The test suite inserts one row to
-- freeze time. Clients cannot write app_private, so they cannot move it.
-- ---------------------------------------------------------------------
create table app_private.test_clock (
  singleton boolean primary key default true check (singleton),
  fixed_now timestamptz not null
);

create function app_private.clock() returns timestamptz
language sql stable as $$
  select coalesce((select fixed_now from app_private.test_clock limit 1), now())
$$;

-- Week = Monday 00:00 -> next Monday 00:00 in the competition time zone.
-- Converting to local time BEFORE truncating keeps DST transitions correct.
create function app_private.week_of(ts timestamptz, tz text) returns date
language sql immutable as $$ select date_trunc('week', ts at time zone tz)::date $$;

create function app_private.local_day(ts timestamptz, tz text) returns date
language sql immutable as $$ select (ts at time zone tz)::date $$;

create function app_private.local_midnight(d date, tz text) returns timestamptz
language sql immutable as $$ select (d::timestamp at time zone tz) $$;

create function app_private.norm_key(t text) returns text
language sql immutable as $$ select lower(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g')) $$;

-- Unit conversions (exact definitions).
create function app_private.to_kg(v numeric, unit text) returns numeric
language sql immutable as $$ select case unit when 'kg' then v when 'lb' then v * 0.45359237 end $$;

create function app_private.to_m(v numeric, unit text) returns numeric
language sql immutable as $$ select case unit when 'm' then v when 'km' then v * 1000 when 'mi' then v * 1609.344 end $$;

create function app_private.to_ml(v numeric, unit text) returns numeric
language sql immutable as $$ select case unit when 'ml' then v when 'oz' then v * 29.5735295625 end $$;

-- ---------------------------------------------------------------------
-- Competition & membership
-- ---------------------------------------------------------------------
create table public.competitions (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Gym Progress Duo' check (char_length(name) between 1 and 60),
  timezone text not null default 'America/New_York',
  start_date date not null check (extract(isodow from start_date) = 1),
  status text not null default 'setup' check (status in ('setup', 'active')),
  activated_at timestamptz,
  created_at timestamptz not null default now()
);

-- Who may join. Managed only by the project owner from the SQL editor.
create table app_private.invites (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  email text not null check (email = lower(email)),
  created_at timestamptz not null default now(),
  primary key (competition_id, email)
);

create table public.memberships (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid primary key references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  setup_agreed_hash text,
  setup_agreed_at timestamptz
);
create index on public.memberships(competition_id);

-- Shared profile (non-sensitive). Body data lives in body_records.
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  weight_unit text not null default 'lb' check (weight_unit in ('lb', 'kg')),
  distance_unit text not null default 'mi' check (distance_unit in ('mi', 'km')),
  water_unit text not null default 'oz' check (water_unit in ('oz', 'ml')),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Versioned rules and targets. A week uses the latest version whose
-- effective_week <= that week. Past weeks are never rewritten.
-- ---------------------------------------------------------------------
create table public.rule_versions (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  effective_week date not null check (extract(isodow from effective_week) = 1),
  rules jsonb not null,
  proposal_id uuid,
  created_at timestamptz not null default now(),
  unique (competition_id, effective_week)
);

create table public.target_versions (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  effective_week date not null check (extract(isodow from effective_week) = 1),
  strength_days_target int not null check (strength_days_target between 1 and 7),
  cardio_days_target int not null check (cardio_days_target between 1 and 7),
  hydration_target_ml numeric not null check (hydration_target_ml between 250 and 6000),
  cardio_min_minutes int not null check (cardio_min_minutes between 5 and 240),
  cardio_definition text not null default '' check (char_length(cardio_definition) <= 200),
  proposal_id uuid,
  created_at timestamptz not null default now(),
  unique (user_id, effective_week)
);

create table public.benchmarks (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('strength', 'cardio')),
  -- strength
  exercise text,
  equipment text,
  reps int check (reps between 1 and 50),
  exercise_key text generated always as (app_private.norm_key(exercise)) stored,
  equipment_key text generated always as (app_private.norm_key(equipment)) stored,
  -- cardio
  activity text,
  activity_key text generated always as (app_private.norm_key(activity)) stored,
  protocol text check (protocol in ('time_for_distance', 'distance_in_time')),
  fixed_distance_m numeric check (fixed_distance_m > 0 and fixed_distance_m <= 200000),
  fixed_duration_s int check (fixed_duration_s between 60 and 86400),
  -- versioning: baseline week = effective_week (no bonus that week)
  effective_week date not null check (extract(isodow from effective_week) = 1),
  retired_week date check (retired_week is null or extract(isodow from retired_week) = 1),
  proposal_id uuid,
  created_at timestamptz not null default now(),
  check (
    (kind = 'strength' and exercise is not null and equipment is not null and reps is not null
       and activity is null and protocol is null)
    or
    (kind = 'cardio' and activity is not null and exercise is null and reps is null and (
       (protocol = 'time_for_distance' and fixed_distance_m is not null and fixed_duration_s is null) or
       (protocol = 'distance_in_time' and fixed_duration_s is not null and fixed_distance_m is null)))
  )
);
create index on public.benchmarks(user_id, kind);

create table public.change_proposals (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  proposed_by uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('targets', 'rules', 'benchmarks')),
  subject_user_id uuid references auth.users(id) on delete cascade, -- null for shared rules
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'superseded')),
  effective_week date,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index on public.change_proposals(competition_id, status);

create table public.proposal_approvals (
  proposal_id uuid not null references public.change_proposals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  approved_at timestamptz not null default now(),
  primary key (proposal_id, user_id)
);

-- ---------------------------------------------------------------------
-- Logs. Every point-earning table carries:
--   client_key            idempotency key from the phone (retries/double taps)
--   activity_at           when it happened (editable only inside its window)
--   original_activity_at  first stated time; anchors the 48h window forever
--   submitted_at          trusted server time of first submission
-- ---------------------------------------------------------------------
create table public.workouts (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_key uuid not null,
  title text not null default '' check (char_length(title) <= 80),
  notes text not null default '' check (char_length(notes) <= 1000),
  status text not null check (status in ('draft', 'completed')),
  copied_from uuid,
  activity_at timestamptz not null,
  original_activity_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_key),
  check ((status = 'draft') = (submitted_at is null)),
  check ((original_activity_at is null) = (submitted_at is null))
);
create index on public.workouts(competition_id, activity_at);

create table public.workout_sets (
  id uuid primary key default gen_random_uuid(),
  workout_id uuid not null references public.workouts(id) on delete cascade,
  position int not null check (position between 0 and 99),
  exercise text not null check (char_length(exercise) between 1 and 60),
  equipment text not null default '' check (char_length(equipment) <= 60),
  sets int not null check (sets between 1 and 50),
  reps int not null check (reps between 1 and 1000),
  weight numeric not null check (weight >= 0 and weight <= 2000),
  weight_unit text not null check (weight_unit in ('lb', 'kg')),
  weight_kg numeric generated always as (app_private.to_kg(weight, weight_unit)) stored,
  exercise_key text generated always as (app_private.norm_key(exercise)) stored,
  equipment_key text generated always as (app_private.norm_key(equipment)) stored,
  unique (workout_id, position)
);

create table public.workout_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cardio_logs (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_key uuid not null,
  activity text not null check (char_length(activity) between 1 and 60),
  activity_key text generated always as (app_private.norm_key(activity)) stored,
  duration_s int not null check (duration_s between 1 and 86400),
  distance numeric check (distance > 0 and distance <= 1000),
  distance_unit text check (distance_unit in ('mi', 'km', 'm')),
  distance_m numeric generated always as (app_private.to_m(distance, distance_unit)) stored,
  steps int check (steps between 0 and 200000),
  notes text not null default '' check (char_length(notes) <= 1000),
  activity_at timestamptz not null,
  original_activity_at timestamptz not null,
  submitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_key),
  check ((distance is null) = (distance_unit is null))
);
create index on public.cardio_logs(competition_id, activity_at);

create table public.meal_logs (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,   -- strict submission order (tie-breaker)
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_key uuid not null,
  description text not null default '' check (char_length(description) <= 280),
  photo_path text not null,
  photo_etag text,               -- copied server-side from storage at save time
  checklist jsonb not null default '{}'::jsonb check (jsonb_typeof(checklist) = 'object'),
  activity_at timestamptz not null,
  original_activity_at timestamptz not null,
  submitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_key)
);
create index on public.meal_logs(competition_id, activity_at);
create index on public.meal_logs(photo_path);

-- One row per person per local day. "Activity time" for the 48h window is
-- the END of that day, so a day can be entered until 48h after it ends.
create table public.hydration_logs (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  amount numeric not null check (amount >= 0),
  unit text not null check (unit in ('oz', 'ml')),
  amount_ml numeric generated always as (app_private.to_ml(amount, unit)) stored,
  original_activity_at timestamptz not null,
  submitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day),
  -- sanity ceiling (~10 L). Points are only for meeting the target, never exceeding it.
  check (case unit when 'oz' then amount <= 340 else amount <= 10000 end)
);

-- Private body data. Never earns points. Visible to the other member only
-- when the owner shares that single record.
create table public.body_records (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_key uuid not null,
  recorded_on date not null,
  weight numeric check (weight > 0 and weight <= 1000),
  weight_unit text check (weight_unit in ('lb', 'kg')),
  measurements jsonb not null default '{}'::jsonb check (jsonb_typeof(measurements) = 'object'),
  photo_path text,
  notes text not null default '' check (char_length(notes) <= 1000),
  shared boolean not null default false,
  shared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_key),
  check ((weight is null) = (weight_unit is null))
);
create index on public.body_records(photo_path);

-- ---------------------------------------------------------------------
-- Scoring state (written only by app_private.recompute)
-- ---------------------------------------------------------------------
-- One row per (record, component). Once a record's 48h window closes the
-- credit can only go from true to false — never back to true.
create table public.record_credits (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  record_type text not null check (record_type in ('workout', 'workout_set', 'cardio', 'meal', 'hydration')),
  record_id uuid not null,
  component text not null check (component in
    ('strength_day', 'cardio_day', 'meal_day', 'hydration_day', 'strength_bonus', 'cardio_bonus')),
  week_start date not null,
  day date not null,
  computed boolean not null,      -- what current data says
  qualifies boolean not null,     -- what actually counts (computed, capped after window)
  window_closes_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (record_type, record_id, component)
);
create index on public.record_credits(user_id, week_start, component);

create table public.weekly_scores (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  strength_days int not null,
  meal_days int not null,
  cardio_days int not null,
  hydration_days int not null,
  strength_points numeric not null,
  meal_points numeric not null,
  cardio_points numeric not null,
  hydration_points numeric not null,
  strength_bonus numeric not null,
  cardio_bonus numeric not null,
  total numeric not null,
  targets jsonb not null,          -- snapshot used for this week
  rules jsonb not null,            -- snapshot used for this week
  status text not null check (status in ('provisional', 'final')),
  computed_at timestamptz not null,
  primary key (user_id, week_start)
);
create index on public.weekly_scores(competition_id, week_start);

-- Totals of someone who deleted their account, kept so the other person's
-- history still adds up. Contains no user id, no logs and no media.
create table public.former_member_scores (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  label text not null default 'Former member',
  week_start date not null,
  total numeric not null,
  removed_at timestamptz not null default now()
);

create table public.score_audit (
  id bigint generated always as identity primary key,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  week_start date not null,
  old_total numeric,
  new_total numeric not null,
  old_detail jsonb,
  new_detail jsonb not null,
  reason text not null,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.score_audit(competition_id, created_at desc);

create table public.activity_feed (
  id bigint generated always as identity primary key,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete cascade,
  kind text not null,
  ref_type text,
  ref_id uuid,
  summary text not null,
  created_at timestamptz not null default now()
);
create index on public.activity_feed(competition_id, created_at desc);
