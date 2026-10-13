-- Gym Progress Duo integration follow-up
-- Adds manual nutrition tracking without changing competition scoring.

alter table public.meal_logs
  add column nutrition jsonb not null default '{}'::jsonb;

create function app_private.validate_nutrition(p jsonb, p_goals boolean default false)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_number numeric;
  v_max numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Nutrition values must be an object';
  end if;

  for v_key, v_value in select key, value from jsonb_each(p) loop
    if v_key not in ('calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium')
       or (p_goals and v_key in ('sugar', 'sodium')) then
      raise exception 'Unsupported nutrition field';
    end if;
    if jsonb_typeof(v_value) <> 'number' then
      raise exception 'Nutrition amounts must be numbers';
    end if;
    v_number := (v_value #>> '{}')::numeric;
    v_max := case when v_key in ('calories', 'sodium') then 100000 else 10000 end;
    if v_number < 0 or v_number > v_max or (p_goals and v_number = 0) then
      raise exception 'Nutrition amount is outside the supported range';
    end if;
    v_result := v_result || jsonb_build_object(v_key, v_number);
  end loop;
  return v_result;
exception when numeric_value_out_of_range or invalid_text_representation then
  raise exception 'Nutrition amount is outside the supported range';
end $$;

alter table public.meal_logs
  add constraint meal_logs_nutrition_valid
  check (nutrition = app_private.validate_nutrition(nutrition, false));

create table public.nutrition_goal_versions (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  effective_date date not null,
  version integer not null check (version > 0),
  goals jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, effective_date),
  unique (user_id, version),
  check (goals = app_private.validate_nutrition(goals, true))
);

create table app_private.nutrition_goal_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);

alter table public.nutrition_goal_versions enable row level security;
revoke all on public.nutrition_goal_versions from public, anon, authenticated;
grant select on public.nutrition_goal_versions to authenticated;
create policy member_read on public.nutrition_goal_versions for select to authenticated
  using (app_private.is_member_of(competition_id));

