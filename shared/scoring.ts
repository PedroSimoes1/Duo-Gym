import type { Competition, LogRecord, Targets, WeeklyScore } from './contracts.ts';
import {
  dateKey,
  DEFAULT_TIMEZONE,
  HOUR_MS,
  startOfDate,
  timestampMs,
  weekBounds,
} from './time.ts';
import { waterToMl } from './units.ts';

export interface EligibilityInput {
  occurredAt: string;
  originalOccurredAt?: string;
  createdAt: string;
  now?: string;
  competitionStart: string;
  timezone?: string;
  completed?: boolean;
}
export interface EligibilityResult {
  status: 'eligible' | 'historical' | 'draft' | 'rejected';
  reason: string;
  deadline: string | null;
  canIncrease: boolean;
}

/**
 * Reference only: creation/original timestamps must come from the backend in production.
 * canIncrease describes the edit deadline, not permission to write an award.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  let activity: number, original: number, created: number, now: number, start: number;
  try {
    activity = timestampMs(input.occurredAt);
    original = timestampMs(input.originalOccurredAt ?? input.occurredAt);
    created = timestampMs(input.createdAt);
    now = timestampMs(input.now ?? new Date().toISOString());
    start = /^\d{4}-\d{2}-\d{2}$/.test(input.competitionStart)
      ? timestampMs(startOfDate(input.competitionStart, input.timezone ?? DEFAULT_TIMEZONE))
      : timestampMs(input.competitionStart);
  } catch {
    return {
      status: 'rejected',
      reason: 'Invalid date or timezone.',
      deadline: null,
      canIncrease: false,
    };
  }
  const cutoff = original + 48 * HOUR_MS;
  const deadline = new Date(cutoff).toISOString();
  const rejected = (reason: string): EligibilityResult => ({
    status: 'rejected',
    reason,
    deadline,
    canIncrease: false,
  });
  if (activity > now || original > now) return rejected('Future activity times are not allowed.');
  if (created > now) return rejected('Creation time is later than the trusted current time.');
  if (original > created)
    return rejected('Original activity time cannot follow its creation time.');
  if (activity < start || original < start)
    return rejected('Activity is before the agreed competition start.');
  if (input.completed === false)
    return { status: 'draft', reason: 'Drafts earn no points.', deadline, canIncrease: false };
  if (created > cutoff || created - activity > 48 * HOUR_MS) {
    return {
      status: 'historical',
      reason: 'Recorded after the 48-hour entry window; no points or benchmark credit.',
      deadline,
      canIncrease: false,
    };
  }
  return {
    status: 'eligible',
    reason:
      now <= cutoff
        ? 'Within the original 48-hour correction window.'
        : 'Saved on time; later corrections may only reduce awards.',
    deadline,
    canIncrease: now <= cutoff,
  };
}

function validateTargets(targets: Targets): void {
  for (const value of [targets.strength, targets.cardio]) {
    if (!Number.isInteger(value) || value < 1 || value > 7)
      throw new RangeError('Weekly day targets must be integers from 1 to 7.');
  }
  if (!Number.isFinite(targets.waterMl) || targets.waterMl <= 0)
    throw new RangeError('Water target must be positive.');
  if (
    !Number.isFinite(targets.cardioMinimumMinutes) ||
    targets.cardioMinimumMinutes <= 0 ||
    !targets.cardioActivity.trim()
  ) {
    throw new RangeError('Cardio qualification requires an activity and positive duration.');
  }
}

/** A repeated record is counted once. Conflicting copies of one version fail closed. */
function canonicalLogs(logs: LogRecord[]): LogRecord[] {
  const groups = new Map<string, LogRecord[]>();
  for (const log of logs) {
    const key = `${log.ownerId}\u0000${log.id}`;
    groups.set(key, [...(groups.get(key) ?? []), log]);
  }
  return [...groups.values()].flatMap((versions) => {
    const latestVersion = Math.max(...versions.map((log) => log.version));
    const latest = versions.filter((log) => log.version === latestVersion);
    const first = latest[0];
    if (!first || latest.some((log) => JSON.stringify(log) !== JSON.stringify(first))) return [];
    return [first];
  });
}

function validWorkout(log: LogRecord): boolean {
  return (
    log.completed === true &&
    !!log.sets?.some(
      (set) =>
        !!set.exercise.trim() &&
        !!set.equipment.trim() &&
        Number.isInteger(set.repetitions) &&
        set.repetitions > 0 &&
        Number.isFinite(set.load) &&
        set.load >= 0 &&
        ['lb', 'kg'].includes(set.unit),
    )
  );
}

