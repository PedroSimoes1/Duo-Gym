import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setupDuo, workout, cardio, weekScore, num } from './helpers.js';

let db, A, B;
const BENCH_A = {
  strength: [{ exercise: 'Back squat', equipment: 'Barbell', reps: 5 }, { exercise: 'Pull-up', equipment: 'Bodyweight', reps: 8 }],
  cardio: { activity: 'Run', protocol: 'time_for_distance', distance: 5, distance_unit: 'km' },
};
beforeEach(async () => { db = await freshDb(); ({ A, B } = await setupDuo(db, { benchmarksA: BENCH_A })); });
afterEach(async () => db.close());

const squat = (weight, unit = 'lb', reps = 5) => [{ exercise: 'Back squat', equipment: 'Barbell', sets: 1, reps, weight, weight_unit: unit }];
const at = (date, hh = '09:00') => `${date}T${hh}:00-04:00`;
async function logAt(date, fn) { await db.setClock(at(date, '20:00')); return fn(); }

test('baseline week: improvements earn no bonus; week 2 improvement earns 5', async () => {
  await logAt('2026-10-12', () => workout(db, A, at('2026-10-12'), squat(185)));
  await logAt('2026-10-15', () => workout(db, A, at('2026-10-15'), squat(195)));   // better, but baseline week
  assert.equal(num((await weekScore(db, A, '2026-10-12')).strength_bonus), 0);

  await logAt('2026-10-20', () => workout(db, A, at('2026-10-20'), squat(195)));   // equal: not strictly better
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 0);
  await logAt('2026-10-22', () => workout(db, A, at('2026-10-22'), squat(200)));
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 5);
  // another record the same week earns nothing more
  await logAt('2026-10-23', () => workout(db, A, at('2026-10-23'), squat(210)));
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 5);
});

test('only an exact exercise + equipment + rep match counts (case/space-insensitive)', async () => {
  await logAt('2026-10-12', () => workout(db, A, at('2026-10-12'), squat(185)));
  await logAt('2026-10-20', () => workout(db, A, at('2026-10-20'), squat(225, 'lb', 3)));   // 3 reps ≠ 5
  await logAt('2026-10-21', () => workout(db, A, at('2026-10-21'),
    [{ exercise: 'Back squat', equipment: 'Smith machine', sets: 1, reps: 5, weight: 225, weight_unit: 'lb' }]));
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 0);
  await logAt('2026-10-22', () => workout(db, A, at('2026-10-22'),
    [{ exercise: '  back   SQUAT ', equipment: 'barbell', sets: 1, reps: 5, weight: 190, weight_unit: 'lb' }]));
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 5);
});

test('units are compared in kg (100 kg beats 220 lb, 99.7 kg does not)', async () => {
  await logAt('2026-10-12', () => workout(db, A, at('2026-10-12'), squat(220, 'lb')));   // 99.79 kg
  await logAt('2026-10-20', () => workout(db, A, at('2026-10-20'), squat(99.7, 'kg')));
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 0);
  await logAt('2026-10-21', () => workout(db, A, at('2026-10-21'), squat(100, 'kg')));
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 5);
  const [k] = await db.sql("select app_private.to_kg(220, 'lb') as kg, app_private.to_m(1, 'mi') as m, app_private.to_ml(1, 'oz') as ml");
  assert.equal(num(k.kg), 99.7903214);
  assert.equal(num(k.m), 1609.344);
  assert.equal(num(k.ml), 29.5735295625);
});

test('bodyweight benchmark: adding load is an improvement', async () => {
  const pull = (w) => [{ exercise: 'Pull-up', equipment: 'Bodyweight', sets: 1, reps: 8, weight: w, weight_unit: 'lb' }];
  await logAt('2026-10-12', () => workout(db, A, at('2026-10-12'), pull(0)));
  await logAt('2026-10-20', () => workout(db, A, at('2026-10-20'), pull(10)));
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 5);
});

test('cardio time-for-distance: faster 5 km earns 5; wrong distance does not match', async () => {
  const run = (date, s, km = 5) => logAt(date, () => cardio(db, A, at(date), { duration_s: s, distance: km, distance_unit: 'km' }));
  await run('2026-10-12', 1800);
  await run('2026-10-20', 1700, 4.8);       // not the benchmark distance
  assert.equal(num((await weekScore(db, A, '2026-10-19')).cardio_bonus), 0);
  await run('2026-10-21', 1800);            // equal time: no
  assert.equal(num((await weekScore(db, A, '2026-10-19')).cardio_bonus), 0);
  await run('2026-10-23', 1790);
  assert.equal(num((await weekScore(db, A, '2026-10-19')).cardio_bonus), 5);
});

test('cardio distance-in-time: longer distance in the fixed time earns 5', async () => {
  await db.close(); db = await freshDb();
  ({ A, B } = await setupDuo(db, { benchmarksA: { strength: [], cardio: { activity: 'Row', protocol: 'distance_in_time', duration_s: 1200 } } }));
  const row = (date, km, s = 1200) => logAt(date, () => cardio(db, A, at(date), { activity: 'Row', duration_s: s, distance: km, distance_unit: 'km' }));
  await row('2026-10-13', 4.0);
  await row('2026-10-20', 4.2, 1260);       // different duration: not comparable
  assert.equal(num((await weekScore(db, A, '2026-10-19')).cardio_bonus), 0);
  await row('2026-10-21', 4.1);
  assert.equal(num((await weekScore(db, A, '2026-10-19')).cardio_bonus), 5);
});

