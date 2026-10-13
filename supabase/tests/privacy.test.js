import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, setupDuo, workout, meal, water, uuid, ANON } from './helpers.js';

let db, A, B, C;
beforeEach(async () => {
  db = await freshDb();
  ({ A, B } = await setupDuo(db));
  C = await db.createUser('stranger@example.com');   // signed in, never invited
  await db.setClock('2026-10-13T20:00:00-04:00');
});
afterEach(async () => db.close());

const TABLES = ['competitions', 'memberships', 'profiles', 'rule_versions', 'target_versions', 'benchmarks',
  'change_proposals', 'proposal_approvals', 'workouts', 'workout_sets', 'workout_templates', 'cardio_logs',
  'meal_logs', 'hydration_logs', 'body_records', 'record_credits', 'weekly_scores', 'former_member_scores',
  'score_audit', 'activity_feed'];

async function bodyRecord(who, { shared = false, photo = true } = {}) {
  const path = photo ? `${who.id}/body/${uuid()}.jpg` : null;
  if (path) await db.upload(who, path);
  const r = await db.rpc(who, 'save_body_record', { client_key: uuid(), recorded_on: '2026-10-13', weight: 182.4,
    weight_unit: 'lb', measurements: { waist: { value: 34, unit: 'in' } }, photo_path: path });
  if (shared) await db.rpc(who, 'set_body_record_shared', r.id, true);
  return { id: r.id, path };
}
const canSeeObject = async (who, name) =>
  (await db.read(who, "select 1 from storage.objects where bucket_id = 'media' and name = $1", [name])).length === 1;

test('signed out: no table and no function is reachable', async () => {
  await workout(db, A, '2026-10-13T09:00:00-04:00');
  for (const t of TABLES) {
    await assert.rejects(db.read(ANON, `select * from public.${t}`), /permission denied/, t);
  }
  await assert.rejects(db.rpc(ANON, 'get_my_context'), /permission denied/);
  await assert.rejects(db.rpc(ANON, 'join_competition'), /permission denied/);
  await assert.rejects(db.rpc(ANON, 'export_my_data'), /permission denied/);
  const photos = await db.read(ANON, 'select * from storage.objects');
  assert.equal(photos.length, 0);
});

test('a third signed-in account cannot join, read anything, or call the API', async () => {
  await workout(db, A, '2026-10-13T09:00:00-04:00');
  await meal(db, A, '2026-10-13T12:00:00-04:00');
  await assert.rejects(db.rpc(C, 'join_competition'), /not been invited/);
  for (const t of TABLES) {
    assert.equal((await db.read(C, `select * from public.${t}`)).length, 0, t);
  }
  await assert.rejects(db.rpc(C, 'get_my_context'), /not a member/);
  await assert.rejects(db.rpc(C, 'save_hydration', '2026-10-13', 2000, 'ml'), /not a member/);
  assert.equal((await db.read(C, 'select * from storage.objects')).length, 0);
  await assert.rejects(db.upload(C, `${C.id}/meals/x.jpg`), /row-level security/);
});

test('membership is capped at the two invited, email-confirmed accounts', async () => {
  // even if an owner mistakenly invites a third email, a third member cannot join
  const [{ id: comp }] = await db.sql('select id from public.competitions');
  await db.sql("insert into app_private.invites (competition_id, email) values ($1, 'third@example.com')", [comp]);
  const D = await db.createUser('third@example.com');
  await assert.rejects(db.rpc(D, 'join_competition'), /already has two members/);

  const db2 = await (await import('./helpers.js')).freshDb();
  try {
    await db2.setClock('2026-10-08T12:00:00-04:00');
    const U = await db2.createUser('unconfirmed@example.com', { confirmed: false });
    await db2.sql("select app_private.admin_create_competition('unconfirmed@example.com', 'x@example.com')");
    await assert.rejects(db2.rpc(U, 'join_competition'), /confirm your email/);
    // the owner bootstrap is not callable from the app
    await assert.rejects(db2.as(U, (c) => c.query("select app_private.admin_create_competition('a@b.c','d@e.f')")),
      /permission denied/);
  } finally { await db2.close(); }
});

test('members can only read; every write must go through the API', async () => {
  const wid = await workout(db, A, '2026-10-13T09:00:00-04:00');
  const [{ id: comp }] = await db.sql('select id from public.competitions');
  const attempts = [
    ['insert into public.workouts (competition_id, user_id, client_key, status, activity_at) values ($1, $2, gen_random_uuid(), \'draft\', now())', [comp, A.id]],
    ['update public.workouts set submitted_at = now() where id = $1', [wid]],
    ['update public.weekly_scores set total = 100', []],
    ['insert into public.record_credits select * from public.record_credits limit 1', []],
    ['delete from public.score_audit', []],
    ['update public.competitions set status = \'setup\'', []],
    ['insert into public.memberships (competition_id, user_id) values ($1, $2)', [comp, C.id]],
  ];
  for (const [q, p] of attempts) await assert.rejects(db.as(A, (c) => c.query(q, p)), /permission denied/, q);
});

test('the client cannot set its own points, eligibility times or identity', async () => {
  const id = await db.rpc(A, 'save_cardio', { client_key: uuid(), activity: 'Run', duration_s: 1800,
    activity_at: '2026-10-13T09:00:00-04:00', submitted_at: '2026-10-13T09:00:00-04:00',
    original_activity_at: '2000-01-01T00:00:00Z', user_id: B.id, points: 100 });
  const [row] = await db.sql('select user_id, submitted_at, original_activity_at from public.cardio_logs where id = $1', [id]);
  assert.equal(row.user_id, A.id);
  assert.equal(row.submitted_at.toISOString(), '2026-10-14T00:00:00.000Z');   // server clock
  assert.equal(row.original_activity_at.toISOString(), '2026-10-13T13:00:00.000Z');
});

