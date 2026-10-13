-- =====================================================================
-- Gym Progress Duo — 3/4 API (all writes go through these functions)
-- Every function: checks the caller is a member, uses the server clock,
-- validates input, writes, recomputes scores, logs to the shared feed.
-- Errors are plain-language messages safe to show in the app.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Small internal helpers
-- ---------------------------------------------------------------------
create function app_private.feed(p_comp uuid, p_kind text, p_ref_type text, p_ref uuid, p_summary text)
returns void language sql security definer set search_path = public as $$
  insert into public.activity_feed (competition_id, actor_id, kind, ref_type, ref_id, summary, created_at)
  values (p_comp, auth.uid(), p_kind, p_ref_type, p_ref, left(p_summary, 200), app_private.clock())
$$;

create function app_private.assert_not_future(p_ts timestamptz) returns void
language plpgsql stable as $$
begin
  if p_ts is null then raise exception 'Date and time are required'; end if;
  if p_ts > app_private.clock() + interval '5 minutes' then
    raise exception 'That time is in the future. Log activities after they happen.';
  end if;
end $$;

-- Changing the stated time is only allowed inside the original 48h window,
-- and only to a time within the last 48h, so editing can never restart the
-- deadline or push an entry into an already-closed day.
create function app_private.check_time_edit(p_original timestamptz, p_old timestamptz, p_new timestamptz)
returns void language plpgsql stable as $$
begin
  if p_new is null then raise exception 'Date and time are required'; end if;
  if p_new is not distinct from p_old then return; end if;
  if app_private.clock() > p_original + interval '48 hours' then
    raise exception 'The date and time can no longer be changed: the 48-hour window for this entry has closed.';
  end if;
  if p_new < app_private.clock() - interval '48 hours' then
    raise exception 'You can only move an entry to a time within the last 48 hours.';
  end if;
  perform app_private.assert_not_future(p_new);
end $$;

-- Photo must be the caller's own upload in the right folder; returns the
-- storage eTag (content hash) used for duplicate-photo detection.
create function app_private.own_photo_etag(p_path text, p_kind text) returns text
language plpgsql stable security definer set search_path = public, storage as $$
declare v_etag text;
begin
  if p_path is null or split_part(p_path, '/', 1) <> auth.uid()::text
     or split_part(p_path, '/', 2) <> p_kind then
    raise exception 'Photo must be one you uploaded to your own % folder', p_kind using errcode = '42501';
  end if;
  select coalesce(o.metadata ->> 'eTag', o.id::text) into v_etag
  from storage.objects o where o.bucket_id = 'media' and o.name = p_path;
  if not found then
    raise exception 'The photo upload did not finish. Please choose the photo again.';
  end if;
  return v_etag;
end $$;

create function app_private.default_rules() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'scoring_version', 'v1',
    'meal_days_required', 5,
    'meal_checklist', jsonb_build_array(
      jsonb_build_object('key', 'protein', 'label', 'Includes a protein source'),
      jsonb_build_object('key', 'produce_or_fiber', 'label', 'Includes a fruit, vegetable, or other fiber-rich food')))
$$;

create function app_private.validate_rules(p jsonb) returns jsonb
language plpgsql immutable as $$
declare v_days int; v_list jsonb; v_out jsonb := '[]'::jsonb; item jsonb; v_keys text[] := '{}';
begin
  v_days := coalesce((p ->> 'meal_days_required')::int, 5);
  if v_days not between 1 and 7 then raise exception 'Meal days per week must be 1–7'; end if;
  v_list := coalesce(p -> 'meal_checklist', app_private.default_rules() -> 'meal_checklist');
  if jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) not between 1 and 5 then
    raise exception 'The meal checklist needs 1 to 5 items';
  end if;
  for item in select * from jsonb_array_elements(v_list) loop
    if (item ->> 'key') !~ '^[a-z][a-z0-9_]{0,30}$' then raise exception 'Invalid checklist key'; end if;
    if char_length(coalesce(item ->> 'label', '')) not between 1 and 80 then
      raise exception 'Each checklist item needs a label (max 80 characters)';
    end if;
    if (item ->> 'key') = any (v_keys) then raise exception 'Checklist keys must be unique'; end if;
    v_keys := v_keys || (item ->> 'key');
    v_out := v_out || jsonb_build_array(jsonb_build_object('key', item ->> 'key', 'label', btrim(item ->> 'label')));
  end loop;
  return jsonb_build_object('scoring_version', 'v1', 'meal_days_required', v_days, 'meal_checklist', v_out);
end $$;

create function app_private.validate_targets(p jsonb) returns jsonb
language plpgsql immutable as $$
declare v jsonb;
begin
  v := jsonb_build_object(
    'strength_days_target', (p ->> 'strength_days_target')::int,
    'cardio_days_target', (p ->> 'cardio_days_target')::int,
    'hydration_target_ml', round((p ->> 'hydration_target_ml')::numeric, 1),
    'cardio_min_minutes', (p ->> 'cardio_min_minutes')::int,
    'cardio_definition', btrim(coalesce(p ->> 'cardio_definition', '')));
  if (v ->> 'strength_days_target')::int is null or (v ->> 'strength_days_target')::int not between 1 and 7
     or (v ->> 'cardio_days_target')::int is null or (v ->> 'cardio_days_target')::int not between 1 and 7 then
    raise exception 'Weekly strength and cardio targets must each be 1–7 days';
  end if;
  if (v ->> 'hydration_target_ml')::numeric is null or (v ->> 'hydration_target_ml')::numeric not between 250 and 6000 then
    raise exception 'Daily water target must be between 250 ml (about 8 oz) and 6000 ml (about 203 oz)';
  end if;
  if (v ->> 'cardio_min_minutes')::int is null or (v ->> 'cardio_min_minutes')::int not between 5 and 240 then
    raise exception 'A qualifying cardio session must be 5–240 minutes';
  end if;
  if char_length(v ->> 'cardio_definition') > 200 then raise exception 'Cardio description is too long'; end if;
  return v;
end $$;

