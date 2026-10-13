import test from 'node:test';
import assert from 'node:assert/strict';
import type { Competition, LogKind, LogRecord, Targets } from './contracts.ts';
import { calculatePreviewWeek, evaluateEligibility } from './scoring.ts';

const targets: Targets = {
  strength: 3,
  cardio: 2,
  waterMl: 2_000,
  cardioMinimumMinutes: 20,
  cardioActivity: 'Walking',
};
const competition: Competition = {
  id: 'duo',
  name: 'Test only',
  startDate: '2026-10-05',
  timezone: 'America/New_York',
  rulesVersion: 'v1',
  agreedBy: ['one', 'two'],
  mealChecklist: ['Protein source', 'Fiber-rich food'],
};
const now = '2026-10-15T12:00:00.000Z';
function record(id: string, kind: LogKind, day = '05', extra: Partial<LogRecord> = {}): LogRecord {
  const at = `2026-10-${day}T16:00:00.000Z`;
  return {
    id,
    kind,
    ownerId: 'one',
    title: kind,
    notes: '',
    occurredAt: at,
    originalOccurredAt: at,
    createdAt: at,
    version: 1,
    eligibility: 'eligible',
    completed: true,
    sets: [{ exercise: 'Squat', equipment: 'Barbell', repetitions: 5, load: 40, unit: 'kg' }],
    activity: 'Walking',
    durationMinutes: 20,
    water: 2,
    waterUnit: 'L',
    mediaId: `image-${id}`,
    checklist: [true, true],
    ...extra,
  };
}
function score(logs: LogRecord[], settings = targets) {
  return calculatePreviewWeek(logs, 'one', '2026-10-05', settings, competition, now);
}
const eligibleInput = {
  occurredAt: '2026-10-05T16:00:00.000Z',
  originalOccurredAt: '2026-10-05T16:00:00.000Z',
  createdAt: '2026-10-07T16:00:00.000Z',
  now: '2026-10-07T16:00:00.000Z',
  competitionStart: '2026-10-05',
};

test('48-hour entry cutoff includes the exact deadline and excludes one millisecond later', () => {
  assert.equal(evaluateEligibility(eligibleInput).status, 'eligible');
  assert.equal(evaluateEligibility(eligibleInput).canIncrease, true);
  const late = evaluateEligibility({
    ...eligibleInput,
    createdAt: '2026-10-07T16:00:00.001Z',
    now: '2026-10-07T16:00:00.001Z',
  });
  assert.equal(late.status, 'historical');
  assert.equal(late.canIncrease, false);
});

test('elapsed 48-hour window stays exact through spring DST', () => {
  const result = evaluateEligibility({
    occurredAt: '2026-03-07T12:00:00-05:00',
    createdAt: '2026-03-09T13:00:00-04:00',
    now: '2026-03-09T17:00:00Z',
    competitionStart: '2026-03-02',
  });
  assert.equal(result.status, 'eligible');
  assert.equal(result.deadline, '2026-03-09T17:00:00.000Z');
});

test('future, pre-start, and invalid activity times are rejected', () => {
  assert.equal(
    evaluateEligibility({ ...eligibleInput, occurredAt: '2026-10-08T16:00:00Z' }).status,
    'rejected',
  );
  assert.equal(
    evaluateEligibility({ ...eligibleInput, occurredAt: '2026-10-05T03:59:59.999Z' }).status,
    'rejected',
  );
  assert.equal(
    evaluateEligibility({ ...eligibleInput, occurredAt: 'not a date' }).status,
    'rejected',
  );
  assert.equal(
    evaluateEligibility({ ...eligibleInput, createdAt: '2026-10-04T16:00:00Z' }).status,
    'rejected',
  );
});

test('changing an activity date does not restart the original deadline', () => {
  const result = evaluateEligibility({
    ...eligibleInput,
    occurredAt: '2026-10-07T16:00:00Z',
    now: '2026-10-08T16:00:00Z',
  });
  assert.equal(result.status, 'eligible');
  assert.equal(result.deadline, '2026-10-07T16:00:00.000Z');
  assert.equal(result.canIncrease, false);
  const historical = evaluateEligibility({
    ...eligibleInput,
    occurredAt: '2026-10-09T16:00:00Z',
    createdAt: '2026-10-09T16:00:00Z',
    now: '2026-10-09T16:00:00Z',
  });
  assert.equal(historical.status, 'historical');
});

test('draft, historical, unscored, other-owner and body records earn no consistency points', () => {
  const logs = [
    record('draft', 'workout', '05', { completed: false }),
    record('draft-flag', 'workout', '05', { eligibility: 'draft' }),
    record('historical', 'workout', '06', { eligibility: 'historical' }),
    record('late', 'workout', '06', { createdAt: '2026-10-09T16:00:00Z' }),
    record('unscored', 'meal', '07', { eligibility: 'unscored' }),
    record('friend', 'workout', '07', { ownerId: 'two' }),
    record('body', 'body', '08', { bodyWeight: 80, bodyUnit: 'kg', shared: true }),
  ];
  assert.equal(score(logs).points.total, 0);
});

