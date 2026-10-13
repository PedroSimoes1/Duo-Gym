import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setupDuo, workout, cardio, weekScore, num } from './helpers.js';

let db, A, B;
beforeEach(async () => { db = await freshDb(); });
afterEach(async () => db.close());

const status = async () => (await db.sql('select status, start_date from public.competitions'))[0];

test('setup: defaults to next Monday; starts only when both agree to the same setup', async () => {
  ({ A, B } = await setupDuo(db, { activate: false }));
  assert.equal((await status()).start_date.toISOString().slice(0, 10), '2026-10-12');
  assert.equal(await db.rpc(A, 'agree_to_setup'), 'waiting');
  // B changes their targets → A's agreement is cleared
  await db.rpc(B, 'set_my_setup_targets', { strength_days_target: 4, cardio_days_target: 3, hydration_target_ml: 2500, cardio_min_minutes: 25 });
  assert.equal(await db.rpc(B, 'agree_to_setup'), 'waiting');
  assert.equal((await status()).status, 'setup');
  assert.equal(await db.rpc(A, 'agree_to_setup'), 'active');
  assert.equal((await status()).status, 'active');
});

test('setup: start date must be a Monday and not in the past; rules validated', async () => {
  ({ A, B } = await setupDuo(db, { activate: false }));
  await assert.rejects(db.rpc(A, 'update_setup', '2026-10-13', null), /Monday/);
  await assert.rejects(db.rpc(A, 'update_setup', '2026-10-05', null), /past/);
  await assert.rejects(db.rpc(A, 'update_setup', null, { meal_days_required: 9 }), /1–7/);
  await db.rpc(A, 'update_setup', '2026-10-19', { meal_days_required: 4,
    meal_checklist: [{ key: 'protein', label: 'Has protein' }, { key: 'veg', label: 'Has a vegetable' }] });
  const tv = await db.sql('select effective_week from public.target_versions');
  assert.ok(tv.every((r) => r.effective_week.toISOString().startsWith('2026-10-19')), 'versions move with the start date');
  await db.rpc(A, 'agree_to_setup'); await db.rpc(B, 'agree_to_setup');
  assert.equal((await status()).status, 'active');
});

test('setup: targets validated (1–7 days, sane water target)', async () => {
  ({ A, B } = await setupDuo(db, { activate: false }));
  const t = { strength_days_target: 3, cardio_days_target: 2, hydration_target_ml: 2000, cardio_min_minutes: 20 };
  await assert.rejects(db.rpc(A, 'set_my_setup_targets', { ...t, strength_days_target: 0 }), /1–7/);
  await assert.rejects(db.rpc(A, 'set_my_setup_targets', { ...t, cardio_days_target: 8 }), /1–7/);
  await assert.rejects(db.rpc(A, 'set_my_setup_targets', { ...t, hydration_target_ml: 12000 }), /250 ml/);
});

test('after start, setup functions are locked; changes need a proposal', async () => {
  ({ A, B } = await setupDuo(db));
  await assert.rejects(db.rpc(A, 'set_my_setup_targets', { strength_days_target: 1, cardio_days_target: 1, hydration_target_ml: 500, cardio_min_minutes: 5 }), /proposal/);
});

test('target change: proposer alone is not enough; applies next Monday, never retroactively', async () => {
  ({ A, B } = await setupDuo(db));
  await db.setClock('2026-10-13T20:00:00-04:00');
  await workout(db, A, '2026-10-13T09:00:00-04:00');
  const before = num((await weekScore(db, A)).strength_points);       // 1/3 of 40

  const pid = await db.rpc(A, 'propose_change', 'targets',
    { strength_days_target: 1, cardio_days_target: 1, hydration_target_ml: 1000, cardio_min_minutes: 10 });
  assert.equal(await db.rpc(A, 'approve_proposal', pid), 'pending');   // approving your own again does nothing
  let tv = await db.sql('select count(*)::int as n from public.target_versions where user_id = $1', [A.id]);
  assert.equal(tv[0].n, 1);

  assert.equal(await db.rpc(B, 'approve_proposal', pid), 'approved');
  assert.equal(await db.rpc(B, 'approve_proposal', pid), 'approved');   // idempotent
  tv = await db.sql('select effective_week from public.target_versions where user_id = $1 order by effective_week', [A.id]);
  assert.equal(tv.length, 2);
  assert.equal(tv[1].effective_week.toISOString().slice(0, 10), '2026-10-19');
  assert.equal(num((await weekScore(db, A)).strength_points), before, 'current week unchanged');

  await db.setClock('2026-10-20T20:00:00-04:00');
  await workout(db, A, '2026-10-20T09:00:00-04:00');
  assert.equal(num((await weekScore(db, A, '2026-10-19')).strength_points), 40);
  assert.equal((await weekScore(db, A, '2026-10-19')).targets.strength_days_target, 1);
});

test('rules change applies to both people from next week; rejection and withdrawal', async () => {
  ({ A, B } = await setupDuo(db));
  await db.setClock('2026-10-14T12:00:00-04:00');
  const p1 = await db.rpc(A, 'propose_change', 'rules', { meal_days_required: 3 });
  assert.equal(await db.rpc(B, 'reject_proposal', p1), 'rejected');
  assert.equal(await db.rpc(A, 'approve_proposal', p1), 'rejected');
  const p2 = await db.rpc(A, 'propose_change', 'rules', { meal_days_required: 3 });
  assert.equal(await db.rpc(A, 'reject_proposal', p2), 'withdrawn');
  const p3 = await db.rpc(B, 'propose_change', 'rules', { meal_days_required: 3 });
  const p4 = await db.rpc(A, 'propose_change', 'rules', { meal_days_required: 4 });
  const [old] = await db.sql('select status from public.change_proposals where id = $1', [p3]);
  assert.equal(old.status, 'superseded');
  assert.equal(await db.rpc(B, 'approve_proposal', p4), 'approved');
  const rv = await db.sql('select effective_week, rules from public.rule_versions order by effective_week');
  assert.equal(rv.length, 2);
  assert.equal(rv[1].rules.meal_days_required, 4);
});

test('an unapproved proposal keeps the existing settings in force', async () => {
  ({ A, B } = await setupDuo(db));
  await db.setClock('2026-10-14T12:00:00-04:00');
  await db.rpc(A, 'propose_change', 'targets', { strength_days_target: 7, cardio_days_target: 7, hydration_target_ml: 3000, cardio_min_minutes: 60 });
  await db.setClock('2026-10-20T20:00:00-04:00');
  await cardio(db, A, '2026-10-20T09:00:00-04:00', { duration_s: 25 * 60 });
  const s = await weekScore(db, A, '2026-10-19');
  assert.equal(s.targets.cardio_min_minutes, 20);
  assert.equal(s.cardio_days, 1);
});

test('a non-member cannot approve, and a member cannot approve for someone else', async () => {
  ({ A, B } = await setupDuo(db));
  const C = await db.createUser('stranger@example.com');
  await db.setClock('2026-10-14T12:00:00-04:00');
  const pid = await db.rpc(A, 'propose_change', 'rules', { meal_days_required: 3 });
  await assert.rejects(db.rpc(C, 'approve_proposal', pid), /not a member/);
  // a second approval row from A (spoofed via direct insert) is impossible: no write access
  await assert.rejects(db.as(A, (c) => c.query('insert into public.proposal_approvals (proposal_id, user_id) values ($1, $2)', [pid, B.id])),
    /permission denied/);
  const [p] = await db.sql('select status from public.change_proposals where id = $1', [pid]);
  assert.equal(p.status, 'pending');
});
