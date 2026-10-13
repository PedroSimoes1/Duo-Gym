import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewGateway, PREVIEW_STORAGE_KEY } from '../src/data/preview.ts';
import type { PreviewStorage } from '../src/data/preview.ts';
import { HttpGateway } from '../src/data/http.ts';
import type { Command, LogInput } from '../shared/contracts.ts';
import { nutritionGoalsForDate, summarizeNutrition } from '../shared/nutrition.ts';

function fixture() {
  const values = new Map<string, string>();
  const storage: PreviewStorage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
    removeItem: (k) => {
      values.delete(k);
    },
  };
  const now = () => new Date('2026-10-08T16:00:00Z');
  return { gateway: new PreviewGateway(storage, now), storage, now };
}
function request(command: Command, requestId = crypto.randomUUID()) {
  return { requestId, command };
}
function workout(overrides: Partial<LogInput> = {}): LogInput {
  return {
    kind: 'workout',
    title: 'Test workout',
    notes: '',
    occurredAt: '2026-10-08T15:00:00Z',
    completed: true,
    sets: [{ exercise: 'Squat', equipment: 'Barbell', repetitions: 5, load: 100, unit: 'lb' }],
    ...overrides,
  };
}

test('meal nutrition persists, edits replace totals, retries do not duplicate, and deletion removes it', async () => {
  const { gateway, storage, now } = fixture();
  const before = await gateway.bootstrap();
  const input: LogInput = {
    kind: 'meal',
    title: 'Nutrition test meal',
    notes: '',
    occurredAt: now().toISOString(),
    checklist: [true, true],
    nutrition: {
      calories: 450.25,
      protein: 30,
      carbs: 60,
      fat: 10,
      fiber: 0,
      sugar: 3,
      sodium: 250,
    },
  };
  const create = request({ type: 'log.create', log: input });
  await gateway.execute(create);
  const retried = await gateway.execute(create);
  assert.equal(retried.logs.filter((log) => log.title === input.title).length, 1);
  const data = await new PreviewGateway(storage, now).bootstrap();
  const saved = data.logs.find((log) => log.title === input.title)!;
  assert.deepEqual(saved.nutrition, input.nutrition);
  assert.equal(saved.eligibility, 'unscored');
  assert.deepEqual(data.allTime, before.allTime);
  const edited = await gateway.execute(
    request({
      type: 'log.update',
      id: saved.id,
      expectedVersion: saved.version,
      log: { ...input, nutrition: { calories: 300, fat: 0 } },
    }),
  );
  const daily = summarizeNutrition(edited.logs, 'preview-you', '2026-10-08', 'America/New_York');
  assert.equal(daily.totals.calories, 300);
  assert.equal(daily.recorded.protein, 0);
  const exported = (await gateway.exportOwn()) as {
    logs: { id: string; nutrition?: { calories: number } }[];
  };
  assert.equal(exported.logs.find((log) => log.id === saved.id)!.nutrition!.calories, 300);
  const deleted = await gateway.execute(
    request({ type: 'log.delete', id: saved.id, expectedVersion: 2 }),
  );
  assert.equal(
    summarizeNutrition(deleted.logs, 'preview-you', '2026-10-08', 'America/New_York').recorded
      .calories,
    0,
  );
  assert.deepEqual(deleted.allTime, before.allTime);
});

test('nutrition goals are own-only, versioned, idempotent and do not change competition points', async () => {
  const { gateway, storage, now } = fixture();
  const before = await gateway.bootstrap();
  assert.ok(before.profiles.every((profile) => !profile.nutritionGoalHistory));
  const change = request({
    type: 'nutrition.goals.set',
    goals: { calories: 2000, protein: 120, carbs: 230, fat: 65, fiber: 25 },
    expectedVersion: 0,
  });
  const saved = await gateway.execute(change);
  const retried = await gateway.execute(change);
  assert.deepEqual(retried.profiles, saved.profiles);
  assert.deepEqual(saved.allTime, before.allTime);
  const own = saved.profiles.find((profile) => profile.id === 'preview-you')!;
  assert.equal(own.nutritionGoalsVersion, 1);
  assert.equal(own.nutritionGoalHistory![0].effectiveDate, '2026-10-08');
  assert.ok(
    !saved.profiles.find((profile) => profile.id === 'preview-partner')!.nutritionGoalHistory,
  );
  await assert.rejects(
    gateway.execute(
      request({ type: 'nutrition.goals.set', goals: { calories: 1800 }, expectedVersion: 0 }),
    ),
    {
      code: 'VERSION_CONFLICT',
    },
  );
  const reloaded = await new PreviewGateway(storage, now).bootstrap();
  assert.deepEqual(reloaded.profiles, saved.profiles);
  const cleared = await gateway.execute(
    request({ type: 'nutrition.goals.set', goals: {}, expectedVersion: 1 }),
  );
  assert.deepEqual(
    nutritionGoalsForDate(cleared.profiles[0].nutritionGoalHistory, '2026-10-08'),
    {},
  );
});