test('no bonus without a baseline; the first result becomes the baseline', async () => {
  await logAt('2026-10-20', () => workout(db, A, at('2026-10-20'), squat(185)));   // skipped week 1
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 0);
  await logAt('2026-10-27', () => workout(db, A, at('2026-10-27'), squat(190)));
  assert.equal(num((await weekScore(db, A, '2026-10-26')).strength_bonus), 5);
});

test('late (ineligible) results never count as a best or a record', async () => {
  await logAt('2026-10-12', () => workout(db, A, at('2026-10-12'), squat(185)));
  await db.setClock(at('2026-10-24', '20:00'));
  await workout(db, A, at('2026-10-20'), squat(300));   // 4 days late: history only
  await db.setClock(at('2026-10-24', '21:00'));
  await workout(db, A, at('2026-10-24'), squat(190));    // beats 185, not the late 300
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 5);
});

test('deleting or correcting a best is recalculated: later records compare to what remains', async () => {
  await logAt('2026-10-12', () => workout(db, A, at('2026-10-12'), squat(185)));
  const typo = await logAt('2026-10-13', () => workout(db, A, at('2026-10-13'), squat(815)));   // typo
  await logAt('2026-10-20', () => workout(db, A, at('2026-10-20'), squat(190)));
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 0);
  // fix the typo while the 10-20 record is still in its window
  await db.setClock(at('2026-10-21', '20:00'));
  await db.rpc(A, 'delete_workout', typo);
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 5);
});

test('a result whose window has closed cannot gain a bonus later', async () => {
  await logAt('2026-10-12', () => workout(db, A, at('2026-10-12'), squat(185)));
  const typo = await logAt('2026-10-13', () => workout(db, A, at('2026-10-13'), squat(815)));
  await logAt('2026-10-20', () => workout(db, A, at('2026-10-20'), squat(190)));
  await db.setClock(at('2026-10-25', '20:00'));       // 10-20 result's window closed
  await db.rpc(A, 'delete_workout', typo);
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 0);
});

test('changing a benchmark needs both approvals, applies next week, and restarts its baseline', async () => {
  await logAt('2026-10-12', () => workout(db, A, at('2026-10-12'), squat(185)));
  await db.setClock(at('2026-10-14', '12:00'));
  const pid = await db.rpc(A, 'propose_change', 'benchmarks', {
    strength: [{ exercise: 'Back squat', equipment: 'Barbell', reps: 3 }, { exercise: 'Pull-up', equipment: 'Bodyweight', reps: 8 }],
    cardio: BENCH_A.cardio });
  let active = await db.sql("select * from public.benchmarks where user_id = $1 and kind = 'strength' and retired_week is null", [A.id]);
  assert.equal(active.length, 2);
  assert.ok(active.some((b) => b.reps === 5), 'old benchmark still active until approved');
  assert.equal(await db.rpc(B, 'approve_proposal', pid), 'approved');
  const rows = await db.sql("select reps, effective_week, retired_week from public.benchmarks where user_id = $1 and exercise_key = 'back squat' order by created_at", [A.id]);
  assert.equal(rows[0].retired_week.toISOString().slice(0, 10), '2026-10-19');
  assert.equal(rows[1].reps, 3);
  assert.equal(rows[1].effective_week.toISOString().slice(0, 10), '2026-10-19');
  // week of 10-19 is the new benchmark's baseline week: no bonus even if heavy
  await logAt('2026-10-20', () => workout(db, A, at('2026-10-20'), squat(205, 'lb', 3)));
  await logAt('2026-10-22', () => workout(db, A, at('2026-10-22'), squat(215, 'lb', 3)));
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_bonus), 0);
  await logAt('2026-10-27', () => workout(db, A, at('2026-10-27'), squat(220, 'lb', 3)));
  assert.equal(num((await weekScore(db, A, '2026-10-26')).strength_bonus), 5);
  // unchanged pull-up benchmark kept its history (same row, never retired)
  const pull = await db.sql("select count(*)::int as n from public.benchmarks where user_id = $1 and exercise_key = 'pull-up'", [A.id]);
  assert.equal(pull[0].n, 1);
});

test('benchmark setup limits: up to three strength, one cardio, no duplicates', async () => {
  await db.close(); db = await freshDb();
  ({ A, B } = await setupDuo(db, { activate: false }));
  const s = (n) => Array.from({ length: n }, (_, i) => ({ exercise: `Lift ${i}`, equipment: 'Barbell', reps: 5 }));
  await assert.rejects(db.rpc(A, 'set_my_setup_benchmarks', { strength: s(4) }), /up to three/);
  await assert.rejects(db.rpc(A, 'set_my_setup_benchmarks', { strength: [s(1)[0], s(1)[0]] }), /identical/);
  await db.rpc(A, 'set_my_setup_benchmarks', { strength: s(3), cardio: null });
});
