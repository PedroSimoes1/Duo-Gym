import test from 'node:test';
import assert from 'node:assert/strict';
import type { LogRecord } from './contracts.ts';
import { nutritionGoalsForDate, summarizeNutrition, validateNutrition } from './nutrition.ts';

const tz = 'America/New_York';
function meal(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    id: 'meal-1',
    ownerId: 'me',
    kind: 'meal',
    version: 1,
    title: 'Sample meal',
    notes: '',
    occurredAt: '2026-10-08T15:00:00Z',
    createdAt: '2026-10-08T15:00:00Z',
    originalOccurredAt: '2026-10-08T15:00:00Z',
    eligibility: 'unscored',
    checklist: [false, false],
    ...overrides,
  };
}
test('nutrition distinguishes unknown from explicit zero, never infers calories', () => {
  const summary = summarizeNutrition(
    [meal({ nutrition: { protein: 12.5, fat: 0 } })],
    'me',
    '2026-10-08',
    tz,
  );
  assert.equal(summary.totals.calories, 0);
  assert.equal(summary.recorded.calories, 0);
  assert.equal(summary.recorded.fat, 1);
  assert.equal(summary.totals.protein, 12.5);
  assert.equal(summary.missingMeals, 1);
  assert.deepEqual(validateNutrition({ calories: 0, sodium: 0 }), { calories: 0, sodium: 0 });
});
test('nutrition validates negative, nonfinite, unknown fields and optional positive goals', () => {
  for (const invalid of [
    null,
    [],
    { calories: -1 },
    { fat: Infinity },
    { protein: NaN },
    { calories: '10' },
    { points: 50 },
    { sodium: 100001 },
  ])
    assert.throws(() => validateNutrition(invalid));
  assert.throws(() => validateNutrition({ calories: 0 }, true));
  assert.throws(() => validateNutrition({ sodium: 500 }, true));
  assert.deepEqual(validateNutrition({}, true), {});
  assert.deepEqual(validateNutrition({ calories: 1800, protein: 100 }, true), {
    calories: 1800,
    protein: 100,
  });
});
test('nutrition totals isolate people and calendar days, retain unscored and historical meals', () => {
  const logs = [
    meal({ nutrition: { calories: 100, protein: 10, carbs: 12.5, fat: 3 } }),
    meal({ id: 'historical', eligibility: 'historical', nutrition: { calories: 200.25 } }),
    meal({ id: 'partner', ownerId: 'friend', nutrition: { calories: 999 } }),
    meal({ id: 'yesterday', occurredAt: '2026-10-08T03:59:59Z', nutrition: { calories: 888 } }),
    meal({ id: 'draft', eligibility: 'draft', nutrition: { calories: 777 } }),
    meal({ id: 'body', kind: 'body', nutrition: { calories: 666 } }),
  ];
  const summary = summarizeNutrition(logs, 'me', '2026-10-08', tz);
  assert.equal(summary.totals.calories, 300.25);
  assert.equal(summary.mealCount, 2);
  assert.equal(summary.missingMeals, 1);
  assert.equal(summarizeNutrition(logs, 'friend', '2026-10-08', tz).totals.calories, 999);
});
test('nutrition uses New York dates at UTC midnight and both DST transitions', () => {
  const logs = [
    meal({ id: 'midnight', occurredAt: '2026-11-01T04:00:00Z', nutrition: { calories: 10 } }),
    meal({ id: 'repeat1', occurredAt: '2026-11-01T05:30:00Z', nutrition: { calories: 20 } }),
    meal({ id: 'repeat2', occurredAt: '2026-11-01T06:30:00Z', nutrition: { calories: 30 } }),
    meal({ id: 'end', occurredAt: '2026-11-02T04:59:59Z', nutrition: { calories: 40 } }),
    meal({ id: 'next', occurredAt: '2026-11-02T05:00:00Z', nutrition: { calories: 50 } }),
    meal({ id: 'spring1', occurredAt: '2026-03-08T06:59:59Z', nutrition: { calories: 60 } }),
    meal({ id: 'spring2', occurredAt: '2026-03-08T07:00:00Z', nutrition: { calories: 70 } }),
  ];
  assert.equal(summarizeNutrition(logs, 'me', '2026-11-01', tz).totals.calories, 100);
  assert.equal(summarizeNutrition(logs, 'me', '2026-03-08', tz).totals.calories, 130);
});
test('latest meal version replaces prior nutrition and date; deletion removes totals', () => {
  const first = meal({ nutrition: { calories: 600 } });
  const edited = meal({ version: 2, nutrition: { calories: 400 } });
  assert.equal(
    summarizeNutrition([first, edited, first], 'me', '2026-10-08', tz).totals.calories,
    400,
  );
  const moved = meal({
    version: 3,
    occurredAt: '2026-10-07T15:00:00Z',
    nutrition: { calories: 400 },
  });
  assert.equal(summarizeNutrition([first, edited, moved], 'me', '2026-10-08', tz).mealCount, 0);
  assert.equal(summarizeNutrition([], 'me', '2026-10-08', tz).recorded.calories, 0);
});
test('nutrition goals carry forward by effective date without changing prior days', () => {
  const history = [
    { effectiveDate: '2026-10-09', goals: { calories: 2000 } },
    { effectiveDate: '2026-10-08', goals: { calories: 1800, protein: 100 } },
    { effectiveDate: '2026-10-11', goals: {} },
  ];
  assert.deepEqual(nutritionGoalsForDate(history, '2026-10-07'), {});
  assert.deepEqual(nutritionGoalsForDate(history, '2026-10-08'), { calories: 1800, protein: 100 });
  assert.deepEqual(nutritionGoalsForDate(history, '2026-10-10'), { calories: 2000 });
  assert.deepEqual(nutritionGoalsForDate(history, '2026-10-12'), {});
  assert.deepEqual(nutritionGoalsForDate(undefined, '2026-10-08'), {});
});