-- Benchmarks payload: {"strength":[{exercise,equipment,reps}..≤3],
--   "cardio": null | {activity, protocol:'time_for_distance', distance, distance_unit}
--                  | {activity, protocol:'distance_in_time', duration_s}}
create function app_private.validate_benchmarks(p jsonb) returns jsonb
language plpgsql immutable as $$
declare item jsonb; v_strength jsonb := '[]'::jsonb; v_cardio jsonb; v_seen text[] := '{}'; v_key text; v_m numeric;
begin
  if jsonb_typeof(coalesce(p -> 'strength', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p -> 'strength', '[]'::jsonb)) > 3 then
    raise exception 'Choose up to three strength benchmarks';
  end if;
  for item in select * from jsonb_array_elements(coalesce(p -> 'strength', '[]'::jsonb)) loop
    if char_length(btrim(coalesce(item ->> 'exercise', ''))) not between 1 and 60 then
      raise exception 'Each strength benchmark needs an exercise name';
    end if;
    if char_length(coalesce(item ->> 'equipment', '')) > 60 then raise exception 'Equipment name is too long'; end if;
    if (item ->> 'reps')::int is null or (item ->> 'reps')::int not between 1 and 50 then
      raise exception 'Benchmark repetitions must be 1–50';
    end if;
    v_key := app_private.norm_key(item ->> 'exercise') || '|' || app_private.norm_key(item ->> 'equipment') || '|' || (item ->> 'reps');
    if v_key = any (v_seen) then raise exception 'Two strength benchmarks are identical'; end if;
    v_seen := v_seen || v_key;
    v_strength := v_strength || jsonb_build_array(jsonb_build_object(
      'exercise', btrim(item ->> 'exercise'), 'equipment', btrim(coalesce(item ->> 'equipment', '')),
      'reps', (item ->> 'reps')::int));
  end loop;

  item := p -> 'cardio';
  if item is null or jsonb_typeof(item) = 'null' then
    v_cardio := null;
  else
    if char_length(btrim(coalesce(item ->> 'activity', ''))) not between 1 and 60 then
      raise exception 'The cardio benchmark needs an activity';
    end if;
    if item ->> 'protocol' = 'time_for_distance' then
      v_m := app_private.to_m((item ->> 'distance')::numeric, item ->> 'distance_unit');
      if v_m is null or v_m <= 0 or v_m > 200000 then raise exception 'Enter the fixed distance for the cardio benchmark'; end if;
      v_cardio := jsonb_build_object('activity', btrim(item ->> 'activity'), 'protocol', 'time_for_distance',
                                     'fixed_distance_m', v_m);
    elsif item ->> 'protocol' = 'distance_in_time' then
      if (item ->> 'duration_s')::int is null or (item ->> 'duration_s')::int not between 60 and 86400 then
        raise exception 'Enter the fixed duration for the cardio benchmark';
      end if;
      v_cardio := jsonb_build_object('activity', btrim(item ->> 'activity'), 'protocol', 'distance_in_time',
                                     'fixed_duration_s', (item ->> 'duration_s')::int);
    else
      raise exception 'Cardio benchmark protocol must be time_for_distance or distance_in_time';
    end if;
  end if;
  return jsonb_build_object('strength', v_strength, 'cardio', v_cardio);
end $$;

create function app_private.setup_hash(p_comp uuid) returns text
language sql stable security definer set search_path = public as $$
  select md5(jsonb_build_object(
    'start', c.start_date,
    'rules', (select rules from public.rule_versions rv where rv.competition_id = c.id and rv.effective_week = c.start_date),
    'targets', (select coalesce(jsonb_agg(jsonb_build_object(
                  'u', t.user_id, 's', t.strength_days_target, 'c', t.cardio_days_target,
                  'h', t.hydration_target_ml, 'm', t.cardio_min_minutes, 'd', t.cardio_definition)
                  order by t.user_id), '[]'::jsonb)
                from public.target_versions t where t.competition_id = c.id and t.effective_week = c.start_date),
    'benchmarks', (select coalesce(jsonb_agg(jsonb_build_object(
                  'u', b.user_id, 'k', b.kind, 'e', b.exercise_key, 'q', b.equipment_key, 'r', b.reps,
                  'a', b.activity_key, 'p', b.protocol, 'dm', b.fixed_distance_m, 'ds', b.fixed_duration_s)
                  order by b.user_id, b.kind, b.exercise_key, b.equipment_key, b.reps), '[]'::jsonb)
                from public.benchmarks b where b.competition_id = c.id and b.effective_week = c.start_date)
  )::text)
  from public.competitions c where c.id = p_comp
$$;

create function app_private.reset_agreements(p_comp uuid) returns void
language sql security definer set search_path = public as $$
  update public.memberships set setup_agreed_hash = null, setup_agreed_at = null where competition_id = p_comp
$$;

create function app_private.require_setup() returns public.competitions
language plpgsql stable security definer set search_path = public as $$
declare c public.competitions := app_private.require_member();
begin
  if c.status <> 'setup' then
    raise exception 'The competition has started. Changes now need a proposal that both of you approve.';
  end if;
  return c;
end $$;