test('goal effective day uses trusted competition time and preserves prior-day goals', async () => {
  const { gateway, storage } = fixture();
  await gateway.execute(
    request({ type: 'nutrition.goals.set', goals: { calories: 2000 }, expectedVersion: 0 }),
  );
  const beforeMidnight = new PreviewGateway(storage, () => new Date('2026-10-09T03:59:59Z'));
  await beforeMidnight.execute(
    request({ type: 'nutrition.goals.set', goals: { calories: 2100 }, expectedVersion: 1 }),
  );
  const nextDay = new PreviewGateway(storage, () => new Date('2026-10-09T04:00:00Z'));
  const after = await nextDay.execute(
    request({ type: 'nutrition.goals.set', goals: { calories: 2200 }, expectedVersion: 2 }),
  );
  const history = after.profiles[0].nutritionGoalHistory!;
  assert.equal(history.length, 2);
  assert.deepEqual(nutritionGoalsForDate(history, '2026-10-08'), { calories: 2100 });
  assert.deepEqual(nutritionGoalsForDate(history, '2026-10-09'), { calories: 2200 });
});

test('nutrition rejects invalid amounts and goals without mutating saved preview data', async () => {
  const { gateway, storage, now } = fixture();
  await gateway.bootstrap();
  const before = storage.getItem(PREVIEW_STORAGE_KEY);
  await assert.rejects(
    gateway.execute(
      request({
        type: 'log.create',
        log: {
          kind: 'meal',
          title: 'Invalid',
          notes: '',
          occurredAt: now().toISOString(),
          checklist: [false, false],
          nutrition: { calories: -1 },
        },
      }),
    ),
    { code: 'VALIDATION' },
  );
  await assert.rejects(
    gateway.execute(request({ type: 'log.create', log: workout({ nutrition: { calories: 1 } }) })),
    { code: 'VALIDATION' },
  );
  await assert.rejects(
    gateway.execute(
      request({ type: 'nutrition.goals.set', goals: { calories: 0 }, expectedVersion: 0 }),
    ),
    { code: 'VALIDATION' },
  );
  assert.equal(storage.getItem(PREVIEW_STORAGE_KEY), before);
});

