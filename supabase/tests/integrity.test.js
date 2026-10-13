import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setupDuo, workout, cardio, meal, water, weekScore, num, uuid, SERVICE } from './helpers.js';

let db, A, B;
beforeEach(async () => {
  db = await freshDb();
  ({ A, B } = await setupDuo(db));
  await db.setClock('2026-10-13T20:00:00-04:00');
});
afterEach(async () => db.close());

const count = async (t, who) => (await db.sql(`select count(*)::int as n from public.${t} where user_id = $1`, [who.id]))[0].n;

test('retrying the same save (same client_key) never creates a duplicate', async () => {
  const p = { client_key: uuid(), activity: 'Run', duration_s: 1800, activity_at: '2026-10-13T09:00:00-04:00' };
  const id1 = await db.rpc(A, 'save_cardio', p);
  const id2 = await db.rpc(A, 'save_cardio', p);
  assert.equal(id1, id2);
  assert.equal(await count('cardio_logs', A), 1);

  const w = { client_key: uuid(), title: 'Legs', activity_at: '2026-10-13T08:00:00-04:00', status: 'completed',
    sets: [{ exercise: 'Squat', equipment: 'Barbell', sets: 3, reps: 5, weight: 225, weight_unit: 'lb' }] };
  assert.equal(await db.rpc(A, 'save_workout', w), await db.rpc(A, 'save_workout', w));
  assert.equal(await count('workouts', A), 1);
  assert.equal((await db.sql('select count(*)::int as n from public.workout_sets'))[0].n, 1);
});

test('simultaneous double-taps from two connections create one record', async () => {
  const p = { client_key: uuid(), activity: 'Bike', duration_s: 2400, activity_at: '2026-10-13T09:00:00-04:00' };
  const ids = await Promise.all(Array.from({ length: 5 }, () => db.rpc(A, 'save_cardio', p)));
  assert.equal(new Set(ids).size, 1);
  assert.equal(await count('cardio_logs', A), 1);
  assert.equal((await weekScore(db, A)).cardio_days, 1);
});

test('simultaneous logging by both people scores everything exactly once', async () => {
  const results = await Promise.allSettled([
    workout(db, A, '2026-10-13T07:00:00-04:00'), workout(db, B, '2026-10-13T07:00:00-04:00'),
    cardio(db, A, '2026-10-13T08:00:00-04:00'), cardio(db, B, '2026-10-13T08:00:00-04:00'),
    water(db, A, '2026-10-13'), water(db, B, '2026-10-13'),
    workout(db, A, '2026-10-12T07:00:00-04:00'), workout(db, B, '2026-10-12T19:00:00-04:00'),
  ]);
  assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message), []);
  for (const who of [A, B]) {
    const s = await weekScore(db, who);
    assert.equal(s.strength_days, 2);
    assert.equal(s.cardio_days, 1);
    assert.equal(s.hydration_days, 1);
  }
  // recomputing again changes nothing (deterministic)
  const before = await db.sql('select user_id, week_start, total from public.weekly_scores order by 1, 2');
  await db.rpc(A, 'refresh_scores');
  await db.rpc(B, 'refresh_scores');
  assert.deepEqual(await db.sql('select user_id, week_start, total from public.weekly_scores order by 1, 2'), before);
});

test('water is one total per day: re-saving replaces it', async () => {
  await water(db, A, '2026-10-13', 1000);
  await water(db, A, '2026-10-13', 2500);
  const rows = await db.sql('select amount from public.hydration_logs where user_id = $1', [A.id]);
  assert.equal(rows.length, 1);
  assert.equal(num(rows[0].amount), 2500);
});

test('every score change is audited and visible to both; feed shows activity', async () => {
  const id = await workout(db, A, '2026-10-13T09:00:00-04:00');
  await db.rpc(A, 'delete_workout', id);
  const audit = await db.read(B, 'select reason, old_total, new_total from public.score_audit where user_id = $1 order by id', [A.id]);
  assert.deepEqual(audit.map((a) => a.reason), ['workout completed', 'workout deleted']);
  assert.equal(num(audit[1].new_total), 0);
  const feed = await db.read(B, 'select kind from public.activity_feed where actor_id = $1 order by id', [A.id]);
  assert.ok(feed.map((f) => f.kind).includes('workout_completed'));
  assert.ok(feed.map((f) => f.kind).includes('workout_deleted'));
});

test('export contains only my own data, including my private body records', async () => {
  await workout(db, A, '2026-10-13T09:00:00-04:00');
  await workout(db, B, '2026-10-13T09:00:00-04:00');
  await db.rpc(B, 'save_body_record', { client_key: uuid(), recorded_on: '2026-10-13', weight: 80, weight_unit: 'kg' });
  await db.rpc(A, 'save_body_record', { client_key: uuid(), recorded_on: '2026-10-13', weight: 182, weight_unit: 'lb' });
  const ex = await db.rpc(A, 'export_my_data');
  assert.equal(ex.workouts.length, 1);
  assert.equal(ex.workouts[0].user_id, A.id);
  assert.equal(ex.workouts[0].sets.length, 1);
  assert.equal(ex.body_records.length, 1);
  assert.equal(ex.body_records[0].user_id, A.id);
});

test('delete my data: removes my logs, returns my photo paths, scores recalculate', async () => {
  await workout(db, A, '2026-10-13T09:00:00-04:00');
  await meal(db, A, '2026-10-13T12:00:00-04:00');
  await workout(db, B, '2026-10-13T09:00:00-04:00');
  const paths = await db.rpc(A, 'delete_my_data');
  assert.equal(paths.length, 1);
  assert.ok(paths[0].startsWith(`${A.id}/meals/`));
  assert.equal(await count('workouts', A), 0);
  assert.equal(await count('meal_logs', A), 0);
  assert.equal(num((await weekScore(db, A)).total), 0);
  assert.ok(num((await weekScore(db, B)).total) > 0, 'friend untouched');
  // with the meal gone the file can be removed
  const del = await db.as(A, (c) => c.query('delete from storage.objects where name = $1', [paths[0]]));
  assert.equal(del.rowCount, 1);
});

test('account removal keeps anonymous weekly totals and removes everything personal', async () => {
  await workout(db, A, '2026-10-13T09:00:00-04:00');
  await meal(db, A, '2026-10-13T12:00:00-04:00');
  await db.rpc(A, 'save_body_record', { client_key: uuid(), recorded_on: '2026-10-13', weight: 182, weight_unit: 'lb' });
  const totalBefore = num((await weekScore(db, A)).total);

  await assert.rejects(db.rpc(A, 'service_prepare_account_removal', A.id), /permission denied/);
  const paths = await db.rpc(SERVICE, 'service_prepare_account_removal', A.id);
  assert.equal(paths.length, 1);

  for (const t of ['workouts', 'meal_logs', 'body_records', 'weekly_scores', 'memberships', 'profiles', 'target_versions']) {
    assert.equal(await count(t, A), 0, t);
  }
  const former = await db.read(B, 'select label, total from public.former_member_scores');
  assert.equal(former.length, 1);
  assert.equal(former[0].label, 'Former member');
  assert.equal(num(former[0].total), totalBefore);
  // the removed account can't rejoin with the old invite
  await assert.rejects(db.rpc(A, 'join_competition'), /not been invited/);
});