test('daily counting and target caps prevent unlimited repeat points', () => {
  const logs: LogRecord[] = [];
  for (let day = 5; day <= 11; day += 1) {
    for (const kind of ['workout', 'cardio', 'meal', 'hydration'] as const) {
      logs.push(record(`${kind}-${day}`, kind, String(day).padStart(2, '0')));
      logs.push(record(`${kind}-${day}-extra`, kind, String(day).padStart(2, '0'), { water: 100 }));
    }
  }
  const result = score(logs);
  assert.deepEqual(result.days, { strength: 7, meals: 7, cardio: 7, hydration: 7 });
  assert.deepEqual(result.points, {
    strength: 40,
    meals: 25,
    cardio: 15,
    hydration: 10,
    improvement: 0,
    total: 90,
  });
});

test('same-day strength and cardio both count when separately logged', () => {
  const result = score([record('strength', 'workout'), record('endurance', 'cardio')]);
  assert.equal(result.days.strength, 1);
  assert.equal(result.days.cardio, 1);
});

test('partial-week arithmetic preserves precision until presentation', () => {
  const result = score([
    record('s1', 'workout', '05'),
    record('s2', 'workout', '06'),
    ...['05', '06', '07'].map((day) => record(`m${day}`, 'meal', day)),
    record('c1', 'cardio'),
    ...['05', '06', '07', '08'].map((day) => record(`h${day}`, 'hydration', day)),
  ]);
  assert.equal(result.points.strength, 40 * (2 / 3));
  assert.equal(result.points.total.toFixed(2), '54.88');
  assert.notEqual(result.points.total, 54.88);
});

test('duplicate submissions and latest versions cannot double-count', () => {
  const workout = record('same', 'workout');
  assert.equal(score([workout, { ...workout }]).days.strength, 1);
  const corrected = { ...workout, version: 2, completed: false };
  assert.equal(score([workout, corrected, corrected]).points.total, 0);
  assert.equal(score([corrected, workout]).points.total, 0);
  assert.equal(score([workout, { ...workout, completed: false }]).points.total, 0);
});

test('deletion removes contribution on recomputation', () => {
  const entries = [record('remove', 'workout'), record('keep', 'workout', '06')];
  assert.equal(score(entries).days.strength, 2);
  assert.equal(score(entries.filter((entry) => entry.id !== 'remove')).days.strength, 1);
});

test('meals require selected media and every agreed self-reported condition', () => {
  assert.equal(score([record('no-photo', 'meal', '05', { mediaId: undefined })]).days.meals, 0);
  assert.equal(
    score([record('unchecked', 'meal', '05', { checklist: [true, false] })]).days.meals,
    0,
  );
  const reused = [
    record('first', 'meal', '05', { mediaId: 'same-photo' }),
    record('reuse', 'meal', '06', { mediaId: 'same-photo' }),
  ];
  assert.equal(score(reused).days.meals, 1);
  assert.equal(score([...reused].reverse()).days.meals, 1);
  const nextWeek = record('again', 'meal', '12', { mediaId: 'same-photo' });
  assert.equal(
    calculatePreviewWeek([...reused, nextWeek], 'one', '2026-10-12', targets, competition, now).days
      .meals,
    0,
  );
});

test('cardio respects the agreed activity and minimum, independent of entered steps', () => {
  const result = score([
    record('short', 'cardio', '05', { durationMinutes: 19, steps: 20_000 }),
    record('other', 'cardio', '06', { activity: 'Cycling' }),
    record('match', 'cardio', '07', { activity: ' walking ', durationMinutes: 20 }),
  ]);
  assert.equal(result.days.cardio, 1);
});

test('hydration converts units, caps daily credit and uses latest entered daily total', () => {
  assert.equal(
    score([record('h', 'hydration', '05', { water: 2, waterUnit: 'L' })]).days.hydration,
    1,
  );
  assert.equal(
    score([record('h', 'hydration', '05', { water: 64, waterUnit: 'fl oz' })]).days.hydration,
    0,
  );
  const older = record('old', 'hydration', '05', { water: 3 });
  const newer = record('new', 'hydration', '05', { water: 1, createdAt: '2026-10-05T17:00:00Z' });
  assert.equal(score([older, newer]).days.hydration, 0);
  assert.equal(score([newer, older]).days.hydration, 0);
});

test('week end is exclusive, start inclusive; finalization waits 48 elapsed hours', () => {
  const monday = record('monday', 'workout', '12', {
    occurredAt: '2026-10-12T04:00:00Z',
    originalOccurredAt: '2026-10-12T04:00:00Z',
  });
  assert.equal(score([monday]).points.total, 0);
  const before = calculatePreviewWeek(
    [],
    'one',
    '2026-10-05',
    targets,
    competition,
    '2026-10-14T03:59:59.999Z',
  );
  const after = calculatePreviewWeek(
    [],
    'one',
    '2026-10-05',
    targets,
    competition,
    '2026-10-14T04:00:00Z',
  );
  assert.equal(before.provisional, true);
  assert.equal(after.provisional, false);
});

test('invalid targets fail explicitly instead of producing Infinity or NaN', () => {
  assert.throws(() => score([], { ...targets, strength: 0 }), /1 to 7/);
  assert.throws(() => score([], { ...targets, cardio: 8 }), /1 to 7/);
  assert.throws(() => score([], { ...targets, waterMl: 0 }), /Water target/);
});
