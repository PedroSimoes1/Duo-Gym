import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setupDuo, workout, cardio, water, weekScore, num, uuid } from './helpers.js';

let db, A, B;
beforeEach(async () => { db = await freshDb(); ({ A, B } = await setupDuo(db)); });
afterEach(async () => db.close());

const credits = (who) => db.sql('select * from public.record_credits where user_id = $1', [who.id]);

test('48-hour window: exactly 48h late still counts, 48h + 1s does not', async () => {
  await db.setClock('2026-10-15T09:00:00-04:00');
  await workout(db, A, '2026-10-13T09:00:00-04:00');           // exactly 48h
  await workout(db, A, '2026-10-13T08:59:59-04:00');           // 48h + 1s (same day → still 1 day)
  await workout(db, A, '2026-10-14T08:59:59-04:00');           // 24h late
  const rows = await credits(A);
  const byTime = Object.fromEntries(await Promise.all(rows.map(async (r) => {
    const [w] = await db.sql('select activity_at from public.workouts where id = $1', [r.record_id]);
    return [w.activity_at.toISOString(), r.qualifies];
  })));
  assert.equal(byTime['2026-10-13T13:00:00.000Z'], true);
  assert.equal(byTime['2026-10-13T12:59:59.000Z'], false);
  assert.equal((await weekScore(db, A)).strength_days, 2);
});

test('late entries are kept as history but earn nothing', async () => {
  await db.setClock('2026-10-17T10:00:00-04:00');
  const id = await workout(db, A, '2026-10-13T09:00:00-04:00');  // 4 days late
  const [w] = await db.sql('select * from public.workouts where id = $1', [id]);
  assert.ok(w, 'record kept');
  assert.equal((await weekScore(db, A)).strength_days, 0);
});

test('future activity times are rejected', async () => {
  await db.setClock('2026-10-13T09:00:00-04:00');
  await assert.rejects(workout(db, A, '2026-10-13T09:10:00-04:00'), /future/);
  await assert.rejects(water(db, A, '2026-10-14'), /today or earlier/);
});

test('entries before the start date are history only', async () => {
  await db.setClock('2026-10-10T12:00:00-04:00');   // Saturday before start
  await workout(db, A, '2026-10-10T09:00:00-04:00');
  await water(db, A, '2026-10-10');
  await db.setClock('2026-10-12T12:00:00-04:00');
  await db.rpc(A, 'refresh_scores');
  const s = await weekScore(db, A);
  assert.equal(num(s.total), 0);
  const prior = await db.sql("select * from public.weekly_scores where week_start < '2026-10-12'");
  assert.equal(prior.length, 0);
});

test('editing the time cannot restart the deadline or move into a closed day', async () => {
  await db.setClock('2026-10-13T10:00:00-04:00');
  const id = await cardio(db, A, '2026-10-13T09:00:00-04:00');
  // inside the window: allowed to fix the time, but only within the last 48h
  await assert.rejects(
    db.rpc(A, 'save_cardio', { id, activity: 'Run', duration_s: 1800, activity_at: '2026-10-10T09:00:00-04:00' }),
    /within the last 48 hours/);
  await db.rpc(A, 'save_cardio', { id, activity: 'Run', duration_s: 1800, activity_at: '2026-10-13T07:00:00-04:00' });
  // after the original window closes: no time changes at all
  await db.setClock('2026-10-15T09:00:01-04:00');
  await assert.rejects(
    db.rpc(A, 'save_cardio', { id, activity: 'Run', duration_s: 1800, activity_at: '2026-10-15T08:00:00-04:00' }),
    /can no longer be changed/);
  const [row] = await db.sql('select original_activity_at, submitted_at from public.cardio_logs where id = $1', [id]);
  assert.equal(row.original_activity_at.toISOString(), '2026-10-13T13:00:00.000Z');
  assert.equal(row.submitted_at.toISOString(), '2026-10-13T14:00:00.000Z');
});

test('after 48h a correction can lower points but never raise them', async () => {
  await db.setClock('2026-10-13T10:00:00-04:00');
  const short = await cardio(db, A, '2026-10-13T09:00:00-04:00', { duration_s: 600 });   // 10 min: below minimum
  const good = await cardio(db, A, '2026-10-12T18:00:00-04:00', { duration_s: 1800 });
  assert.equal((await weekScore(db, A)).cardio_days, 1);

  await db.setClock('2026-10-16T12:00:00-04:00');   // both windows closed
  // raising the short session above the minimum must not award a day
  await db.rpc(A, 'save_cardio', { id: short, activity: 'Run', duration_s: 3600, activity_at: '2026-10-13T09:00:00-04:00' });
  assert.equal((await weekScore(db, A)).cardio_days, 1);
  // lowering the good one below the minimum removes its day
  await db.rpc(A, 'save_cardio', { id: good, activity: 'Run', duration_s: 300, activity_at: '2026-10-12T18:00:00-04:00' });
  assert.equal((await weekScore(db, A)).cardio_days, 0);
  // and putting it back does not restore it
  await db.rpc(A, 'save_cardio', { id: good, activity: 'Run', duration_s: 1800, activity_at: '2026-10-12T18:00:00-04:00' });
  assert.equal((await weekScore(db, A)).cardio_days, 0);
});

test('inside the window, edits can change eligibility either way', async () => {
  await db.setClock('2026-10-13T10:00:00-04:00');
  const id = await cardio(db, A, '2026-10-13T09:00:00-04:00', { duration_s: 600 });
  assert.equal((await weekScore(db, A)).cardio_days, 0);
  await db.rpc(A, 'save_cardio', { id, activity: 'Run', duration_s: 1500, activity_at: '2026-10-13T09:00:00-04:00' });
  assert.equal((await weekScore(db, A)).cardio_days, 1);
});