test('preview requires no auth, is explicitly fictional, and never advertises private media', async () => {
  const { gateway } = fixture();
  const data = await gateway.bootstrap();
  assert.equal(data.currentUserId, 'preview-you');
  assert.equal(data.profiles.length, 2);
  assert.deepEqual(data.capabilities, {
    privateMedia: false,
    accountDeletion: false,
    authoritativeScoring: false,
    nutritionTracking: true,
  });
  assert.ok(data.profiles.every((p) => p.displayName.includes('example')));
  assert.ok(
    data.logs.every((l) => l.kind !== 'body' || l.ownerId === data.currentUserId || l.shared),
  );
});
test('create, replay, reload and delete operate on persisted preview records without duplicate credit', async () => {
  const { gateway, storage, now } = fixture();
  const req = request({ type: 'log.create', log: workout() });
  const first = await gateway.execute(req);
  const again = await gateway.execute(req);
  assert.equal(first.logs.length, again.logs.length);
  assert.deepEqual(first.allTime, again.allTime);
  const reloaded = await new PreviewGateway(storage, now).bootstrap();
  const saved = reloaded.logs.find((l) => l.title === 'Test workout')!;
  assert.equal(saved.ownerId, 'preview-you');
  assert.equal(saved.createdAt, now().toISOString());
  const deleted = await gateway.execute(
    request({ type: 'log.delete', id: saved.id, expectedVersion: saved.version }),
  );
  assert.ok(!deleted.logs.some((l) => l.id === saved.id));
  assert.ok(
    deleted.allTime.find((p) => p.ownerId === 'preview-you')!.total <=
      first.allTime.find((p) => p.ownerId === 'preview-you')!.total,
  );
});
test('same request ID with changed body is rejected and stale edits cannot overwrite records', async () => {
  const { gateway } = fixture();
  const req = request({ type: 'log.create', log: workout() });
  const data = await gateway.execute(req);
  await assert.rejects(
    gateway.execute({
      ...req,
      command: { type: 'log.create', log: workout({ title: 'Different' }) },
    }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  const saved = data.logs.find((l) => l.title === 'Test workout')!;
  await gateway.execute(
    request({
      type: 'log.update',
      id: saved.id,
      expectedVersion: 1,
      log: workout({ title: 'Edited' }),
    }),
  );
  await assert.rejects(
    gateway.execute(
      request({ type: 'log.update', id: saved.id, expectedVersion: 1, log: workout() }),
    ),
    { code: 'VERSION_CONFLICT' },
  );
});
test('preview rejects partner mutations and exports only own records', async () => {
  const { gateway } = fixture();
  const data = await gateway.bootstrap();
  const partner = data.logs.find((l) => l.ownerId === 'preview-partner')!;
  await assert.rejects(
    gateway.execute(
      request({ type: 'log.delete', id: partner.id, expectedVersion: partner.version }),
    ),
    { code: 'NOT_FOUND' },
  );
  const exported = (await gateway.exportOwn()) as { preview: boolean; logs: { ownerId: string }[] };
  assert.equal(exported.preview, true);
  assert.ok(exported.logs.every((l) => l.ownerId === 'preview-you'));
});
test('drafts and meals without uploaded media earn no points; photos cannot upload in preview', async () => {
  const { gateway } = fixture();
  const original = await gateway.bootstrap();
  const draft = await gateway.execute(
    request({ type: 'log.create', log: workout({ completed: false }) }),
  );
  assert.deepEqual(draft.allTime, original.allTime);
  assert.equal(draft.logs.find((l) => l.title === 'Test workout')!.eligibility, 'draft');
  const meal = await gateway.execute(
    request({
      type: 'log.create',
      log: {
        kind: 'meal',
        title: 'Test meal',
        notes: '',
        occurredAt: '2026-10-08T15:00:00Z',
        checklist: [true, true],
      },
    }),
  );
  assert.deepEqual(meal.allTime, original.allTime);
  assert.equal(meal.logs.find((l) => l.title === 'Test meal')!.eligibility, 'unscored');
  await assert.rejects(gateway.upload(new File(['test'], 'photo.png', { type: 'image/png' })), {
    code: 'PRIVATE_MEDIA_UNAVAILABLE',
  });
});
test('sharing is explicit per body record and deleting removes values from local replay cache', async () => {
  const { gateway, storage } = fixture();
  let data = await gateway.execute(
    request({
      type: 'log.create',
      log: {
        kind: 'body',
        title: 'Unique private check-in',
        notes: 'secret-test-value',
        occurredAt: '2026-10-08T15:00:00Z',
        bodyWeight: 175,
        bodyUnit: 'lb',
      },
    }),
  );
  let body = data.logs.find((l) => l.title === 'Unique private check-in')!;
  assert.equal(body.shared, false);
  data = await gateway.execute(
    request({ type: 'body.share', id: body.id, expectedVersion: body.version, shared: true }),
  );
  body = data.logs.find((l) => l.id === body.id)!;
  assert.equal(body.shared, true);
  data = await gateway.execute(
    request({ type: 'body.share', id: body.id, expectedVersion: body.version, shared: false }),
  );
  body = data.logs.find((l) => l.id === body.id)!;
  assert.equal(body.shared, false);
  await gateway.execute(
    request({ type: 'log.delete', id: body.id, expectedVersion: body.version }),
  );
  assert.ok(!storage.getItem(PREVIEW_STORAGE_KEY)!.includes('secret-test-value'));
});
test('proposals cannot apply targets or impersonate partner approval', async () => {
  const { gateway } = fixture();
  const before = await gateway.bootstrap();
  const targets = { ...before.profiles[0].targets, strength: 7 };
  let data = await gateway.execute(request({ type: 'targets.propose', targets }));
  const proposal = data.proposals.at(-1)!;
  assert.equal(proposal.effectiveWeek, '2026-10-12');
  assert.deepEqual(proposal.approvals, ['preview-you']);
  data = await gateway.execute(request({ type: 'proposal.approve', id: proposal.id }));
  assert.equal(data.proposals.at(-1)!.status, 'pending');
  assert.deepEqual(data.profiles[0].targets, before.profiles[0].targets);
});
test('late preview corrections fail explicitly and original date survives on-time editing', async () => {
  const { gateway } = fixture();
  const before = await gateway.bootstrap();
  const old = before.logs.find((l) => l.ownerId === 'preview-you' && l.kind === 'workout')!;
  await assert.rejects(
    gateway.execute(
      request({ type: 'log.update', id: old.id, expectedVersion: old.version, log: workout() }),
    ),
    { code: 'PREVIEW_LATE_EDIT' },
  );
  let data = await gateway.execute(request({ type: 'log.create', log: workout() }));
  let log = data.logs.find((l) => l.title === 'Test workout')!;
  data = await gateway.execute(
    request({
      type: 'log.update',
      id: log.id,
      expectedVersion: log.version,
      log: workout({ occurredAt: '2026-10-08T14:00:00Z' }),
    }),
  );
  assert.equal(
    data.logs.find((l) => l.id === log.id)!.originalOccurredAt,
    '2026-10-08T15:00:00.000Z',
  );
});
test('HTTP gateway sends cookie, CSRF, idempotency and version headers without trusting a local user', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const sample = await fixture().gateway.bootstrap();
  const fetcher = (async (url: RequestInfo | URL, options: RequestInit = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(sample), {
      headers: { 'content-type': 'application/json', 'X-CSRF-Token': 'csrf-test' },
    });
  }) as typeof fetch;
  const gateway = new HttpGateway(fetcher);
  await gateway.bootstrap();
  const req = request({ type: 'log.delete', id: 'some-record', expectedVersion: 3 });
  await gateway.execute(req);
  const last = calls.at(-1)!;
  assert.equal(last.url, '/api/v1/commands');
  assert.equal(last.options.credentials, 'include');
  assert.equal(last.options.mode, 'same-origin');
  const headers = new Headers(last.options.headers);
  assert.equal(headers.get('X-CSRF-Token'), 'csrf-test');
  assert.equal(headers.get('Idempotency-Key'), req.requestId);
  assert.equal(headers.get('If-Match'), '"3"');
  assert.deepEqual(JSON.parse(String(last.options.body)), req);
});
test('HTTP failure never becomes a simulated success; missing CSRF prevents a mutation', async () => {
  const unauthorized = new HttpGateway(
    (async () => new Response('{}', { status: 401 })) as typeof fetch,
  );
  await assert.rejects(unauthorized.bootstrap(), { code: 'UNAUTHENTICATED', status: 401 });
  let calls = 0;
  const gateway = new HttpGateway((async () => {
    calls++;
    return new Response('{}');
  }) as typeof fetch);
  await assert.rejects(gateway.execute(request({ type: 'competition.agree' })), {
    code: 'CSRF_UNAVAILABLE',
  });
  assert.equal(calls, 1);
  assert.throws(() => new HttpGateway(globalThis.fetch, 'https://outside.example/api'));
});

test('uncertain image-upload retries retain a stable request key and HEIC has a clear fallback', async () => {
  const keys: string[] = [];
  let uploads = 0;
  const sample = await fixture().gateway.bootstrap();
  const gateway = new HttpGateway((async (url: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(url).endsWith('/bootstrap'))
      return new Response(JSON.stringify(sample), { headers: { 'X-CSRF-Token': 'test-csrf' } });
    keys.push(new Headers(init.headers).get('Idempotency-Key')!);
    uploads++;
    if (uploads === 1) throw new Error('uncertain network response');
    return new Response(JSON.stringify({ mediaId: 'private-file-id' }));
  }) as typeof fetch);
  const file = new File(['image-bytes'], 'selected.png', { type: 'image/png' });
  await assert.rejects(gateway.upload(file), { code: 'NETWORK_ERROR' });
  assert.deepEqual(await gateway.upload(file), { mediaId: 'private-file-id' });
  assert.equal(keys[0], keys[1]);
  await assert.rejects(
    gateway.upload(new File(['data'], 'selected.heic', { type: 'image/heic' })),
    { code: 'IMAGE_FORMAT' },
  );
});