create function public.set_nutrition_goals(
  p_goals jsonb,
  p_expected_version integer,
  p_request_id uuid
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_comp public.competitions := app_private.require_member();
  v_uid uuid := auth.uid();
  v_clock timestamptz := app_private.clock();
  v_day date;
  v_current integer;
  v_valid jsonb;
  v_hash text;
  v_existing text;
begin
  if p_request_id is null then raise exception 'request id is required'; end if;
  v_valid := app_private.validate_nutrition(coalesce(p_goals, '{}'::jsonb), true);
  v_hash := md5(v_valid::text);

  -- Serialize this user's goal writes before checking the replay ledger so
  -- simultaneous retries observe the first committed request.
  perform 1 from public.profiles where user_id = v_uid for update;
  select payload_hash into v_existing
  from app_private.nutrition_goal_requests
  where user_id = v_uid and request_id = p_request_id;
  if found then
    if v_existing <> v_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return;
  end if;

  select coalesce(max(version), 0) into v_current
  from public.nutrition_goal_versions where user_id = v_uid;
  if p_expected_version is distinct from v_current then
    raise exception 'VERSION_CONFLICT';
  end if;

  v_day := app_private.local_day(v_clock, v_comp.timezone);
  insert into public.nutrition_goal_versions
    (competition_id, user_id, effective_date, version, goals, created_at, updated_at)
  values (v_comp.id, v_uid, v_day, v_current + 1, v_valid, v_clock, v_clock)
  on conflict (user_id, effective_date) do update set
    version = excluded.version,
    goals = excluded.goals,
    updated_at = excluded.updated_at;

  insert into app_private.nutrition_goal_requests (user_id, request_id, payload_hash)
  values (v_uid, p_request_id, v_hash);
end $$;

-- Replace meal mutation so the nutrition object is validated and persisted.
create or replace function public.save_meal(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.competitions := app_private.require_member();
  v_uid uuid := auth.uid(); v_clock timestamptz := app_private.clock();
  v_id uuid := nullif(p ->> 'id', '')::uuid; v_ck uuid := nullif(p ->> 'client_key', '')::uuid;
  v_act timestamptz := (p ->> 'activity_at')::timestamptz; v_etag text; v_check jsonb := '{}'::jsonb;
  v_nutrition jsonb := app_private.validate_nutrition(coalesce(p -> 'nutrition', '{}'::jsonb), false);
  ml public.meal_logs; v_removed text; v_event text; kv record;
begin
  if char_length(coalesce(p ->> 'description', '')) > 280 then raise exception 'Description is too long (280 characters max)'; end if;
  for kv in select * from jsonb_each(coalesce(p -> 'checklist', '{}'::jsonb)) loop
    if jsonb_typeof(kv.value) <> 'boolean' or kv.key !~ '^[a-z][a-z0-9_]{0,30}$' then
      raise exception 'Invalid checklist';
    end if;
    v_check := v_check || jsonb_build_object(kv.key, kv.value);
  end loop;

  if v_id is null then
    if v_ck is null then raise exception 'client_key is required'; end if;
    select id into v_id from public.meal_logs where user_id = v_uid and client_key = v_ck;
  end if;

  if v_id is null then
    perform app_private.assert_not_future(v_act);
    v_etag := app_private.own_photo_etag(p ->> 'photo_path', 'meals');
    insert into public.meal_logs (competition_id, user_id, client_key, description, photo_path, photo_etag,
                                  checklist, nutrition, activity_at, original_activity_at, submitted_at, created_at, updated_at)
    values (c.id, v_uid, v_ck, btrim(coalesce(p ->> 'description', '')), p ->> 'photo_path', v_etag,
            v_check, v_nutrition, v_act, v_act, v_clock, v_clock, v_clock)
    on conflict (user_id, client_key) do nothing
    returning id into v_id;
    if v_id is null then
      return jsonb_build_object('id', (select id from public.meal_logs where user_id = v_uid and client_key = v_ck),
                                'removed_photo_path', null);
    end if;
    v_event := 'logged';
  else
    select * into ml from public.meal_logs where id = v_id for update;
    if not found or ml.user_id <> v_uid then
      raise exception 'You can only edit your own logs' using errcode = '42501';
    end if;
    perform app_private.check_time_edit(ml.original_activity_at, ml.activity_at, v_act);
    if coalesce(p ->> 'photo_path', ml.photo_path) <> ml.photo_path then
      v_etag := app_private.own_photo_etag(p ->> 'photo_path', 'meals');
      v_removed := ml.photo_path;
    else
      v_etag := ml.photo_etag;
    end if;
    update public.meal_logs set description = btrim(coalesce(p ->> 'description', description)),
      photo_path = coalesce(p ->> 'photo_path', photo_path), photo_etag = v_etag, checklist = v_check,
      nutrition = v_nutrition, activity_at = v_act, updated_at = v_clock
    where id = v_id;
    v_event := case when v_clock > ml.original_activity_at + interval '48 hours' then 'corrected' else 'edited' end;
  end if;

  perform app_private.recompute(c.id, 'meal ' || v_event, v_uid);
  perform app_private.feed(c.id, 'meal_' || v_event, 'meal', v_id, v_event || ' a meal' ||
    coalesce(nullif(': ' || btrim(coalesce(p ->> 'description', '')), ': '), ''));
  return jsonb_build_object('id', v_id, 'removed_photo_path', v_removed);
end $$;

create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  perform app_private.require_member();
  return jsonb_build_object(
    'exported_at', app_private.clock(),
    'profile', (select to_jsonb(p) from public.profiles p where user_id = v_uid),
    'targets', (select coalesce(jsonb_agg(to_jsonb(t) order by effective_week), '[]') from public.target_versions t where user_id = v_uid),
    'nutrition_goals', (select coalesce(jsonb_agg(to_jsonb(n) order by effective_date), '[]') from public.nutrition_goal_versions n where user_id = v_uid),
    'benchmarks', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from public.benchmarks b where user_id = v_uid),
    'workouts', (select coalesce(jsonb_agg(to_jsonb(w) || jsonb_build_object('sets',
                   (select coalesce(jsonb_agg(to_jsonb(s) order by position), '[]') from public.workout_sets s where s.workout_id = w.id))
                   order by activity_at), '[]') from public.workouts w where user_id = v_uid),
    'templates', (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from public.workout_templates t where user_id = v_uid),
    'cardio', (select coalesce(jsonb_agg(to_jsonb(x) order by activity_at), '[]') from public.cardio_logs x where user_id = v_uid),
    'meals', (select coalesce(jsonb_agg(to_jsonb(x) order by activity_at), '[]') from public.meal_logs x where user_id = v_uid),
    'hydration', (select coalesce(jsonb_agg(to_jsonb(x) order by day), '[]') from public.hydration_logs x where user_id = v_uid),
    'body_records', (select coalesce(jsonb_agg(to_jsonb(x) order by recorded_on), '[]') from public.body_records x where user_id = v_uid),
    'weekly_scores', (select coalesce(jsonb_agg(to_jsonb(x) order by week_start), '[]') from public.weekly_scores x where user_id = v_uid));
end $$;

revoke all on function public.set_nutrition_goals(jsonb, integer, uuid) from public, anon;
grant execute on function public.set_nutrition_goals(jsonb, integer, uuid) to authenticated;