-- Replace a person's benchmark set as of a given week (used by setup and
-- by approved proposals). Unchanged benchmarks keep their history; changed
-- or new ones start a fresh baseline week; removed ones are retired.
create function app_private.apply_benchmarks(p_comp uuid, p_user uuid, p_week date, p jsonb, p_proposal uuid)
returns void language plpgsql security definer set search_path = public as $$
declare item jsonb; b record;
begin
  -- retire / drop active benchmarks that are not in the new set
  for b in select * from public.benchmarks
           where user_id = p_user and effective_week <= p_week
             and (retired_week is null or retired_week > p_week) loop
    if (b.kind = 'strength' and not exists (
          select 1 from jsonb_array_elements(p -> 'strength') s
          where app_private.norm_key(s ->> 'exercise') = b.exercise_key
            and app_private.norm_key(s ->> 'equipment') = b.equipment_key
            and (s ->> 'reps')::int = b.reps))
       or (b.kind = 'cardio' and (
          jsonb_typeof(p -> 'cardio') is distinct from 'object'
          or app_private.norm_key(p -> 'cardio' ->> 'activity') <> b.activity_key
          or (p -> 'cardio' ->> 'protocol') <> b.protocol
          or (p -> 'cardio' ->> 'fixed_distance_m')::numeric is distinct from b.fixed_distance_m
          or (p -> 'cardio' ->> 'fixed_duration_s')::int is distinct from b.fixed_duration_s)) then
      if b.effective_week = p_week then
        delete from public.benchmarks where id = b.id;      -- never used yet
      else
        update public.benchmarks set retired_week = p_week where id = b.id;
      end if;
    end if;
  end loop;

  for item in select * from jsonb_array_elements(p -> 'strength') loop
    if not exists (select 1 from public.benchmarks
                   where user_id = p_user and kind = 'strength'
                     and exercise_key = app_private.norm_key(item ->> 'exercise')
                     and equipment_key = app_private.norm_key(item ->> 'equipment')
                     and reps = (item ->> 'reps')::int
                     and effective_week <= p_week and (retired_week is null or retired_week > p_week)) then
      insert into public.benchmarks (competition_id, user_id, kind, exercise, equipment, reps, effective_week, proposal_id)
      values (p_comp, p_user, 'strength', item ->> 'exercise', item ->> 'equipment', (item ->> 'reps')::int, p_week, p_proposal);
    end if;
  end loop;

  if jsonb_typeof(p -> 'cardio') = 'object' and not exists (
       select 1 from public.benchmarks
       where user_id = p_user and kind = 'cardio'
         and effective_week <= p_week and (retired_week is null or retired_week > p_week)) then
    insert into public.benchmarks (competition_id, user_id, kind, activity, protocol, fixed_distance_m, fixed_duration_s,
                                   effective_week, proposal_id)
    values (p_comp, p_user, 'cardio', p -> 'cardio' ->> 'activity', p -> 'cardio' ->> 'protocol',
            (p -> 'cardio' ->> 'fixed_distance_m')::numeric, (p -> 'cardio' ->> 'fixed_duration_s')::int,
            p_week, p_proposal);
  end if;
end $$;

-- =====================================================================
-- OWNER BOOTSTRAP (run once from the Supabase SQL editor; not callable
-- from the app). Creates the competition and the only two invites.
-- =====================================================================
create function app_private.admin_create_competition(
  p_email_a text, p_email_b text, p_start date default null,
  p_name text default 'Gym Progress Duo', p_timezone text default 'America/New_York')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_start date;
begin
  if lower(btrim(p_email_a)) = lower(btrim(p_email_b)) then raise exception 'Two different emails are required'; end if;
  perform now() at time zone p_timezone;  -- validates the time zone name
  v_start := coalesce(p_start, app_private.week_of(app_private.clock(), p_timezone) + 7);
  insert into public.competitions (name, timezone, start_date) values (p_name, p_timezone, v_start) returning id into v_id;
  insert into app_private.invites (competition_id, email)
  values (v_id, lower(btrim(p_email_a))), (v_id, lower(btrim(p_email_b)));
  insert into public.rule_versions (competition_id, effective_week, rules) values (v_id, v_start, app_private.default_rules());
  return v_id;
end $$;

-- =====================================================================
-- MEMBERSHIP & CONTEXT
-- =====================================================================
create function public.join_competition() returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; v_confirmed timestamptz; v_comp uuid; c public.competitions;
begin
  if v_uid is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  select competition_id into v_comp from public.memberships where user_id = v_uid;
  if found then return v_comp; end if;

  select lower(email), email_confirmed_at into v_email, v_confirmed from auth.users where id = v_uid;
  if v_confirmed is null then
    raise exception 'Please confirm your email address first' using errcode = '42501';
  end if;
  select i.competition_id into v_comp from app_private.invites i where i.email = v_email limit 1;
  if v_comp is null then
    raise exception 'This account has not been invited' using errcode = '42501';
  end if;

  select * into c from public.competitions where id = v_comp for update;   -- serialize joins
  if (select count(*) from public.memberships where competition_id = v_comp) >= 2 then
    raise exception 'This competition already has two members' using errcode = '42501';
  end if;

  insert into public.memberships (competition_id, user_id, joined_at) values (v_comp, v_uid, app_private.clock());
  insert into public.profiles (user_id, competition_id, display_name)
  values (v_uid, v_comp, left(split_part(v_email, '@', 1), 40));
  insert into public.target_versions (competition_id, user_id, effective_week, strength_days_target,
                                      cardio_days_target, hydration_target_ml, cardio_min_minutes, cardio_definition)
  values (v_comp, v_uid,
          case when c.status = 'setup' then c.start_date
               else greatest(c.start_date, app_private.week_of(app_private.clock(), c.timezone) + 7) end,
          3, 2, 2000, 20, '')
  on conflict (user_id, effective_week) do nothing;
  if c.status = 'setup' then perform app_private.reset_agreements(v_comp); end if;
  perform app_private.feed(v_comp, 'joined', null, null, 'joined the competition');
  return v_comp;
end $$;

create function public.get_my_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.competitions := app_private.require_member(); v_clock timestamptz := app_private.clock();
begin
  return jsonb_build_object(
    'user_id', auth.uid(),
    'server_time', v_clock,
    'competition', to_jsonb(c),
    'local_today', app_private.local_day(v_clock, c.timezone),
    'current_week', app_private.week_of(v_clock, c.timezone),
    'next_change_week', greatest(c.start_date, app_private.week_of(v_clock, c.timezone) + 7),
    'setup_hash', case when c.status = 'setup' then app_private.setup_hash(c.id) end,
    'members', (select jsonb_agg(jsonb_build_object(
        'user_id', p.user_id, 'display_name', p.display_name,
        'weight_unit', p.weight_unit, 'distance_unit', p.distance_unit, 'water_unit', p.water_unit,
        'agreed_to_setup', m.setup_agreed_hash is not null
                           and m.setup_agreed_hash = app_private.setup_hash(c.id),
        'is_me', p.user_id = auth.uid()) order by m.joined_at)
      from public.memberships m join public.profiles p on p.user_id = m.user_id
      where m.competition_id = c.id));
end $$;

