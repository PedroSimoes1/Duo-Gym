-- =====================================================================
-- Gym Progress Duo — 4/4 security
--  * Row Level Security on every table; signed-out users get nothing.
--  * Signed-in non-members (a third account) see nothing.
--  * Members get SELECT only; all writes go through the API functions.
--  * Body records: owner only, unless that single record is shared.
--  * Photos live in a PRIVATE bucket; reads need a short-lived signed URL,
--    which Supabase only issues if the policies below allow the read.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tables: remove Supabase's default broad grants, then grant read only.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'competitions', 'memberships', 'profiles', 'rule_versions', 'target_versions', 'benchmarks',
    'change_proposals', 'proposal_approvals', 'workouts', 'workout_sets', 'workout_templates',
    'cardio_logs', 'meal_logs', 'hydration_logs', 'body_records', 'record_credits',
    'weekly_scores', 'former_member_scores', 'score_audit', 'activity_feed'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
revoke all on all sequences in schema public from anon, authenticated;

create policy member_read on public.competitions for select to authenticated
  using (app_private.is_member_of(id));
create policy member_read on public.memberships for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.profiles for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.rule_versions for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.target_versions for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.benchmarks for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.change_proposals for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.proposal_approvals for select to authenticated
  using (exists (select 1 from public.change_proposals p where p.id = proposal_id));

-- Drafts are private until completed.
create policy member_read on public.workouts for select to authenticated
  using (app_private.is_member_of(competition_id) and (status = 'completed' or user_id = auth.uid()));
create policy member_read on public.workout_sets for select to authenticated
  using (exists (select 1 from public.workouts w where w.id = workout_id));
create policy owner_read on public.workout_templates for select to authenticated
  using (user_id = auth.uid());

create policy member_read on public.cardio_logs for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.meal_logs for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.hydration_logs for select to authenticated
  using (app_private.is_member_of(competition_id));

create policy owner_or_shared_read on public.body_records for select to authenticated
  using (user_id = auth.uid() or (shared and app_private.is_member_of(competition_id)));

create policy member_read on public.record_credits for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.weekly_scores for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.former_member_scores for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.score_audit for select to authenticated
  using (app_private.is_member_of(competition_id));
create policy member_read on public.activity_feed for select to authenticated
  using (app_private.is_member_of(competition_id));

-- ---------------------------------------------------------------------
-- Private photo storage.  Path: <user id>/<meals|body>/<random>.<ext>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 10485760,
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create function app_private.can_read_media(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    split_part(p_name, '/', 1) = auth.uid()::text
    or (split_part(p_name, '/', 2) = 'meals' and exists (
          select 1 from public.meal_logs m
          where m.photo_path = p_name and app_private.shares_competition(m.user_id)))
    or (split_part(p_name, '/', 2) = 'body' and exists (
          select 1 from public.body_records b
          where b.photo_path = p_name and b.shared and app_private.shares_competition(b.user_id))))
$$;

-- A photo still attached to a log cannot be deleted or swapped underneath it
-- (keeps duplicate-photo detection honest). Delete the log first.
create function app_private.media_in_use(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.meal_logs where photo_path = p_name)
      or exists (select 1 from public.body_records where photo_path = p_name)
$$;

create policy media_insert_own on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] in ('meals', 'body')
    and array_length(storage.foldername(name), 1) = 2
    and app_private.my_competition() is not null);

create policy media_read on storage.objects for select to authenticated
  using (bucket_id = 'media' and app_private.can_read_media(name));

create policy media_delete_own_unused on storage.objects for delete to authenticated
  using (bucket_id = 'media'
         and (storage.foldername(name))[1] = auth.uid()::text
         and not app_private.media_in_use(name));
-- No UPDATE policy: uploaded photos cannot be overwritten.

-- ---------------------------------------------------------------------
-- Functions: nothing is callable unless granted below.
-- ---------------------------------------------------------------------
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app_private from public, anon, authenticated;
grant usage on schema app_private to authenticated;

-- Used inside RLS policies, so the signed-in role must be able to run them.
-- (The app_private schema is not exposed over the API.)
grant execute on function app_private.is_member_of(uuid),
                          app_private.shares_competition(uuid),
                          app_private.my_competition(),
                          app_private.can_read_media(text),
                          app_private.media_in_use(text)
  to authenticated;

grant execute on function
  public.join_competition(), public.get_my_context(), public.update_profile(jsonb),
  public.update_setup(date, jsonb), public.set_my_setup_targets(jsonb), public.set_my_setup_benchmarks(jsonb),
  public.agree_to_setup(),
  public.propose_change(text, jsonb), public.approve_proposal(uuid), public.reject_proposal(uuid),
  public.save_workout(jsonb), public.copy_workout_as_draft(uuid, uuid), public.delete_workout(uuid),
  public.save_template(jsonb), public.delete_template(uuid),
  public.save_cardio(jsonb), public.delete_cardio(uuid),
  public.save_meal(jsonb), public.delete_meal(uuid),
  public.save_hydration(date, numeric, text), public.delete_hydration(date),
  public.save_body_record(jsonb), public.set_body_record_shared(uuid, boolean), public.delete_body_record(uuid),
  public.refresh_scores(), public.export_my_data(), public.delete_my_data()
  to authenticated;

grant execute on function public.service_prepare_account_removal(uuid) to service_role;
