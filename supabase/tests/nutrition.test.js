import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setupDuo, uuid } from './helpers.js';

test('meal nutrition is validated, persisted, shared with the duo and denied to a third account', async () => {
  const db = await freshDb();
  try {
    const { A, B } = await setupDuo(db);
    const outsider = await db.createUser('outsider@example.com');
    await db.setClock('2026-10-13T16:00:00-04:00');
    const photo = `${A.id}/meals/${uuid()}.jpg`;
    await db.upload(A, photo);
    const id = await db.rpc(A, 'save_meal', {
      client_key: uuid(),
      description: 'Lunch',
      photo_path: photo,
      checklist: { protein: true, produce_or_fiber: true },
      nutrition: { calories: 640, protein: 42, carbs: 70, fat: 18, sodium: 0 },
      activity_at: '2026-10-13T15:00:00-04:00',
    });

    const partnerRows = await db.read(B, 'select nutrition from public.meal_logs where id = $1', [id.id]);
    assert.equal(Number(partnerRows[0].nutrition.calories), 640);
    assert.equal(Number(partnerRows[0].nutrition.sodium), 0);
    assert.deepEqual(
      await db.read(outsider, 'select id from public.meal_logs where id = $1', [id.id]),
      [],
    );

    await assert.rejects(
      db.rpc(A, 'save_meal', {
        id: id.id,
        description: 'Lunch',
        photo_path: photo,
        checklist: {},
        nutrition: { calories: -1 },
        activity_at: '2026-10-13T15:00:00-04:00',
      }),
      /outside the supported range/,
    );
  } finally {
    await db.close();
  }
});

test('nutrition goals are versioned, member-readable, owner-writable and idempotent', async () => {
  const db = await freshDb();
  try {
    const { A, B } = await setupDuo(db);
    const outsider = await db.createUser('outsider@example.com');
    await db.setClock('2026-10-13T09:00:00-04:00');
    const requestId = uuid();

    await Promise.all([
      db.rpc(A, 'set_nutrition_goals', { calories: 2200, protein: 160 }, 0, requestId),
      db.rpc(A, 'set_nutrition_goals', { calories: 2200, protein: 160 }, 0, requestId),
    ]);
    const own = await db.read(A, 'select * from public.nutrition_goal_versions where user_id = $1', [A.id]);
    assert.equal(own.length, 1);
    assert.equal(own[0].version, 1);
    assert.equal(String(own[0].effective_date).slice(0, 10), '2026-10-13');

    const partner = await db.read(B, 'select goals from public.nutrition_goal_versions where user_id = $1', [A.id]);
    assert.equal(Number(partner[0].goals.protein), 160);
    assert.deepEqual(
      await db.read(outsider, 'select goals from public.nutrition_goal_versions where user_id = $1', [A.id]),
      [],
    );

    await assert.rejects(
      db.rpc(A, 'set_nutrition_goals', { calories: 2300 }, 0, requestId),
      /IDEMPOTENCY_CONFLICT/,
    );
    await assert.rejects(
      db.rpc(A, 'set_nutrition_goals', { calories: 2300 }, 0, uuid()),
      /VERSION_CONFLICT/,
    );
  } finally {
    await db.close();
  }
});

test('nutrition goals reject unsupported, zero and excessive values', async () => {
  const db = await freshDb();
  try {
    const { A } = await setupDuo(db);
    for (const invalid of [
      { sugar: 20 },
      { protein: 0 },
      { calories: 100001 },
      { protein: 'lots' },
    ]) {
      await assert.rejects(db.rpc(A, 'set_nutrition_goals', invalid, 0, uuid()));
    }
  } finally {
    await db.close();
  }
});
