-- =====================================================================
-- Gym Progress Duo — 2/4 membership helpers + authoritative scoring
-- =====================================================================

-- ---------------------------------------------------------------------
-- Membership helpers (SECURITY DEFINER so RLS policies can use them
-- without recursing into the memberships policy).
-- ---------------------------------------------------------------------
create function app_private.my_competition() returns uuid
language sql stable security definer set search_path = public as $$
  select competition_id from public.memberships where user_id = auth.uid()
$$;

create function app_private.is_member_of(p_comp uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships
                 where user_id = auth.uid() and competition_id = p_comp)
$$;

create function app_private.shares_competition(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships me
    join public.memberships them on them.competition_id = me.competition_id
    where me.user_id = auth.uid() and them.user_id = p_user)
$$;

create function app_private.require_member() returns public.competitions
language plpgsql stable security definer set search_path = public as $$
declare c public.competitions;
begin
  if auth.uid() is null then
    raise exception 'Sign in required' using errcode = '42501';
  end if;
  select comp.* into c from public.competitions comp
  join public.memberships m on m.competition_id = comp.id
  where m.user_id = auth.uid();
  if not found then
    raise exception 'This account is not a member of a competition' using errcode = '42501';
  end if;
  return c;
end $$;

create function app_private.require_active() returns public.competitions
language plpgsql stable security definer set search_path = public as $$
declare c public.competitions := app_private.require_member();
begin
  if c.status <> 'active' then
    raise exception 'The competition has not started yet: both of you need to agree to the setup first'
      using errcode = 'P0001';
  end if;
  return c;
end $$;

-- Effective settings for a week (latest version at or before it).
create function app_private.target_for(p_user uuid, p_week date) returns public.target_versions
language sql stable security definer set search_path = public as $$
  select * from public.target_versions
  where user_id = p_user and effective_week <= p_week
  order by effective_week desc limit 1
$$;

create function app_private.rules_for(p_comp uuid, p_week date) returns public.rule_versions
language sql stable security definer set search_path = public as $$
  select * from public.rule_versions
  where competition_id = p_comp and effective_week <= p_week
  order by effective_week desc limit 1
$$;

-- Common eligibility: submitted within 48h of the ORIGINAL stated time,
-- on/after the competition start, and not in the future.
create function app_private.base_ok(
  p_activity timestamptz, p_original timestamptz, p_submitted timestamptz,
  p_start timestamptz, p_clock timestamptz) returns boolean
language sql immutable as $$
  select p_submitted is not null
     and p_submitted <= p_original + interval '48 hours'
     and p_activity >= p_start
     and p_activity <= p_clock
$$;

create function app_private.checklist_ok(p_checklist jsonb, p_rules jsonb) returns boolean
language sql immutable as $$
  select coalesce(bool_and(coalesce((p_checklist ->> (item ->> 'key'))::boolean, false)), false)
  from jsonb_array_elements(coalesce(p_rules -> 'meal_checklist', '[]'::jsonb)) item
$$;

