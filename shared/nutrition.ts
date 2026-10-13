import type {
  LogRecord,
  NutrientKey,
  NutritionValues,
  NutritionGoalKey,
  NutritionGoals,
  NutritionGoalSnapshot,
} from './contracts.ts';
import { dateKey } from './time.ts';

// These are input-sanity limits, not nutritional advice or suggested goals.
export const nutritionFields: readonly {
  key: NutrientKey;
  label: string;
  unit: string;
  max: number;
}[] = [
  { key: 'calories', label: 'Calories', unit: 'kcal', max: 100000 },
  { key: 'protein', label: 'Protein', unit: 'g', max: 10000 },
  { key: 'carbs', label: 'Carbs', unit: 'g', max: 10000 },
  { key: 'fat', label: 'Fat', unit: 'g', max: 10000 },
  { key: 'fiber', label: 'Fiber', unit: 'g', max: 10000 },
  { key: 'sugar', label: 'Sugar', unit: 'g', max: 10000 },
  { key: 'sodium', label: 'Sodium', unit: 'mg', max: 100000 },
];
export const goalKeys: readonly NutritionGoalKey[] = [
  'calories',
  'protein',
  'carbs',
  'fat',
  'fiber',
];
const coreKeys: readonly NutrientKey[] = ['calories', 'protein', 'carbs', 'fat'];

/** Missing values remain unknown; explicit zero is a recorded amount. */
export function validateNutrition(value: unknown, goals = false): NutritionValues {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RangeError('Nutrition values must be an object.');
  const result: NutritionValues = {};
  for (const [key, amount] of Object.entries(value)) {
    const field = nutritionFields.find((item) => item.key === key);
    if (!field || (goals && !goalKeys.includes(field.key as NutritionGoalKey)))
      throw new RangeError('Unsupported nutrition field.');
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      (goals && amount === 0) ||
      amount > field.max
    )
      throw new RangeError(
        `${field.label} must be ${goals ? 'greater than zero' : 'zero or more'} and at most ${field.max} ${field.unit}.`,
      );
    result[field.key] = amount;
  }
  return result;
}

export function nutritionGoalsForDate(
  history: NutritionGoalSnapshot[] | undefined,
  day: string,
): NutritionGoals {
  const selected = (history ?? [])
    .filter((entry) => entry.effectiveDate <= day)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
  return selected ? { ...selected.goals } : {};
}

function emptyTotals(): Record<NutrientKey, number> {
  return { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
}

/** Totals are descriptive, never awards. Historical/unscored meals still contribute. */
export function summarizeNutrition(
  logs: LogRecord[],
  ownerId: string,
  day: string,
  timezone: string,
) {
  const totals = emptyTotals();
  const recorded = emptyTotals();
  const latest = new Map<string, LogRecord>();
  for (const log of logs) {
    const prior = latest.get(log.id);
    if (!prior || log.version > prior.version) latest.set(log.id, log);
  }
  let mealCount = 0;
  let missingMeals = 0;
  for (const log of latest.values()) {
    if (
      log.ownerId !== ownerId ||
      log.kind !== 'meal' ||
      log.eligibility === 'draft' ||
      dateKey(log.occurredAt, timezone) !== day
    )
      continue;
    mealCount++;
    const amounts = log.nutrition ?? {};
    if (coreKeys.some((key) => amounts[key] === undefined)) missingMeals++;
    for (const field of nutritionFields) {
      const amount = amounts[field.key];
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
        totals[field.key] += amount;
        recorded[field.key]++;
      }
    }
  }
  return { totals, recorded, mealCount, missingMeals };
}