test('each person edits and deletes only their own logs', async () => {
  const wid = await workout(db, A, '2026-10-13T09:00:00-04:00');
  await assert.rejects(db.rpc(B, 'save_workout', { id: wid, activity_at: '2026-10-13T09:00:00-04:00', status: 'completed' }),
    /only edit your own/);
  await db.rpc(B, 'delete_workout', wid);   // silently does nothing
  assert.equal((await db.sql('select count(*)::int as n from public.workouts where id = $1', [wid]))[0].n, 1);
});

test('friend sees shared logs, but not drafts or templates', async () => {
  await workout(db, A, '2026-10-13T09:00:00-04:00');
  await db.rpc(A, 'save_workout', { client_key: uuid(), activity_at: '2026-10-13T10:00:00-04:00', status: 'draft', sets: [] });
  await db.rpc(A, 'save_template', { name: 'Push day', items: [{ exercise: 'Bench press' }] });
  await meal(db, A, '2026-10-13T12:00:00-04:00');
  await water(db, A, '2026-10-13');
  const seen = await db.read(B, 'select status from public.workouts');
  assert.deepEqual(seen.map((r) => r.status), ['completed']);
  assert.equal((await db.read(B, 'select * from public.workout_sets')).length, 1);
  assert.equal((await db.read(B, 'select * from public.workout_templates')).length, 0);
  assert.equal((await db.read(B, 'select * from public.meal_logs')).length, 1);
  assert.equal((await db.read(B, 'select * from public.hydration_logs')).length, 1);
  assert.equal((await db.read(B, 'select * from public.weekly_scores')).length, 2);
});

test('body records are private until the owner shares that one record; sharing can be revoked', async () => {
  const priv = await bodyRecord(A);
  const pub = await bodyRecord(A, { shared: true });
  let seen = await db.read(B, 'select id from public.body_records');
  assert.deepEqual(seen.map((r) => r.id), [pub.id]);
  assert.equal((await db.read(A, 'select id from public.body_records')).length, 2);
  await db.rpc(A, 'set_body_record_shared', pub.id, false);
  seen = await db.read(B, 'select id from public.body_records');
  assert.equal(seen.length, 0);
  await assert.rejects(db.rpc(B, 'set_body_record_shared', priv.id, true), /not found/);
  // body records never appear in the shared feed
  const feed = await db.sql('select summary from public.activity_feed');
  assert.ok(feed.every((f) => !/body|weight/i.test(f.summary)));
});

test('photo files follow the same rules: meal photos shared, body photos private unless shared', async () => {
  const mealPath = `${A.id}/meals/${uuid()}.jpg`;
  await db.upload(A, mealPath);
  const priv = await bodyRecord(A);
  const pub = await bodyRecord(A, { shared: true });
  assert.equal(await canSeeObject(B, mealPath), false, 'unattached meal photo is not visible yet');
  await meal(db, A, '2026-10-13T12:00:00-04:00', { path: mealPath });
  assert.equal(await canSeeObject(B, mealPath), true);
  assert.equal(await canSeeObject(B, priv.path), false);
  assert.equal(await canSeeObject(B, pub.path), true);
  assert.equal(await canSeeObject(A, priv.path), true);
  await db.rpc(A, 'set_body_record_shared', pub.id, false);
  assert.equal(await canSeeObject(B, pub.path), false, 'revoked');
  for (const p of [mealPath, priv.path, pub.path]) {
    assert.equal(await canSeeObject(C, p), false);
    assert.equal(await canSeeObject(ANON, p), false);
  }
});

test('uploads only into your own folder; photos in use cannot be deleted or swapped', async () => {
  await assert.rejects(db.upload(B, `${A.id}/meals/${uuid()}.jpg`), /row-level security/);
  await assert.rejects(db.upload(A, `${A.id}/other/${uuid()}.jpg`), /row-level security/);
  await assert.rejects(db.upload(A, `${A.id}/meals/nested/${uuid()}.jpg`), /row-level security/);
  const mid = await meal(db, A, '2026-10-13T12:00:00-04:00');
  const [{ photo_path: p }] = await db.sql('select photo_path from public.meal_logs where id = $1', [mid.id]);
  // B can't delete A's photo; A can't delete it while the meal uses it; nobody can overwrite it
  let del = await db.as(B, (c) => c.query('delete from storage.objects where name = $1', [p]));
  assert.equal(del.rowCount, 0);
  del = await db.as(A, (c) => c.query('delete from storage.objects where name = $1', [p]));
  assert.equal(del.rowCount, 0);
  const upd = await db.as(A, (c) => c.query("update storage.objects set metadata = '{}' where name = $1", [p]));
  assert.equal(upd.rowCount, 0);
  // delete the meal first, then the file can go
  assert.equal(await db.rpc(A, 'delete_meal', mid.id), p);
  del = await db.as(A, (c) => c.query('delete from storage.objects where name = $1', [p]));
  assert.equal(del.rowCount, 1);
});

test("a meal cannot use someone else's photo", async () => {
  const bPath = `${B.id}/meals/${uuid()}.jpg`;
  await db.upload(B, bPath);
  await assert.rejects(meal(db, A, '2026-10-13T12:00:00-04:00', { path: bPath }), /your own/);
  await assert.rejects(meal(db, A, '2026-10-13T12:00:00-04:00', { path: `${A.id}/meals/never-uploaded.jpg` }),
    /did not finish/);
});