-- ---------------------------------------------------------------------
-- recompute(): deterministic, idempotent, serialized per competition.
--   1. Compute what every record qualifies for from current data.
--   2. Merge into record_credits: inside a record's 48h window the credit
--      follows the data; after the window it can only be removed.
--   3. Rebuild weekly_scores from credits + that week's target/rule
--      snapshot, and write an audit row for every change.
-- Safe to call any number of times; concurrent callers queue on a lock.
-- ---------------------------------------------------------------------
create function app_private.recompute(p_comp uuid, p_reason text, p_actor uuid)
returns void
language plpgsql security definer set search_path = public, app_private as $$
declare
  v_clock timestamptz := app_private.clock();
  c public.competitions;
  v_start timestamptz;
  v_week date;
  v_last_week date;
  u record;
  t public.target_versions;
  r public.rule_versions;
  v_sd int; v_md int; v_cd int; v_hd int; v_sb boolean; v_cb boolean;
  v_sp numeric; v_mp numeric; v_cp numeric; v_hp numeric; v_sbp numeric; v_cbp numeric; v_total numeric;
  v_old public.weekly_scores;
  v_new_detail jsonb;
  v_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended('recompute:' || p_comp::text, 0));

  select * into c from public.competitions where id = p_comp;
  if not found or c.status <> 'active' then return; end if;
  v_start := app_private.local_midnight(c.start_date, c.timezone);

  create temp table if not exists _computed (
    user_id uuid, record_type text, record_id uuid, component text,
    week_start date, day date, computed boolean, window_closes_at timestamptz
  ) on commit drop;
  truncate _computed;

  -- Strength days: completed workout with at least one exercise row.
  insert into _computed
  select w.user_id, 'workout', w.id, 'strength_day',
         app_private.week_of(w.activity_at, c.timezone), app_private.local_day(w.activity_at, c.timezone),
         app_private.base_ok(w.activity_at, w.original_activity_at, w.submitted_at, v_start, v_clock)
           and exists (select 1 from public.workout_sets s where s.workout_id = w.id),
         w.original_activity_at + interval '48 hours'
  from public.workouts w
  where w.competition_id = p_comp and w.status = 'completed';

  -- Cardio days: session at least as long as that person's agreed minimum
  -- for that week.
  insert into _computed
  select cl.user_id, 'cardio', cl.id, 'cardio_day',
         app_private.week_of(cl.activity_at, c.timezone), app_private.local_day(cl.activity_at, c.timezone),
         app_private.base_ok(cl.activity_at, cl.original_activity_at, cl.submitted_at, v_start, v_clock)
           and tv.id is not null and cl.duration_s >= tv.cardio_min_minutes * 60,
         cl.original_activity_at + interval '48 hours'
  from public.cardio_logs cl
  left join lateral app_private.target_for(cl.user_id, app_private.week_of(cl.activity_at, c.timezone)) tv on true
  where cl.competition_id = p_comp;

  -- Meal days: photo present, every agreed checklist item confirmed, and the
  -- same photo bytes (storage eTag) can earn only once across the competition
  -- (earliest submission keeps it).
  insert into _computed
  with m as (
    select ml.*, app_private.week_of(ml.activity_at, c.timezone) as wk
    from public.meal_logs ml where ml.competition_id = p_comp
  ), q as (
    select m.*,
           app_private.base_ok(m.activity_at, m.original_activity_at, m.submitted_at, v_start, v_clock)
             and m.photo_etag is not null
             and rv.id is not null
             and app_private.checklist_ok(m.checklist, rv.rules) as ok
    from m left join lateral app_private.rules_for(p_comp, m.wk) rv on true
  ), ranked as (
    select q.*, case when q.ok then
             row_number() over (partition by q.photo_etag, q.ok order by q.submitted_at, q.seq) end as rn
    from q
  )
  select user_id, 'meal', id, 'meal_day', wk, app_private.local_day(activity_at, c.timezone),
         ok and rn = 1, original_activity_at + interval '48 hours'
  from ranked;

  -- Hydration days: meet the personal target (more earns nothing extra).
  insert into _computed
  select h.user_id, 'hydration', h.id, 'hydration_day',
         date_trunc('week', h.day)::date, h.day,
         h.submitted_at <= h.original_activity_at + interval '48 hours'
           and h.day >= c.start_date
           and h.day <= app_private.local_day(v_clock, c.timezone)
           and tv.id is not null and h.amount_ml >= tv.hydration_target_ml,
         h.original_activity_at + interval '48 hours'
  from public.hydration_logs h
  left join lateral app_private.target_for(h.user_id, date_trunc('week', h.day)::date) tv on true
  where h.competition_id = p_comp;

  -- Strength improvement: a set whose exercise + equipment + reps exactly
  -- match an active benchmark, with strictly more load (kg) than the best
  -- earlier eligible result for that benchmark. No bonus in the
  -- benchmark's baseline week. Earlier = strictly earlier activity time.
  insert into _computed
  with res as (
    select s.id as set_id, w.user_id, w.activity_at, w.original_activity_at, s.weight_kg as val,
           b.id as bid, b.effective_week as b_week,
           app_private.week_of(w.activity_at, c.timezone) as wk
    from public.workout_sets s
    join public.workouts w on w.id = s.workout_id
    join public.benchmarks b on b.user_id = w.user_id and b.kind = 'strength'
      and b.exercise_key = s.exercise_key and b.equipment_key = s.equipment_key and b.reps = s.reps
    where w.competition_id = p_comp and w.status = 'completed'
      and app_private.base_ok(w.activity_at, w.original_activity_at, w.submitted_at, v_start, v_clock)
      and b.effective_week <= app_private.week_of(w.activity_at, c.timezone)
      and (b.retired_week is null or b.retired_week > app_private.week_of(w.activity_at, c.timezone))
  ), scored as (
    select res.*,
           (select max(r2.val) from res r2 where r2.bid = res.bid and r2.activity_at < res.activity_at) as prior_best
    from res
  )
  select user_id, 'workout_set', set_id, 'strength_bonus', wk,
         app_private.local_day(activity_at, c.timezone),
         bool_or(wk > b_week and prior_best is not null and val > prior_best),
         min(original_activity_at) + interval '48 hours'
  from scored
  group by user_id, set_id, wk, activity_at;

  -- Cardio improvement: same activity + protocol. Time-for-distance needs the
  -- logged distance within 0.5% of the fixed distance (shorter time wins);
  -- distance-in-time needs the duration within 1 second (longer distance wins).
  insert into _computed
  with res as (
    select cl.id as cid, cl.user_id, cl.activity_at, cl.original_activity_at,
           case b.protocol when 'time_for_distance' then -cl.duration_s::numeric else cl.distance_m end as val,
           b.id as bid, b.effective_week as b_week,
           app_private.week_of(cl.activity_at, c.timezone) as wk
    from public.cardio_logs cl
    join public.benchmarks b on b.user_id = cl.user_id and b.kind = 'cardio' and b.activity_key = cl.activity_key
    where cl.competition_id = p_comp
      and app_private.base_ok(cl.activity_at, cl.original_activity_at, cl.submitted_at, v_start, v_clock)
      and b.effective_week <= app_private.week_of(cl.activity_at, c.timezone)
      and (b.retired_week is null or b.retired_week > app_private.week_of(cl.activity_at, c.timezone))
      and (
        (b.protocol = 'time_for_distance' and cl.distance_m is not null
           and abs(cl.distance_m - b.fixed_distance_m) <= b.fixed_distance_m * 0.005)
        or
        (b.protocol = 'distance_in_time' and cl.distance_m is not null
           and abs(cl.duration_s - b.fixed_duration_s) <= 1)
      )
  ), scored as (
    select res.*,
           (select max(r2.val) from res r2 where r2.bid = res.bid and r2.activity_at < res.activity_at) as prior_best
    from res
  )
  select user_id, 'cardio', cid, 'cardio_bonus', wk,
         app_private.local_day(activity_at, c.timezone),
         bool_or(wk > b_week and prior_best is not null and val > prior_best),
         min(original_activity_at) + interval '48 hours'
  from scored
  group by user_id, cid, wk, activity_at;

  -- Merge. Records that no longer exist or no longer match lose their credit.
  delete from public.record_credits rc
  where rc.competition_id = p_comp
    and not exists (select 1 from _computed x
                    where x.record_type = rc.record_type and x.record_id = rc.record_id
                      and x.component = rc.component);

  insert into public.record_credits as rc
    (competition_id, user_id, record_type, record_id, component, week_start, day,
     computed, qualifies, window_closes_at, updated_at)
  select p_comp, x.user_id, x.record_type, x.record_id, x.component, x.week_start, x.day,
         x.computed,
         -- a credit first seen after its window closed can never be awarded
         case when v_clock <= x.window_closes_at then x.computed else false end,
         x.window_closes_at, v_clock
  from _computed x
  on conflict (record_type, record_id, component) do update set
    computed = excluded.computed,
    qualifies = case when v_clock <= excluded.window_closes_at then excluded.computed
                     else rc.qualifies and excluded.computed end,
    week_start = excluded.week_start,
    day = excluded.day,
    window_closes_at = excluded.window_closes_at,
    updated_at = v_clock
  where rc.computed is distinct from excluded.computed
     or rc.qualifies is distinct from (case when v_clock <= excluded.window_closes_at then excluded.computed
                                            else rc.qualifies and excluded.computed end)
     or rc.week_start is distinct from excluded.week_start
     or rc.day is distinct from excluded.day;

  -- Weekly scores, every member, every week from the start to now.
  v_last_week := app_private.week_of(v_clock, c.timezone);
  for u in select m.user_id from public.memberships m where m.competition_id = p_comp loop
    v_week := c.start_date;
    while v_week <= v_last_week loop
      t := app_private.target_for(u.user_id, v_week);
      r := app_private.rules_for(p_comp, v_week);

      select
        count(distinct day) filter (where component = 'strength_day'),
        count(distinct day) filter (where component = 'meal_day'),
        count(distinct day) filter (where component = 'cardio_day'),
        count(distinct day) filter (where component = 'hydration_day'),
        coalesce(bool_or(true) filter (where component = 'strength_bonus'), false),
        coalesce(bool_or(true) filter (where component = 'cardio_bonus'), false)
      into v_sd, v_md, v_cd, v_hd, v_sb, v_cb
      from public.record_credits
      where user_id = u.user_id and competition_id = p_comp
        and week_start = v_week and qualifies;

      if t.id is null or r.id is null then
        v_sp := 0; v_mp := 0; v_cp := 0; v_hp := 0; v_sbp := 0; v_cbp := 0;
      else
        v_sp  := 40 * least(v_sd::numeric / t.strength_days_target, 1);
        v_mp  := 25 * least(v_md::numeric / (r.rules ->> 'meal_days_required')::int, 1);
        v_cp  := 15 * least(v_cd::numeric / t.cardio_days_target, 1);
        v_hp  := least(10 * v_hd::numeric / 7, 10);
        v_sbp := case when v_sb then 5 else 0 end;
        v_cbp := case when v_cb then 5 else 0 end;
      end if;
      v_total := v_sp + v_mp + v_cp + v_hp + v_sbp + v_cbp;

      v_status := case when v_clock >= app_private.local_midnight(v_week + 7, c.timezone) + interval '48 hours'
                       then 'final' else 'provisional' end;

      v_new_detail := jsonb_build_object(
        'strength_days', v_sd, 'meal_days', v_md, 'cardio_days', v_cd, 'hydration_days', v_hd,
        'strength_points', v_sp, 'meal_points', v_mp, 'cardio_points', v_cp,
        'hydration_points', v_hp, 'strength_bonus', v_sbp, 'cardio_bonus', v_cbp);

      select * into v_old from public.weekly_scores where user_id = u.user_id and week_start = v_week;

      if v_old.user_id is null or v_old.total <> v_total
         or v_old.strength_days <> v_sd or v_old.meal_days <> v_md
         or v_old.cardio_days <> v_cd or v_old.hydration_days <> v_hd
         or v_old.strength_bonus <> v_sbp or v_old.cardio_bonus <> v_cbp then
        if v_old.user_id is not null or v_total <> 0 then
          insert into public.score_audit
            (competition_id, user_id, week_start, old_total, new_total, old_detail, new_detail, reason, actor_id)
          values (p_comp, u.user_id, v_week, v_old.total, v_total,
                  case when v_old.user_id is null then null else jsonb_build_object(
                    'strength_days', v_old.strength_days, 'meal_days', v_old.meal_days,
                    'cardio_days', v_old.cardio_days, 'hydration_days', v_old.hydration_days,
                    'strength_points', v_old.strength_points, 'meal_points', v_old.meal_points,
                    'cardio_points', v_old.cardio_points, 'hydration_points', v_old.hydration_points,
                    'strength_bonus', v_old.strength_bonus, 'cardio_bonus', v_old.cardio_bonus) end,
                  v_new_detail, p_reason, p_actor);
        end if;
      end if;

      insert into public.weekly_scores as ws
        (competition_id, user_id, week_start, strength_days, meal_days, cardio_days, hydration_days,
         strength_points, meal_points, cardio_points, hydration_points, strength_bonus, cardio_bonus,
         total, targets, rules, status, computed_at)
      values (p_comp, u.user_id, v_week, v_sd, v_md, v_cd, v_hd, v_sp, v_mp, v_cp, v_hp, v_sbp, v_cbp,
              v_total,
              coalesce(to_jsonb(t) - 'competition_id' - 'user_id' - 'proposal_id' - 'created_at', '{}'::jsonb),
              coalesce(r.rules, '{}'::jsonb), v_status, v_clock)
      on conflict (user_id, week_start) do update set
        strength_days = excluded.strength_days, meal_days = excluded.meal_days,
        cardio_days = excluded.cardio_days, hydration_days = excluded.hydration_days,
        strength_points = excluded.strength_points, meal_points = excluded.meal_points,
        cardio_points = excluded.cardio_points, hydration_points = excluded.hydration_points,
        strength_bonus = excluded.strength_bonus, cardio_bonus = excluded.cardio_bonus,
        total = excluded.total, targets = excluded.targets, rules = excluded.rules,
        status = excluded.status, computed_at = excluded.computed_at;

      v_week := v_week + 7;
    end loop;
  end loop;
end $$;