create function public.update_profile(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member();
begin
  update public.profiles set
    display_name = coalesce(nullif(btrim(p ->> 'display_name'), ''), display_name),
    weight_unit = coalesce(p ->> 'weight_unit', weight_unit),
    distance_unit = coalesce(p ->> 'distance_unit', distance_unit),
    water_unit = coalesce(p ->> 'water_unit', water_unit),
    updated_at = app_private.clock()
  where user_id = auth.uid();
end $$;

-- =====================================================================
-- SETUP (before the competition starts). Any change clears both
-- agreements; the competition starts only when both agree to the same
-- exact setup.
-- =====================================================================
create function public.update_setup(p_start_date date, p_rules jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_setup(); v_rules jsonb; v_old date := c.start_date; v_new date;
begin
  v_new := coalesce(p_start_date, c.start_date);
  if extract(isodow from v_new) <> 1 then raise exception 'The start date must be a Monday'; end if;
  if v_new < app_private.local_day(app_private.clock(), c.timezone) then
    raise exception 'The start date cannot be in the past';
  end if;
  v_rules := app_private.validate_rules(coalesce(p_rules,
               (select rules from public.rule_versions where competition_id = c.id and effective_week = v_old)));
  if v_new <> v_old then
    update public.competitions set start_date = v_new where id = c.id;
    update public.rule_versions set effective_week = v_new where competition_id = c.id and effective_week = v_old;
    update public.target_versions set effective_week = v_new where competition_id = c.id and effective_week = v_old;
    update public.benchmarks set effective_week = v_new where competition_id = c.id and effective_week = v_old;
  end if;
  insert into public.rule_versions (competition_id, effective_week, rules) values (c.id, v_new, v_rules)
  on conflict (competition_id, effective_week) do update set rules = excluded.rules;
  perform app_private.reset_agreements(c.id);
end $$;

create function public.set_my_setup_targets(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_setup(); v jsonb := app_private.validate_targets(p);
begin
  insert into public.target_versions (competition_id, user_id, effective_week, strength_days_target,
    cardio_days_target, hydration_target_ml, cardio_min_minutes, cardio_definition)
  values (c.id, auth.uid(), c.start_date, (v ->> 'strength_days_target')::int, (v ->> 'cardio_days_target')::int,
          (v ->> 'hydration_target_ml')::numeric, (v ->> 'cardio_min_minutes')::int, v ->> 'cardio_definition')
  on conflict (user_id, effective_week) do update set
    strength_days_target = excluded.strength_days_target, cardio_days_target = excluded.cardio_days_target,
    hydration_target_ml = excluded.hydration_target_ml, cardio_min_minutes = excluded.cardio_min_minutes,
    cardio_definition = excluded.cardio_definition;
  perform app_private.reset_agreements(c.id);
end $$;

create function public.set_my_setup_benchmarks(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_setup(); v jsonb := app_private.validate_benchmarks(p);
begin
  delete from public.benchmarks where user_id = auth.uid() and effective_week = c.start_date;
  perform app_private.apply_benchmarks(c.id, auth.uid(), c.start_date, v, null);
  perform app_private.reset_agreements(c.id);
end $$;

create function public.agree_to_setup() returns text
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_setup(); v_hash text; v_agreed int;
begin
  if c.start_date < app_private.local_day(app_private.clock(), c.timezone) then
    raise exception 'The start date has passed. Pick a new start date first.';
  end if;
  v_hash := app_private.setup_hash(c.id);
  update public.memberships set setup_agreed_hash = v_hash, setup_agreed_at = app_private.clock()
  where user_id = auth.uid();
  perform app_private.feed(c.id, 'agreed', null, null, 'agreed to the start date, rules and targets');

  select count(*) into v_agreed from public.memberships where competition_id = c.id and setup_agreed_hash = v_hash;
  if v_agreed = 2 then
    if (select count(*) from public.target_versions where competition_id = c.id and effective_week = c.start_date) <> 2 then
      raise exception 'Both people need weekly targets before starting';
    end if;
    update public.competitions set status = 'active', activated_at = app_private.clock() where id = c.id;
    perform app_private.feed(c.id, 'started', null, null, 'Competition locked in. It starts ' || to_char(c.start_date, 'Dy Mon DD'));
    perform app_private.recompute(c.id, 'competition activated', auth.uid());
    return 'active';
  end if;
  return 'waiting';
end $$;

-- =====================================================================
-- CHANGE PROPOSALS (after start). Proposing counts as the proposer's
-- approval. Applies the Monday after the second approval. Never retroactive.
-- =====================================================================
create function public.propose_change(p_kind text, p_payload jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_active(); v_payload jsonb; v_subject uuid; v_id uuid;
begin
  if p_kind = 'targets' then
    v_payload := app_private.validate_targets(p_payload); v_subject := auth.uid();
  elsif p_kind = 'rules' then
    v_payload := app_private.validate_rules(p_payload); v_subject := null;
  elsif p_kind = 'benchmarks' then
    v_payload := app_private.validate_benchmarks(p_payload); v_subject := auth.uid();
  else
    raise exception 'Unknown change type';
  end if;

  update public.change_proposals set status = 'superseded', decided_at = app_private.clock()
  where competition_id = c.id and status = 'pending' and kind = p_kind
    and subject_user_id is not distinct from v_subject;

  insert into public.change_proposals (competition_id, proposed_by, kind, subject_user_id, payload, created_at)
  values (c.id, auth.uid(), p_kind, v_subject, v_payload, app_private.clock()) returning id into v_id;
  insert into public.proposal_approvals (proposal_id, user_id, approved_at) values (v_id, auth.uid(), app_private.clock());
  perform app_private.feed(c.id, 'proposal', 'proposal', v_id, 'proposed a change to ' ||
    case p_kind when 'targets' then 'their weekly targets' when 'rules' then 'the shared rules' else 'their benchmarks' end);
  return v_id;
end $$;

create function public.approve_proposal(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_active(); pr public.change_proposals; v_week date; v int;
begin
  select * into pr from public.change_proposals where id = p_id and competition_id = c.id for update;
  if not found then raise exception 'Proposal not found'; end if;
  if pr.status <> 'pending' then return pr.status; end if;      -- idempotent

  insert into public.proposal_approvals (proposal_id, user_id, approved_at)
  values (p_id, auth.uid(), app_private.clock()) on conflict do nothing;

  select count(*) into v from public.proposal_approvals a
  join public.memberships m on m.user_id = a.user_id and m.competition_id = c.id
  where a.proposal_id = p_id;
  if v < 2 then return 'pending'; end if;

  v_week := greatest(c.start_date, app_private.week_of(app_private.clock(), c.timezone) + 7);
  if pr.kind = 'targets' then
    insert into public.target_versions (competition_id, user_id, effective_week, strength_days_target,
      cardio_days_target, hydration_target_ml, cardio_min_minutes, cardio_definition, proposal_id)
    values (c.id, pr.subject_user_id, v_week, (pr.payload ->> 'strength_days_target')::int,
            (pr.payload ->> 'cardio_days_target')::int, (pr.payload ->> 'hydration_target_ml')::numeric,
            (pr.payload ->> 'cardio_min_minutes')::int, pr.payload ->> 'cardio_definition', pr.id)
    on conflict (user_id, effective_week) do update set
      strength_days_target = excluded.strength_days_target, cardio_days_target = excluded.cardio_days_target,
      hydration_target_ml = excluded.hydration_target_ml, cardio_min_minutes = excluded.cardio_min_minutes,
      cardio_definition = excluded.cardio_definition, proposal_id = excluded.proposal_id;
  elsif pr.kind = 'rules' then
    insert into public.rule_versions (competition_id, effective_week, rules, proposal_id)
    values (c.id, v_week, pr.payload, pr.id)
    on conflict (competition_id, effective_week) do update set rules = excluded.rules, proposal_id = excluded.proposal_id;
  else
    perform app_private.apply_benchmarks(c.id, pr.subject_user_id, v_week, pr.payload, pr.id);
  end if;

  update public.change_proposals set status = 'approved', decided_at = app_private.clock(), effective_week = v_week
  where id = p_id;
  perform app_private.feed(c.id, 'approved', 'proposal', p_id,
    'approved a change, starting the week of ' || to_char(v_week, 'Mon DD'));
  perform app_private.recompute(c.id, 'proposal approved', auth.uid());
  return 'approved';
end $$;

create function public.reject_proposal(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member(); pr public.change_proposals; v_status text;
begin
  select * into pr from public.change_proposals where id = p_id and competition_id = c.id for update;
  if not found then raise exception 'Proposal not found'; end if;
  if pr.status <> 'pending' then return pr.status; end if;
  v_status := case when pr.proposed_by = auth.uid() then 'withdrawn' else 'rejected' end;
  update public.change_proposals set status = v_status, decided_at = app_private.clock() where id = p_id;
  perform app_private.feed(c.id, v_status, 'proposal', p_id,
    case v_status when 'withdrawn' then 'withdrew a proposed change' else 'declined a proposed change' end);
  return v_status;
end $$;

-- =====================================================================
-- STRENGTH WORKOUTS
-- p: {id?, client_key, title, notes, activity_at, status: 'draft'|'completed',
--     sets: [{exercise, equipment, sets, reps, weight, weight_unit}]}
-- Omit "sets" to keep the existing rows. Retrying with the same client_key
-- returns the same workout (no duplicates).
-- =====================================================================
create function app_private.write_sets(p_workout uuid, p_sets jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare n int := jsonb_array_length(p_sets); item jsonb; i int;
begin
  if n > 40 then raise exception 'A workout can have at most 40 exercise rows'; end if;
  delete from public.workout_sets where workout_id = p_workout and position >= n;
  for i in 0 .. n - 1 loop
    item := p_sets -> i;
    insert into public.workout_sets (workout_id, position, exercise, equipment, sets, reps, weight, weight_unit)
    values (p_workout, i, btrim(item ->> 'exercise'), btrim(coalesce(item ->> 'equipment', '')),
            (item ->> 'sets')::int, (item ->> 'reps')::int, coalesce((item ->> 'weight')::numeric, 0),
            coalesce(item ->> 'weight_unit', 'lb'))
    on conflict (workout_id, position) do update set
      exercise = excluded.exercise, equipment = excluded.equipment, sets = excluded.sets,
      reps = excluded.reps, weight = excluded.weight, weight_unit = excluded.weight_unit
    where (workout_sets.exercise, workout_sets.equipment, workout_sets.sets, workout_sets.reps,
           workout_sets.weight, workout_sets.weight_unit)
      is distinct from (excluded.exercise, excluded.equipment, excluded.sets, excluded.reps,
                        excluded.weight, excluded.weight_unit);
  end loop;
exception when not_null_violation or check_violation or invalid_text_representation then
  raise exception 'Each exercise row needs a name, sets (1–50), reps (1–1000) and a weight of 0–2000';
end $$;

create function public.save_workout(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c public.competitions := app_private.require_member();
  v_uid uuid := auth.uid(); v_clock timestamptz := app_private.clock();
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_ck uuid := nullif(p ->> 'client_key', '')::uuid;
  v_status text := coalesce(p ->> 'status', 'completed');
  v_act timestamptz := (p ->> 'activity_at')::timestamptz;
  w public.workouts; v_event text;
begin
  if v_status not in ('draft', 'completed') then raise exception 'Invalid workout status'; end if;
  if v_act is null then raise exception 'Date and time are required'; end if;
  if v_status = 'completed' and p ? 'sets' and jsonb_array_length(p -> 'sets') = 0 then
    raise exception 'Add at least one exercise before completing the workout';
  end if;

  if v_id is null then
    if v_ck is null then raise exception 'client_key is required'; end if;
    select id into v_id from public.workouts where user_id = v_uid and client_key = v_ck;
  end if;

  if v_id is null then
    if v_status = 'completed' then
      perform app_private.assert_not_future(v_act);
      if not (p ? 'sets') then raise exception 'Add at least one exercise before completing the workout'; end if;
    end if;
    insert into public.workouts (competition_id, user_id, client_key, title, notes, status, activity_at,
                                 original_activity_at, submitted_at, created_at, updated_at)
    values (c.id, v_uid, v_ck, btrim(coalesce(p ->> 'title', '')), coalesce(p ->> 'notes', ''), v_status, v_act,
            case when v_status = 'completed' then v_act end,
            case when v_status = 'completed' then v_clock end, v_clock, v_clock)
    on conflict (user_id, client_key) do nothing
    returning id into v_id;
    if v_id is null then   -- a simultaneous duplicate request already created it
      return (select id from public.workouts where user_id = v_uid and client_key = v_ck);
    end if;
    v_event := case when v_status = 'completed' then 'completed' end;
  else
    select * into w from public.workouts where id = v_id for update;
    if not found or w.user_id <> v_uid then
      raise exception 'You can only edit your own logs' using errcode = '42501';
    end if;
    if w.status = 'completed' then
      if v_status = 'draft' then raise exception 'A completed workout cannot go back to draft. Delete it instead.'; end if;
      perform app_private.check_time_edit(w.original_activity_at, w.activity_at, v_act);
      update public.workouts set title = btrim(coalesce(p ->> 'title', title)), notes = coalesce(p ->> 'notes', notes),
        activity_at = v_act, updated_at = v_clock where id = v_id;
      v_event := case when v_clock > w.original_activity_at + interval '48 hours' then 'corrected' else 'edited' end;
    else
      if v_status = 'completed' then perform app_private.assert_not_future(v_act); end if;
      update public.workouts set title = btrim(coalesce(p ->> 'title', title)), notes = coalesce(p ->> 'notes', notes),
        activity_at = v_act, status = v_status,
        original_activity_at = case when v_status = 'completed' then v_act end,
        submitted_at = case when v_status = 'completed' then v_clock end,
        updated_at = v_clock where id = v_id;
      v_event := case when v_status = 'completed' then 'completed' end;
    end if;
  end if;

  if p ? 'sets' then perform app_private.write_sets(v_id, p -> 'sets'); end if;

  if v_status = 'completed' then
    if not exists (select 1 from public.workout_sets where workout_id = v_id) then
      raise exception 'Add at least one exercise before completing the workout';
    end if;
    perform app_private.recompute(c.id, 'workout ' || coalesce(v_event, 'saved'), v_uid);
    if v_event is not null then
      perform app_private.feed(c.id, 'workout_' || v_event, 'workout', v_id,
        v_event || ' a workout' || coalesce(nullif(': ' || btrim(coalesce(p ->> 'title', '')), ': '), ''));
    end if;
  end if;
  return v_id;
end $$;

create function public.copy_workout_as_draft(p_source uuid, p_client_key uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member(); v_id uuid; src public.workouts;
begin
  if p_client_key is null then raise exception 'client_key is required'; end if;
  select id into v_id from public.workouts where user_id = auth.uid() and client_key = p_client_key;
  if found then return v_id; end if;
  select * into src from public.workouts where id = p_source and user_id = auth.uid();
  if not found then raise exception 'You can only copy your own workouts'; end if;
  insert into public.workouts (competition_id, user_id, client_key, title, notes, status, copied_from, activity_at)
  values (c.id, auth.uid(), p_client_key, src.title, '', 'draft', src.id, app_private.clock())
  returning id into v_id;
  insert into public.workout_sets (workout_id, position, exercise, equipment, sets, reps, weight, weight_unit)
  select v_id, position, exercise, equipment, sets, reps, weight, weight_unit
  from public.workout_sets where workout_id = src.id;
  return v_id;
end $$;

create function public.delete_workout(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member(); w public.workouts;
begin
  select * into w from public.workouts where id = p_id and user_id = auth.uid() for update;
  if not found then return; end if;     -- idempotent
  delete from public.workouts where id = p_id;
  if w.status = 'completed' then
    perform app_private.recompute(c.id, 'workout deleted', auth.uid());
    perform app_private.feed(c.id, 'workout_deleted', 'workout', null, 'deleted a workout' ||
      coalesce(nullif(': ' || w.title, ': '), ''));
  end if;
end $$;

create function public.save_template(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid; v_items jsonb := coalesce(p -> 'items', '[]'::jsonb);
begin
  perform app_private.require_member();
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) > 40 then
    raise exception 'A template can have up to 40 exercises';
  end if;
  if exists (select 1 from jsonb_array_elements(v_items) i
             where char_length(btrim(coalesce(i ->> 'exercise', ''))) not between 1 and 60) then
    raise exception 'Every template row needs an exercise name';
  end if;
  if v_id is null then
    insert into public.workout_templates (user_id, name, items) values (auth.uid(), btrim(p ->> 'name'), v_items)
    returning id into v_id;
  else
    update public.workout_templates set name = btrim(p ->> 'name'), items = v_items, updated_at = app_private.clock()
    where id = v_id and user_id = auth.uid();
    if not found then raise exception 'Template not found'; end if;
  end if;
  return v_id;
end $$;

create function public.delete_template(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.workout_templates where id = p_id and user_id = auth.uid()
$$;

-- =====================================================================
-- CARDIO
-- p: {id?, client_key, activity, duration_s, distance?, distance_unit?, steps?, notes, activity_at}
-- =====================================================================
create function public.save_cardio(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c public.competitions := app_private.require_member();
  v_uid uuid := auth.uid(); v_clock timestamptz := app_private.clock();
  v_id uuid := nullif(p ->> 'id', '')::uuid; v_ck uuid := nullif(p ->> 'client_key', '')::uuid;
  v_act timestamptz := (p ->> 'activity_at')::timestamptz; cl public.cardio_logs; v_event text;
begin
  if v_id is null then
    if v_ck is null then raise exception 'client_key is required'; end if;
    select id into v_id from public.cardio_logs where user_id = v_uid and client_key = v_ck;
  end if;
  begin
    if v_id is null then
      perform app_private.assert_not_future(v_act);
      insert into public.cardio_logs (competition_id, user_id, client_key, activity, duration_s, distance, distance_unit,
                                      steps, notes, activity_at, original_activity_at, submitted_at, created_at, updated_at)
      values (c.id, v_uid, v_ck, btrim(p ->> 'activity'), (p ->> 'duration_s')::int,
              nullif(p ->> 'distance', '')::numeric, nullif(p ->> 'distance_unit', ''),
              nullif(p ->> 'steps', '')::int, coalesce(p ->> 'notes', ''), v_act, v_act, v_clock, v_clock, v_clock)
      on conflict (user_id, client_key) do nothing
      returning id into v_id;
      if v_id is null then
        return (select id from public.cardio_logs where user_id = v_uid and client_key = v_ck);
      end if;
      v_event := 'logged';
    else
      select * into cl from public.cardio_logs where id = v_id for update;
      if not found or cl.user_id <> v_uid then
        raise exception 'You can only edit your own logs' using errcode = '42501';
      end if;
      perform app_private.check_time_edit(cl.original_activity_at, cl.activity_at, v_act);
      update public.cardio_logs set activity = btrim(p ->> 'activity'), duration_s = (p ->> 'duration_s')::int,
        distance = nullif(p ->> 'distance', '')::numeric, distance_unit = nullif(p ->> 'distance_unit', ''),
        steps = nullif(p ->> 'steps', '')::int, notes = coalesce(p ->> 'notes', ''), activity_at = v_act,
        updated_at = v_clock
      where id = v_id;
      v_event := case when v_clock > cl.original_activity_at + interval '48 hours' then 'corrected' else 'edited' end;
    end if;
  exception when not_null_violation or check_violation or invalid_text_representation then
    raise exception 'Cardio needs an activity, a duration of up to 24 hours, and (optionally) a distance with its unit';
  end;
  perform app_private.recompute(c.id, 'cardio ' || v_event, v_uid);
  perform app_private.feed(c.id, 'cardio_' || v_event, 'cardio', v_id,
    v_event || ' cardio: ' || btrim(p ->> 'activity') || ' · ' || round((p ->> 'duration_s')::numeric / 60) || ' min');
  return v_id;
end $$;

create function public.delete_cardio(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member();
begin
  delete from public.cardio_logs where id = p_id and user_id = auth.uid();
  if found then
    perform app_private.recompute(c.id, 'cardio deleted', auth.uid());
    perform app_private.feed(c.id, 'cardio_deleted', 'cardio', null, 'deleted a cardio session');
  end if;
end $$;

-- =====================================================================
-- MEALS
-- p: {id?, client_key, description, photo_path, checklist:{key:bool}, activity_at}
-- Upload the photo to media/<your id>/meals/<uuid>.<ext> first.
-- Returns {id, removed_photo_path} — delete removed_photo_path from storage.
-- =====================================================================
create function public.save_meal(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c public.competitions := app_private.require_member();
  v_uid uuid := auth.uid(); v_clock timestamptz := app_private.clock();
  v_id uuid := nullif(p ->> 'id', '')::uuid; v_ck uuid := nullif(p ->> 'client_key', '')::uuid;
  v_act timestamptz := (p ->> 'activity_at')::timestamptz; v_etag text; v_check jsonb := '{}'::jsonb;
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
    insert into public.meal_logs (competition_id, user_id, client_key, description, photo_path, photo_etag, checklist,
                                  activity_at, original_activity_at, submitted_at, created_at, updated_at)
    values (c.id, v_uid, v_ck, btrim(coalesce(p ->> 'description', '')), p ->> 'photo_path', v_etag, v_check,
            v_act, v_act, v_clock, v_clock, v_clock)
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
      activity_at = v_act, updated_at = v_clock
    where id = v_id;
    v_event := case when v_clock > ml.original_activity_at + interval '48 hours' then 'corrected' else 'edited' end;
  end if;

  perform app_private.recompute(c.id, 'meal ' || v_event, v_uid);
  perform app_private.feed(c.id, 'meal_' || v_event, 'meal', v_id, v_event || ' a meal' ||
    coalesce(nullif(': ' || btrim(coalesce(p ->> 'description', '')), ': '), ''));
  return jsonb_build_object('id', v_id, 'removed_photo_path', v_removed);
end $$;

create function public.delete_meal(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member(); v_path text;
begin
  delete from public.meal_logs where id = p_id and user_id = auth.uid() returning photo_path into v_path;
  if v_path is not null then
    perform app_private.recompute(c.id, 'meal deleted', auth.uid());
    perform app_private.feed(c.id, 'meal_deleted', 'meal', null, 'deleted a meal');
  end if;
  return v_path;   -- client removes this file from storage
end $$;

-- =====================================================================
-- HYDRATION (one daily total per person per local day)
-- =====================================================================
create function public.save_hydration(p_day date, p_amount numeric, p_unit text) returns uuid
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member(); v_clock timestamptz := app_private.clock();
        v_id uuid; v_event text;
begin
  if p_day is null or p_day > app_private.local_day(v_clock, c.timezone) then
    raise exception 'You can only log water for today or earlier';
  end if;
  begin
    insert into public.hydration_logs (competition_id, user_id, day, amount, unit, original_activity_at,
                                       submitted_at, created_at, updated_at)
    values (c.id, auth.uid(), p_day, p_amount, p_unit, app_private.local_midnight(p_day + 1, c.timezone),
            v_clock, v_clock, v_clock)
    on conflict (user_id, day) do update set amount = excluded.amount, unit = excluded.unit, updated_at = v_clock
    returning id, case when xmax = 0 then 'logged' else 'updated' end into v_id, v_event;
  exception when not_null_violation or check_violation then
    raise exception 'Enter a water total of 0–340 oz (0–10,000 ml)';
  end;
  perform app_private.recompute(c.id, 'water ' || v_event, auth.uid());
  perform app_private.feed(c.id, 'water_' || v_event, 'hydration', v_id,
    v_event || ' water for ' || to_char(p_day, 'Dy Mon DD') || ': ' || trim_scale(p_amount) || ' ' || p_unit);
  return v_id;
end $$;

create function public.delete_hydration(p_day date) returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member();
begin
  delete from public.hydration_logs where user_id = auth.uid() and day = p_day;
  if found then perform app_private.recompute(c.id, 'water deleted', auth.uid()); end if;
end $$;

-- =====================================================================
-- PRIVATE BODY RECORDS (no points; per-record sharing)
-- p: {id?, client_key, recorded_on, weight?, weight_unit?,
--     measurements: {"waist": {"value": 34, "unit": "in"}}, photo_path?, notes}
-- =====================================================================
create function public.save_body_record(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c public.competitions := app_private.require_member(); v_uid uuid := auth.uid();
  v_id uuid := nullif(p ->> 'id', '')::uuid; v_ck uuid := nullif(p ->> 'client_key', '')::uuid;
  v_day date := (p ->> 'recorded_on')::date; v_photo text := nullif(p ->> 'photo_path', '');
  v_meas jsonb := '{}'::jsonb; kv record; br public.body_records; v_removed text;
begin
  if v_day is null or v_day > app_private.local_day(app_private.clock(), c.timezone) then
    raise exception 'Choose today or an earlier date';
  end if;
  for kv in select * from jsonb_each(coalesce(p -> 'measurements', '{}'::jsonb)) loop
    if char_length(kv.key) not between 1 and 30
       or (kv.value ->> 'value')::numeric is null or (kv.value ->> 'value')::numeric not between 0 and 1000
       or coalesce(kv.value ->> 'unit', '') not in ('in', 'cm') then
      raise exception 'Each measurement needs a name, a value and a unit (in or cm)';
    end if;
    v_meas := v_meas || jsonb_build_object(kv.key, jsonb_build_object(
      'value', (kv.value ->> 'value')::numeric, 'unit', kv.value ->> 'unit'));
  end loop;
  if (select count(*) from jsonb_object_keys(v_meas)) > 10 then raise exception 'Up to 10 measurements per record'; end if;
  if v_photo is not null then perform app_private.own_photo_etag(v_photo, 'body'); end if;

  if v_id is null then
    if v_ck is null then raise exception 'client_key is required'; end if;
    select id into v_id from public.body_records where user_id = v_uid and client_key = v_ck;
  end if;
  begin
    if v_id is null then
      insert into public.body_records (competition_id, user_id, client_key, recorded_on, weight, weight_unit,
                                       measurements, photo_path, notes)
      values (c.id, v_uid, v_ck, v_day, nullif(p ->> 'weight', '')::numeric, nullif(p ->> 'weight_unit', ''),
              v_meas, v_photo, coalesce(p ->> 'notes', ''))
      on conflict (user_id, client_key) do nothing
      returning id into v_id;
      if v_id is null then
        return jsonb_build_object('id', (select id from public.body_records where user_id = v_uid and client_key = v_ck),
                                  'removed_photo_path', null);
      end if;
    else
      select * into br from public.body_records where id = v_id for update;
      if not found or br.user_id <> v_uid then
        raise exception 'You can only edit your own records' using errcode = '42501';
      end if;
      if br.photo_path is not null and br.photo_path is distinct from v_photo then v_removed := br.photo_path; end if;
      update public.body_records set recorded_on = v_day, weight = nullif(p ->> 'weight', '')::numeric,
        weight_unit = nullif(p ->> 'weight_unit', ''), measurements = v_meas, photo_path = v_photo,
        notes = coalesce(p ->> 'notes', ''), updated_at = app_private.clock()
      where id = v_id;
    end if;
  exception when check_violation or invalid_text_representation then
    raise exception 'Check the weight (with its unit) and notes';
  end;
  return jsonb_build_object('id', v_id, 'removed_photo_path', v_removed);
end $$;

create function public.set_body_record_shared(p_id uuid, p_shared boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app_private.require_member();
  update public.body_records set shared = p_shared,
    shared_at = case when p_shared then app_private.clock() end, updated_at = app_private.clock()
  where id = p_id and user_id = auth.uid();
  if not found then raise exception 'Record not found'; end if;
end $$;

create function public.delete_body_record(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_path text;
begin
  perform app_private.require_member();
  delete from public.body_records where id = p_id and user_id = auth.uid() returning photo_path into v_path;
  return v_path;
end $$;

-- =====================================================================
-- SCORES, EXPORT, DELETION
-- =====================================================================
-- Call when opening the Today / Competition screens: recomputes and flips
-- weeks from provisional to final as time passes.
create function public.refresh_scores() returns void
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member();
begin
  perform app_private.recompute(c.id, 'refresh', auth.uid());
end $$;

create function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  perform app_private.require_member();
  return jsonb_build_object(
    'exported_at', app_private.clock(),
    'profile', (select to_jsonb(p) from public.profiles p where user_id = v_uid),
    'targets', (select coalesce(jsonb_agg(to_jsonb(t) order by effective_week), '[]') from public.target_versions t where user_id = v_uid),
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

-- Deletes all of the caller's logs, templates and body records. Returns the
-- photo paths the app must then remove from storage. Scores recalculate
-- (points earned from deleted logs are removed).
create function public.delete_my_data() returns text[]
language plpgsql security definer set search_path = public as $$
declare c public.competitions := app_private.require_member(); v_uid uuid := auth.uid(); v_paths text[];
begin
  select coalesce(array_agg(path), '{}') into v_paths from (
    select photo_path as path from public.meal_logs where user_id = v_uid
    union select photo_path from public.body_records where user_id = v_uid and photo_path is not null) x;
  delete from public.workouts where user_id = v_uid;
  delete from public.cardio_logs where user_id = v_uid;
  delete from public.meal_logs where user_id = v_uid;
  delete from public.hydration_logs where user_id = v_uid;
  delete from public.body_records where user_id = v_uid;
  delete from public.workout_templates where user_id = v_uid;
  update public.change_proposals set status = 'withdrawn', decided_at = app_private.clock()
  where proposed_by = v_uid and status = 'pending';
  perform app_private.recompute(c.id, 'member deleted their logs', v_uid);
  perform app_private.feed(c.id, 'data_deleted', null, null, 'deleted all of their logs');
  return v_paths;
end $$;

-- Account removal (called by the delete-account Edge Function with the
-- service role). Keeps an anonymous copy of weekly totals so the other
-- person's history still adds up, then removes all personal data. The Edge
-- Function deletes the storage files and the auth user afterwards.
create function app_private.prepare_account_removal(p_user uuid) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_comp uuid; v_paths text[]; v_email text;
begin
  select competition_id into v_comp from public.memberships where user_id = p_user;
  select coalesce(array_agg(path), '{}') into v_paths from (
    select photo_path as path from public.meal_logs where user_id = p_user
    union select photo_path from public.body_records where user_id = p_user and photo_path is not null) x;
  if v_comp is not null then
    insert into public.former_member_scores (competition_id, week_start, total)
    select competition_id, week_start, total from public.weekly_scores where user_id = p_user;
    select lower(email) into v_email from auth.users where id = p_user;
    delete from app_private.invites where competition_id = v_comp and email = v_email;
  end if;
  delete from public.activity_feed where actor_id = p_user;
  delete from public.score_audit where user_id = p_user;
  delete from public.weekly_scores where user_id = p_user;
  delete from public.record_credits where user_id = p_user;
  delete from public.workouts where user_id = p_user;
  delete from public.cardio_logs where user_id = p_user;
  delete from public.meal_logs where user_id = p_user;
  delete from public.hydration_logs where user_id = p_user;
  delete from public.body_records where user_id = p_user;
  delete from public.workout_templates where user_id = p_user;
  delete from public.proposal_approvals where user_id = p_user;
  delete from public.change_proposals where proposed_by = p_user or subject_user_id = p_user;
  delete from public.benchmarks where user_id = p_user;
  delete from public.target_versions where user_id = p_user;
  delete from public.profiles where user_id = p_user;
  delete from public.memberships where user_id = p_user;
  return v_paths;
end $$;

create function public.service_prepare_account_removal(p_user uuid) returns text[]
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return app_private.prepare_account_removal(p_user);
end $$;