test('after 48h, deleting a log removes its points', async () => {
  await db.setClock('2026-10-13T10:00:00-04:00');
  const id = await workout(db, A, '2026-10-13T09:00:00-04:00');
  await db.setClock('2026-10-20T10:00:00-04:00');
  await db.rpc(A, 'delete_workout', id);
  assert.equal((await weekScore(db, A)).strength_days, 0);
  const audit = await db.sql("select * from public.score_audit where user_id = $1 and reason = 'workout deleted'", [A.id]);
  assert.equal(audit.length, 1);
  assert.ok(num(audit[0].new_total) < num(audit[0].old_total));
});

test('hydration window runs 48h past the END of the day; late increases do not count', async () => {
  // Day Oct 13 ends Oct 14 00:00 ET → window closes Oct 16 00:00 ET
  await db.setClock('2026-10-15T23:59:00-04:00');
  await water(db, A, '2026-10-13', 2000);
  assert.equal((await weekScore(db, A)).hydration_days, 1);
  await db.setClock('2026-10-16T00:00:01-04:00');
  await water(db, A, '2026-10-12', 2000);       // too late for Oct 12
  assert.equal((await weekScore(db, A)).hydration_days, 1);
  // Oct 14: logged short in time, topped up after the window → no credit
  await db.setClock('2026-10-15T08:00:00-04:00');
  await water(db, A, '2026-10-14', 500);
  await db.setClock('2026-10-17T08:00:00-04:00');
  await water(db, A, '2026-10-14', 3000);
  assert.equal((await weekScore(db, A)).hydration_days, 1);
});

test('week boundaries are Monday 00:00 New York time, stored as UTC', async () => {
  // Sunday 23:30 EDT is Monday 03:30 UTC but belongs to the previous week
  const rows = await db.sql(`select
    app_private.week_of('2026-10-19T03:30:00Z', 'America/New_York') as sun_night,
    app_private.week_of('2026-10-19T04:00:00Z', 'America/New_York') as mon_midnight`);
  assert.equal(rows[0].sun_night.toISOString().slice(0, 10), '2026-10-12');
  assert.equal(rows[0].mon_midnight.toISOString().slice(0, 10), '2026-10-19');

  await db.setClock('2026-10-19T08:00:00Z');
  await workout(db, A, '2026-10-19T03:30:00Z');
  assert.equal((await weekScore(db, A, '2026-10-12')).strength_days, 1);
});

test('daylight-saving change (Nov 1 2026) keeps weeks correct', async () => {
  // Clocks fall back Sun Nov 1 02:00 EDT → 01:00 EST. Monday Nov 2 00:00 EST = 05:00 UTC.
  const rows = await db.sql(`select
    app_private.week_of('2026-11-02T04:59:59Z', 'America/New_York') as before,
    app_private.week_of('2026-11-02T05:00:00Z', 'America/New_York') as after,
    app_private.local_midnight('2026-11-02', 'America/New_York') as boundary,
    app_private.local_midnight('2026-10-26', 'America/New_York') as prev_boundary`);
  assert.equal(rows[0].before.toISOString().slice(0, 10), '2026-10-26');
  assert.equal(rows[0].after.toISOString().slice(0, 10), '2026-11-02');
  assert.equal(rows[0].boundary.toISOString(), '2026-11-02T05:00:00.000Z');
  // that week is 169 real hours long (one extra hour), and still one week
  assert.equal((rows[0].boundary - rows[0].prev_boundary) / 3600000, 169);
  // spring forward (Sun Mar 14 2027): the week before starts 05:00 UTC, the week after 04:00 UTC,
  // and that week is 167 real hours long
  const [s] = await db.sql(`select app_private.local_midnight('2027-03-08', 'America/New_York') as a,
                                   app_private.local_midnight('2027-03-15', 'America/New_York') as b`);
  assert.equal(s.a.toISOString(), '2027-03-08T05:00:00.000Z');
  assert.equal(s.b.toISOString(), '2027-03-15T04:00:00.000Z');
  assert.equal((s.b - s.a) / 3600000, 167);
});

test('a week stays provisional until 48h after it ends, then is final', async () => {
  await db.setClock('2026-10-13T10:00:00-04:00');
  await workout(db, A, '2026-10-13T09:00:00-04:00');
  assert.equal((await weekScore(db, A)).status, 'provisional');
  await db.setClock('2026-10-20T23:59:59-04:00');   // Oct 19 00:00 + 48h = Oct 21 00:00
  await db.rpc(B, 'refresh_scores');
  assert.equal((await weekScore(db, A)).status, 'provisional');
  await db.setClock('2026-10-21T00:00:00-04:00');
  await db.rpc(B, 'refresh_scores');
  assert.equal((await weekScore(db, A)).status, 'final');
});

test('copied drafts never earn points until completed', async () => {
  await db.setClock('2026-10-13T10:00:00-04:00');
  const src = await workout(db, A, '2026-10-13T09:00:00-04:00');
  await db.setClock('2026-10-14T10:00:00-04:00');
  const draft = await db.rpc(A, 'copy_workout_as_draft', src, uuid());
  assert.equal((await weekScore(db, A)).strength_days, 1);
  const [w] = await db.sql('select status, activity_at from public.workouts where id = $1', [draft]);
  assert.equal(w.status, 'draft');
  await db.rpc(A, 'save_workout', { id: draft, title: 'Again', activity_at: '2026-10-14T09:30:00-04:00', status: 'completed' });
  assert.equal((await weekScore(db, A)).strength_days, 2);
  await assert.rejects(
    db.rpc(A, 'save_workout', { id: draft, activity_at: '2026-10-14T09:30:00-04:00', status: 'draft' }),
    /cannot go back to draft/);
});