function validMeal(log: LogRecord, competition: Competition): boolean {
  return (
    !!log.mediaId &&
    competition.mealChecklist.length > 0 &&
    competition.mealChecklist.every((_, index) => log.checklist?.[index] === true)
  );
}

/**
 * LOCAL PREVIEW ONLY. No authoritative awards, benchmark implementation, or frozen corrections.
 * Production must use server snapshots and its own reduction-only historical award ledger.
 * An existing server eligibility value can remove eligibility but cannot create it here.
 */
export function calculatePreviewWeek(
  logs: LogRecord[],
  ownerId: string,
  week: string,
  targets: Targets,
  competition: Competition,
  now = new Date().toISOString(),
): WeeklyScore {
  validateTargets(targets);
  const bounds = weekBounds(week, competition.timezone);
  const start = timestampMs(bounds.start);
  const end = timestampMs(bounds.end);
  const clock = timestampMs(now);
  const strength = new Set<string>();
  const meals = new Set<string>();
  const cardio = new Set<string>();
  const hydration = new Set<string>();
  const waterByDay = new Map<string, LogRecord>();
  const eligible = canonicalLogs(logs).filter(
    (log) =>
      log.ownerId === ownerId &&
      log.eligibility === 'eligible' &&
      evaluateEligibility({
        occurredAt: log.occurredAt,
        originalOccurredAt: log.originalOccurredAt,
        createdAt: log.createdAt,
        now,
        competitionStart: competition.startDate,
        timezone: competition.timezone,
        completed: log.kind === 'workout' ? log.completed : undefined,
      }).status === 'eligible',
  );

  // Block reuse of the same file reference, including on a later week. A backend must
  // additionally compare content hashes; new IDs can refer to identical photo bytes.
  const firstMealByMedia = new Map<string, string>();
  for (const log of [...eligible].sort(
    (a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    if (
      log.kind === 'meal' &&
      validMeal(log, competition) &&
      log.mediaId &&
      !firstMealByMedia.has(log.mediaId)
    ) {
      firstMealByMedia.set(log.mediaId, log.id);
    }
  }

  for (const log of eligible) {
    const at = timestampMs(log.occurredAt);
    if (at < start || at >= end) continue;
    const day = dateKey(log.occurredAt, competition.timezone);
    if (log.kind === 'workout' && validWorkout(log)) strength.add(day);
    if (
      log.kind === 'meal' &&
      validMeal(log, competition) &&
      firstMealByMedia.get(log.mediaId!) === log.id
    )
      meals.add(day);
    if (
      log.kind === 'cardio' &&
      log.activity?.trim().toLowerCase() === targets.cardioActivity.trim().toLowerCase() &&
      Number.isFinite(log.durationMinutes) &&
      log.durationMinutes! >= targets.cardioMinimumMinutes
    )
      cardio.add(day);
    if (log.kind === 'hydration') {
      const previous = waterByDay.get(day);
      if (
        !previous ||
        timestampMs(log.createdAt) > timestampMs(previous.createdAt) ||
        (timestampMs(log.createdAt) === timestampMs(previous.createdAt) &&
          log.id.localeCompare(previous.id) > 0)
      ) {
        waterByDay.set(day, log);
      }
    }
  }
  for (const [day, log] of waterByDay) {
    try {
      if (
        log.water !== undefined &&
        log.waterUnit &&
        waterToMl(log.water, log.waterUnit) >= targets.waterMl
      )
        hydration.add(day);
    } catch {
      /* Invalid quantities cannot contribute to a preview score. */
    }
  }
  const points = {
    strength: 40 * Math.min(strength.size / targets.strength, 1),
    meals: 25 * Math.min(meals.size / 5, 1),
    cardio: 15 * Math.min(cardio.size / targets.cardio, 1),
    hydration: 10 * Math.min(hydration.size / 7, 1),
    improvement: 0,
    total: 0,
  };
  points.total =
    points.strength + points.meals + points.cardio + points.hydration + points.improvement;
  return {
    week,
    ownerId,
    points,
    days: {
      strength: strength.size,
      meals: meals.size,
      cardio: cardio.size,
      hydration: hydration.size,
    },
    targets: { ...targets },
    provisional: clock < end + 48 * HOUR_MS,
  };
}
