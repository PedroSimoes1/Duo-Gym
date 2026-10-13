import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setupDuo, workout, cardio, meal, water, weekScore, num } from './helpers.js';

let db, A, B;
beforeEach(async () => { db = await freshDb(); ({ A, B } = await setupDuo(db)); });
afterEach(async () => db.close());

// Week 1 = Mon Oct 12 .. Sun Oct 18 2026 (America/New_York)
const day = (d, hh = '09:00') => `2026-10-${String(d).padStart(2, '0')}T${hh}:00-04:00`;

test('perfect week scores exactly 90 (no improvement bonus in the baseline week)', async () => {
  for (const d of [12, 13, 14]) { await db.setClock(day(d, '20:00')); await workout(db, A, day(d)); }
  for (const d of [15, 16]) { await db.setClock(day(d, '20:00')); await cardio(db, A, day(d)); }
  for (const d of [12, 13, 14, 15, 16]) { await db.setClock(day(d, '20:00')); await meal(db, A, day(d, '12:30')); }
  for (const d of [12, 13, 14, 15, 16, 17, 18]) { await db.setClock(day(d, '21:00')); await water(db, A, `2026-10-${d}`); }
  const s = await weekScore(db, A);
  assert.equal(num(s.strength_points), 40);
  assert.equal(num(s.meal_points), 25);
  assert.equal(num(s.cardio_points), 15);
  assert.equal(num(s.hydration_points), 10);
  assert.equal(num(s.strength_bonus) + num(s.cardio_bonus), 0);
  assert.equal(num(s.total), 90);
});

test('partial credit keeps full precision (2 of 3 workouts = 26.666…)', async () => {
  await db.setClock(day(14, '20:00'));
  await workout(db, A, day(13));
  await workout(db, A, day(14));
  const s = await weekScore(db, A);
  assert.equal(s.strength_days, 2);
  // stored at full numeric precision; only the app rounds for display
  assert.match(String(s.strength_points), /^26\.6666666666/);
  assert.equal(Number(num(s.total).toFixed(2)), 26.67);
});

test('targets are personal: same work, different targets, same max', async () => {
  // B's target is 2 strength days; two workouts fills it.
  await db.close(); db = await freshDb();
  ({ A, B } = await setupDuo(db, { targetsB: { strength_days_target: 2, cardio_days_target: 2, hydration_target_ml: 2000, cardio_min_minutes: 20 } }));
  await db.setClock(day(14, '20:00'));
  for (const who of [A, B]) { await workout(db, who, day(13)); await workout(db, who, day(14)); }
  assert.match(String((await weekScore(db, A)).strength_points), /^26\.66/);
  assert.equal(num((await weekScore(db, B)).strength_points), 40);
});

test('a workout counts at most once per day; extra workouts beyond target add nothing', async () => {
  await db.setClock(day(14, '20:00'));
  await workout(db, A, day(13, '07:00'));
  await workout(db, A, day(13, '18:00'));
  assert.equal((await weekScore(db, A)).strength_days, 1);
  for (const d of [14, 17, 18]) { await db.setClock(day(d, '20:00')); await workout(db, A, day(d)); } // 4 days, target 3
  const s = await weekScore(db, A);
  assert.equal(s.strength_days, 4);
  assert.equal(num(s.strength_points), 40);
});

test('strength and cardio on the same day both count', async () => {
  await db.setClock(day(13, '20:00'));
  await workout(db, A, day(13, '07:00'));
  await cardio(db, A, day(13, '07:45'));
  const s = await weekScore(db, A);
  assert.equal(s.strength_days, 1);
  assert.equal(s.cardio_days, 1);
});

test('cardio must meet the person\'s agreed minimum duration', async () => {
  await db.setClock(day(13, '20:00'));
  await cardio(db, A, day(13), { duration_s: 19 * 60 + 59 });
  assert.equal((await weekScore(db, A)).cardio_days, 0);
  await cardio(db, A, day(13, '10:00'), { duration_s: 20 * 60 });
  assert.equal((await weekScore(db, A)).cardio_days, 1);
});

test('meals: one qualifying day per calendar day, checklist required, cap at 5 days', async () => {
  await db.setClock(day(12, '20:00'));
  await meal(db, A, day(12, '08:00'));
  await meal(db, A, day(12, '12:00'));
  await meal(db, A, day(12, '19:00'), { checklist: { protein: true, produce_or_fiber: false } });
  let s = await weekScore(db, A);
  assert.equal(s.meal_days, 1);
  assert.equal(num(s.meal_points), 5);
  for (const d of [13, 14, 15, 16, 17, 18]) { await db.setClock(day(d, '20:00')); await meal(db, A, day(d)); }
  s = await weekScore(db, A);
  assert.equal(s.meal_days, 7);
  assert.equal(num(s.meal_points), 25);
});

test('the same photo cannot earn twice (even re-uploaded under a new name)', async () => {
  await db.setClock(day(13, '20:00'));
  await meal(db, A, day(12), { etag: 'same-bytes' });
  await meal(db, A, day(13), { etag: 'same-bytes' });
  assert.equal((await weekScore(db, A)).meal_days, 1);
  // the other person can't reuse it either
  await meal(db, B, day(13), { etag: 'same-bytes' });
  assert.equal((await weekScore(db, B)).meal_days, 0);
});

test('hydration: meeting target scores, exceeding it adds nothing, units convert', async () => {
  await db.setClock(day(13, '21:00'));
  await water(db, A, '2026-10-12', 1999, 'ml');
  assert.equal((await weekScore(db, A)).hydration_days, 0);
  await water(db, A, '2026-10-12', 68, 'oz');        // 68 oz = 2011 ml
  await water(db, A, '2026-10-13', 9000, 'ml');      // way over target
  const s = await weekScore(db, A);
  assert.equal(s.hydration_days, 2);
  assert.match(String(s.hydration_points), /^2\.857142857/); // 10 * 2/7
});

test('weekly total never exceeds 100 and all-time is the sum of weeks', async () => {
  await db.setClock(day(14, '20:00'));
  await workout(db, A, day(14));
  await db.setClock('2026-10-20T20:00:00-04:00');
  await workout(db, A, '2026-10-20T09:00:00-04:00');
  const rows = await db.sql('select week_start, total from public.weekly_scores where user_id = $1 order by week_start', [A.id]);
  assert.equal(rows.length, 2);
  const allTime = rows.reduce((t, r) => t + num(r.total), 0);
  assert.ok(Math.abs(allTime - 80 / 3) < 1e-9);
  const max = await db.sql('select max(total) as m from public.weekly_scores');
  assert.ok(num(max[0].m) <= 100);
});
