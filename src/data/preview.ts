import type {
  AuditEntry,
  Bootstrap,
  Command,
  CommandEnvelope,
  Competition,
  LogInput,
  LogRecord,
  Profile,
  Targets,
  WorkoutTemplate,
} from '../../shared/contracts.ts';
import { dateKey, nextMonday, weekBounds, weekKey } from '../../shared/time.ts';
import { calculatePreviewWeek } from '../../shared/scoring.ts';
import { validateNutrition } from '../../shared/nutrition.ts';
import { GatewayError } from './http.ts';
import type { Gateway } from './http.ts';

export const previewInfo =
  'Local preview with fictional accounts. Saved only in this browser, without login or server privacy. Do not enter personal health data. Photos and improvement bonuses are unavailable until the backend is connected.';
export const PREVIEW_STORAGE_KEY = 'gym-progress-duo.preview.v1';
const YOU = 'preview-you';
const PARTNER = 'preview-partner';
const DAY = 86_400_000;
const WINDOW = 48 * 60 * 60 * 1000;

export interface PreviewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type PrivateAudit = AuditEntry & { privateOwner?: string };
interface PreviewState {
  schemaVersion: 1;
  profiles: Profile[];
  competition: Competition;
  logs: LogRecord[];
  templates: WorkoutTemplate[];
  proposals: Bootstrap['proposals'];
  audit: PrivateAudit[];
  requests: Record<string, { fingerprint: string }>;
}

function memoryStorage(): PreviewStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function browserStorage(): PreviewStorage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* Restricted browsing can disable local storage. */
  }
  return memoryStorage();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${fingerprint(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function requestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(fingerprint(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function id(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}
function requireThat(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new GatewayError(code, message, status);
}
function numberBetween(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): asserts value is number {
  requireThat(
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum,
    'VALIDATION',
    `${name} must be between ${minimum} and ${maximum}.`,
  );
}
function text(value: unknown, max: number, name: string, required = true): asserts value is string {
  requireThat(
    typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0),
    'VALIDATION',
    `${name} is required and must be at most ${max} characters.`,
  );
}
function validateSets(sets: LogInput['sets']): asserts sets is NonNullable<LogInput['sets']> {
  requireThat(
    Array.isArray(sets) && sets.length > 0 && sets.length <= 100,
    'VALIDATION',
    'Add 1–100 exercise sets.',
  );
  for (const set of sets) {
    text(set.exercise, 100, 'Exercise');
    text(set.equipment, 100, 'Equipment or variation');
    numberBetween(set.repetitions, 1, 200, 'Repetitions');
    requireThat(
      Number.isInteger(set.repetitions),
      'VALIDATION',
      'Repetitions must be a whole number.',
    );
    numberBetween(set.load, 0, 2000, 'Load');
    requireThat(['kg', 'lb'].includes(set.unit), 'VALIDATION', 'Choose kg or lb.');
  }
}
function validateTargets(targets: Targets): Targets {
  numberBetween(targets.strength, 1, 7, 'Strength days');
  numberBetween(targets.cardio, 1, 7, 'Cardio days');
  requireThat(
    Number.isInteger(targets.strength) && Number.isInteger(targets.cardio),
    'VALIDATION',
    'Weekly targets must be whole days.',
  );
  numberBetween(targets.waterMl, 1, 10000, 'Hydration target');
  numberBetween(targets.cardioMinimumMinutes, 1, 1440, 'Qualifying cardio minutes');
  text(targets.cardioActivity, 100, 'Cardio activity');
  return {
    strength: targets.strength,
    cardio: targets.cardio,
    waterMl: targets.waterMl,
    cardioMinimumMinutes: targets.cardioMinimumMinutes,
    cardioActivity: targets.cardioActivity.trim(),
  };
}

function sanitizeLog(
  input: LogInput,
  competition: Competition,
  now: Date,
  existing?: LogRecord,
): LogInput {
  requireThat(
    ['workout', 'cardio', 'meal', 'hydration', 'body'].includes(input.kind),
    'VALIDATION',
    'Choose a supported log type.',
  );
  text(input.title, 120, 'Title');
  text(input.notes, 3000, 'Notes', false);
  const activityTime = Date.parse(input.occurredAt);
  requireThat(
    Number.isFinite(activityTime) && /(?:Z|[+-]\d{2}:\d{2})$/.test(input.occurredAt),
    'VALIDATION',
    'Choose a valid date and time.',
  );
  requireThat(
    activityTime <= now.getTime(),
    'FUTURE_ACTIVITY',
    'Future activities cannot be saved.',
  );
  if (input.kind !== 'body')
    requireThat(
      activityTime >= Date.parse(weekBounds(competition.startDate, competition.timezone).start),
      'BEFORE_START',
      'Competition logs must be on or after the agreed start date.',
    );
  requireThat(
    !existing || input.kind === existing.kind,
    'VALIDATION',
    'A saved log cannot change its type.',
  );
  requireThat(
    !input.mediaId || input.mediaId === existing?.mediaId,
    'PRIVATE_MEDIA_UNAVAILABLE',
    'Photo uploads are unavailable in the local preview. Connect private backend storage first.',
  );
  const result: LogInput = {
    kind: input.kind,
    title: input.title.trim(),
    notes: input.notes.trim(),
    occurredAt: new Date(activityTime).toISOString(),
  };
  requireThat(
    input.nutrition === undefined || input.kind === 'meal',
    'VALIDATION',
    'Nutrition belongs to meal records only.',
  );
  if (input.kind === 'workout') {
    validateSets(input.sets);
    result.completed = input.completed === true;
    result.sets = input.sets.map((set) => ({
      exercise: set.exercise.trim(),
      equipment: set.equipment.trim(),
      repetitions: set.repetitions,
      load: set.load,
      unit: set.unit,
    }));
  }
  if (input.kind === 'cardio') {
    text(input.activity, 100, 'Activity');
    numberBetween(input.durationMinutes, 0.1, 1440, 'Duration');
    result.activity = input.activity.trim();
    result.durationMinutes = input.durationMinutes;
    if (input.distance !== undefined) {
      numberBetween(input.distance, 0, 10000, 'Distance');
      requireThat(
        ['km', 'mi'].includes(input.distanceUnit ?? ''),
        'VALIDATION',
        'Choose a distance unit.',
      );
      result.distance = input.distance;
      result.distanceUnit = input.distanceUnit;
    }
    if (input.steps !== undefined) {
      numberBetween(input.steps, 0, 200000, 'Steps');
      requireThat(Number.isInteger(input.steps), 'VALIDATION', 'Steps must be a whole number.');
      result.steps = input.steps;
    }
  }
  if (input.kind === 'meal') {
    requireThat(
      Array.isArray(input.checklist) &&
        input.checklist.length === competition.mealChecklist.length &&
        input.checklist.every((item) => typeof item === 'boolean'),
      'VALIDATION',
      'Confirm each agreed meal checklist item.',
    );
    result.checklist = [...input.checklist];
    if (input.nutrition !== undefined) {
      try {
        result.nutrition = validateNutrition(input.nutrition);
      } catch (error) {
        throw new GatewayError(
          'VALIDATION',
          error instanceof Error ? error.message : 'Check nutrition amounts.',
        );
      }
    }
    if (input.mediaId) result.mediaId = input.mediaId;
  }
  if (input.kind === 'hydration') {
    numberBetween(input.water, 0, 10000, 'Daily water total');
    requireThat(
      ['ml', 'L', 'fl oz'].includes(input.waterUnit ?? ''),
      'VALIDATION',
      'Choose a water unit.',
    );
    const ml =
      input.water! *
      (input.waterUnit === 'L' ? 1000 : input.waterUnit === 'fl oz' ? 29.5735295625 : 1);
    requireThat(
      ml <= 10000,
      'VALIDATION',
      'Double-check the total and units; the form accepts up to 10,000 ml.',
    );
    result.water = input.water;
    result.waterUnit = input.waterUnit;
  }
  if (input.kind === 'body') {
    requireThat(
      input.bodyWeight !== undefined || input.waist !== undefined,
      'VALIDATION',
      'Enter a weight or measurement. Photos are unavailable in this preview.',
    );
    if (input.bodyWeight !== undefined) {
      numberBetween(input.bodyWeight, 0.1, 2000, 'Body weight');
      requireThat(
        ['kg', 'lb'].includes(input.bodyUnit ?? ''),
        'VALIDATION',
        'Choose a body weight unit.',
      );
      result.bodyWeight = input.bodyWeight;
      result.bodyUnit = input.bodyUnit;
    }
    if (input.waist !== undefined) {
      numberBetween(input.waist, 0.1, 1000, 'Measurement');
      requireThat(
        ['cm', 'in'].includes(input.measurementUnit ?? ''),
        'VALIDATION',
        'Choose a measurement unit.',
      );
      result.waist = input.waist;
      result.measurementUnit = input.measurementUnit;
    }
    result.shared = input.shared === true;
  }
  return result;
}

function eligibility(
  log: LogInput,
  submittedAt: Date,
  originalAt: string,
): Pick<LogRecord, 'eligibility' | 'eligibilityReason'> {
  if (log.kind === 'body')
    return { eligibility: 'unscored', eligibilityReason: 'Body records never earn points.' };
  if (log.kind === 'workout' && !log.completed)
    return {
      eligibility: 'draft',
      eligibilityReason: 'Complete and explicitly save this workout to earn points.',
    };
  if (
    submittedAt.getTime() - Date.parse(originalAt) > WINDOW ||
    submittedAt.getTime() - Date.parse(log.occurredAt) > WINDOW
  )
    return {
      eligibility: 'historical',
      eligibilityReason:
        'Saved more than 48 elapsed hours after the activity. Kept as history without points.',
    };
  if (log.kind === 'meal' && !log.mediaId)
    return {
      eligibility: 'unscored',
      eligibilityReason:
        'Photo upload is unavailable in this preview; this meal is saved without points.',
    };
  return { eligibility: 'eligible' };
}

function seed(now: Date): PreviewState {
  const timezone = 'America/New_York';
  const currentWeek = weekKey(now.toISOString(), timezone);
  const currentStart = Date.parse(weekBounds(currentWeek, timezone).start);
  const startDate = weekKey(new Date(currentStart - 1).toISOString(), timezone);
  const targets: Targets = {
    strength: 3,
    cardio: 2,
    waterMl: 2000,
    cardioMinimumMinutes: 20,
    cardioActivity: 'Walking',
  };
  const competition: Competition = {
    id: 'preview-duo',
    name: 'Gym Progress Duo',
    startDate,
    timezone,
    rulesVersion: 'v1-preview-consistency',
    agreedBy: [YOU, PARTNER],
    mealChecklist: [
      'Includes a protein source',
      'Includes a fruit, vegetable, or other fiber-rich food',
    ],
  };
  const profiles: Profile[] = [
    {
      id: YOU,
      displayName: 'You · example',
      initials: 'YOU',
      massUnit: 'lb',
      waterUnit: 'ml',
      distanceUnit: 'mi',
      targets: clone(targets),
    },
    {
      id: PARTNER,
      displayName: 'Partner · example',
      initials: 'PA',
      massUnit: 'kg',
      waterUnit: 'ml',
      distanceUnit: 'km',
      targets: clone(targets),
    },
  ];
  const logs: LogRecord[] = [];
  function add(ownerId: string, occurredAt: string, input: Omit<LogInput, 'occurredAt' | 'notes'>) {
    logs.push({
      ...input,
      occurredAt,
      notes: 'Fictional preview example.',
      id: `fixture-${logs.length + 1}`,
      ownerId,
      version: 1,
      createdAt: occurredAt,
      originalOccurredAt: occurredAt,
      eligibility: input.kind === 'body' ? 'unscored' : 'eligible',
      mediaAvailable: false,
    });
  }
  const previousStart = Date.parse(weekBounds(startDate, timezone).start);
  for (const [index, owner] of [YOU, PARTNER].entries()) {
    for (const weekStart of [previousStart, currentStart]) {
      for (let day = 0; day < 5; day++) {
        const time = weekStart + day * DAY + (15 + index) * 3_600_000;
        if (time >= now.getTime()) continue;
        const at = new Date(time).toISOString();
        add(owner, at, {
          kind: 'hydration',
          title: 'Daily water',
          water: day === 3 ? 1600 : 2100,
          waterUnit: 'ml',
        });
        if (day < 4)
          add(owner, at, {
            kind: 'meal',
            title: [
              'Lunch with beans and greens',
              'Eggs and whole-grain toast',
              'Tofu rice bowl',
              'Chicken and vegetables',
            ][day]!,
            checklist: [true, true],
            mediaId: `fictional-photo-${owner}-${weekStart}-${day}`,
          });
        if (day % 2 === index % 2)
          add(owner, at, {
            kind: 'workout',
            title: day === 0 ? 'Monday strength' : 'Strength session',
            completed: true,
            sets: [
              {
                exercise: 'Goblet squat',
                equipment: 'Dumbbell',
                repetitions: 8,
                load: owner === YOU ? 40 : 18,
                unit: owner === YOU ? 'lb' : 'kg',
              },
              {
                exercise: 'Dumbbell row',
                equipment: 'Dumbbell',
                repetitions: 10,
                load: owner === YOU ? 30 : 14,
                unit: owner === YOU ? 'lb' : 'kg',
              },
            ],
          });
        if (day === 1 || day === 3)
          add(owner, at, {
            kind: 'cardio',
            title: 'Neighborhood walk',
            activity: 'Walking',
            durationMinutes: 25 + day,
            distance: 2,
            distanceUnit: 'km',
          });
      }
    }
  }
  const privateAt = new Date(
    Math.min(currentStart + 15 * 3_600_000, now.getTime() - 3_600_000),
  ).toISOString();
  add(YOU, privateAt, {
    kind: 'body',
    title: 'Example body record',
    bodyWeight: 170,
    bodyUnit: 'lb',
    shared: false,
  });
  add(PARTNER, privateAt, {
    kind: 'body',
    title: 'Hidden partner body record',
    bodyWeight: 80,
    bodyUnit: 'kg',
    shared: false,
  });
  return {
    schemaVersion: 1,
    profiles,
    competition,
    logs,
    templates: [
      {
        id: 'preview-template-1',
        name: 'Full-body basics',
        sets: [
          { exercise: 'Goblet squat', equipment: 'Dumbbell', repetitions: 8, load: 40, unit: 'lb' },
          {
            exercise: 'Dumbbell row',
            equipment: 'Dumbbell',
            repetitions: 10,
            load: 30,
            unit: 'lb',
          },
        ],
      },
    ],
    proposals: [],
    audit: [
      {
        id: 'preview-initial-audit',
        actorId: YOU,
        at: now.toISOString(),
        message: 'Fictional preview loaded. No real accounts or private backend are connected.',
      },
    ],
    requests: {},
  };
}

/** Fictional local-only data. These checks demonstrate UX, not a security boundary. */
export class PreviewGateway implements Gateway {
  private storage: PreviewStorage;
  private now: () => Date;

  constructor(storage: PreviewStorage = browserStorage(), now: () => Date = () => new Date()) {
    this.storage = storage;
    this.now = now;
  }

  private load(): PreviewState {
    const saved = this.storage.getItem(PREVIEW_STORAGE_KEY);
    if (!saved) {
      const state = seed(this.now());
      this.save(state);
      return state;
    }
    try {
      const state = JSON.parse(saved) as PreviewState;
      if (
        state.schemaVersion !== 1 ||
        !Array.isArray(state.logs) ||
        !Array.isArray(state.profiles) ||
        !state.competition ||
        !state.requests
      )
        throw new Error('Invalid preview state');
      return state;
    } catch {
      throw new GatewayError(
        'PREVIEW_DATA_INVALID',
        'Saved preview data could not be read. Reset the fictional preview to start again.',
      );
    }
  }

  private save(state: PreviewState) {
    try {
      this.storage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(state));
    } catch {
      throw new GatewayError(
        'PREVIEW_STORAGE_FULL',
        'Your browser could not save this preview. Free browser storage or reset the fictional preview.',
        507,
      );
    }
  }

  private project(state: PreviewState): Bootstrap {
    const now = this.now();
    const logs = state.logs.filter(
      (log) => log.kind !== 'body' || log.ownerId === YOU || log.shared,
    );
    const currentWeek = weekKey(now.toISOString(), state.competition.timezone);
    const weeks: Bootstrap['weeks'] = [];
    let week = state.competition.startDate;
    // Preview fixtures are short-lived; this limit also bounds malformed browser data.
    for (let count = 0; week <= currentWeek && count < 520; count++) {
      for (const profile of state.profiles)
        weeks.push(
          calculatePreviewWeek(
            state.logs,
            profile.id,
            week,
            profile.targets,
            state.competition,
            now.toISOString(),
          ),
        );
      week = weekKey(weekBounds(week, state.competition.timezone).end, state.competition.timezone);
    }
    const ownStrength = state.logs
      .filter(
        (log) => log.ownerId === YOU && log.kind === 'workout' && log.completed && log.sets?.length,
      )
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const ownCardio = state.logs
      .filter((log) => log.ownerId === YOU && log.kind === 'cardio')
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const strengthSeries = new Map<string, Bootstrap['trends']['strength'][number]>();
    for (const log of ownStrength)
      for (const set of log.sets ?? []) {
        const key = `${set.exercise} · ${set.equipment} · ${set.repetitions} reps · ${set.unit}`;
        if (!strengthSeries.has(key))
          strengthSeries.set(key, { label: key, unit: set.unit, points: [] });
        const points = strengthSeries.get(key)!.points;
        const date = dateKey(log.occurredAt, state.competition.timezone);
        const previous = points.find((point) => point.date === date);
        if (previous) previous.value = Math.max(previous.value, set.load);
        else points.push({ date, value: set.load });
      }
    const cardioSeries = new Map<string, Bootstrap['trends']['cardio'][number]>();
    for (const log of ownCardio) {
      const key = log.activity ?? 'Cardio';
      if (!cardioSeries.has(key))
        cardioSeries.set(key, { label: `${key} duration`, unit: 'min', points: [] });
      cardioSeries.get(key)!.points.push({
        date: dateKey(log.occurredAt, state.competition.timezone),
        value: log.durationMinutes ?? 0,
      });
    }
    return clone({
      currentUserId: YOU,
      profiles: state.profiles,
      competition: state.competition,
      logs,
      weeks,
      allTime: state.profiles.map((profile) => ({
        ownerId: profile.id,
        total: weeks
          .filter((item) => item.ownerId === profile.id)
          .reduce((sum, item) => sum + item.points.total, 0),
      })),
      templates: state.templates,
      proposals: state.proposals,
      audit: state.audit
        .filter((item) => !item.privateOwner || item.privateOwner === YOU)
        .map(({ privateOwner: _privateOwner, ...entry }) => entry),
      trends: { strength: [...strengthSeries.values()], cardio: [...cardioSeries.values()] },
      capabilities: {
        privateMedia: false,
        accountDeletion: false,
        authoritativeScoring: false,
        nutritionTracking: true,
      },
    });
  }

  async bootstrap(): Promise<Bootstrap> {
    return this.project(this.load());
  }

  private ownLog(state: PreviewState, command: { id: string; expectedVersion: number }): LogRecord {
    const log = state.logs.find((item) => item.id === command.id);
    requireThat(
      log && log.ownerId === YOU,
      'NOT_FOUND',
      'That record is not available to your account.',
      404,
    );
    requireThat(
      log.version === command.expectedVersion,
      'VERSION_CONFLICT',
      'This record changed. Refresh before editing it.',
      409,
    );
    return log;
  }

  async execute(envelope: CommandEnvelope): Promise<Bootstrap> {
    requireThat(
      typeof envelope.requestId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(envelope.requestId),
      'REQUEST_ID',
      'A valid unique request ID is required.',
    );
    const serialized = await requestHash(envelope.command);
    const state = this.load();
    const previous = Object.hasOwn(state.requests, envelope.requestId)
      ? state.requests[envelope.requestId]
      : undefined;
    if (previous) {
      requireThat(
        previous.fingerprint === serialized,
        'IDEMPOTENCY_CONFLICT',
        'This request ID was already used for a different change.',
        409,
      );
      return this.project(state);
    }
    const now = this.now();
    const command = envelope.command;
    let message = '';
    let privateOwner: string | undefined;
    switch (command.type) {
      case 'log.create': {
        const input = sanitizeLog(command.log, state.competition, now);
        if (input.kind === 'hydration')
          requireThat(
            !state.logs.some(
              (log) =>
                log.ownerId === YOU &&
                log.kind === 'hydration' &&
                dateKey(log.occurredAt, state.competition.timezone) ===
                  dateKey(input.occurredAt, state.competition.timezone),
            ),
            'DAILY_TOTAL_EXISTS',
            'A water total is already saved for that day. Edit the existing total.',
            409,
          );
        state.logs.push({
          ...input,
          id: id('log'),
          ownerId: YOU,
          version: 1,
          createdAt: now.toISOString(),
          originalOccurredAt: input.occurredAt,
          ...eligibility(input, now, input.occurredAt),
          mediaAvailable: false,
        });
        message = `Saved ${input.kind === 'body' ? 'a body record' : `a ${input.kind} entry`}.`;
        if (input.kind === 'body') privateOwner = YOU;
        break;
      }
      case 'log.update': {
        const old = this.ownLog(state, command);
        requireThat(
          old.kind === 'body' || now.getTime() - Date.parse(old.originalOccurredAt) <= WINDOW,
          'PREVIEW_LATE_EDIT',
          'This preview only supports edits within the original 48-hour window. You can delete this record; audited late corrections need the backend.',
        );
        const input = sanitizeLog(command.log, state.competition, now, old);
        if (input.kind === 'hydration')
          requireThat(
            !state.logs.some(
              (log) =>
                log.id !== old.id &&
                log.ownerId === YOU &&
                log.kind === 'hydration' &&
                dateKey(log.occurredAt, state.competition.timezone) ===
                  dateKey(input.occurredAt, state.competition.timezone),
            ),
            'DAILY_TOTAL_EXISTS',
            'A water total is already saved for that day. Edit that entry instead.',
            409,
          );
        state.logs = state.logs.map((log) =>
          log.id === old.id
            ? {
                ...input,
                id: old.id,
                ownerId: old.ownerId,
                version: old.version + 1,
                createdAt: old.createdAt,
                originalOccurredAt: old.originalOccurredAt,
                ...eligibility(input, now, old.originalOccurredAt),
                mediaAvailable: false,
              }
            : log,
        );
        message = `Corrected a ${old.kind} entry.`;
        if (old.kind === 'body') privateOwner = YOU;
        break;
      }
      case 'log.delete': {
        const old = this.ownLog(state, command);
        state.logs = state.logs.filter((log) => log.id !== old.id);
        message = `Deleted a ${old.kind} entry. Preview totals recalculated.`;
        if (old.kind === 'body') privateOwner = YOU;
        break;
      }
      case 'body.share': {
        const old = this.ownLog(state, command);
        requireThat(
          old.kind === 'body' && typeof command.shared === 'boolean',
          'VALIDATION',
          'Choose a body record and sharing preference.',
        );
        old.shared = command.shared;
        old.version += 1;
        message = command.shared
          ? 'Marked a body record as shared in this local preview.'
          : 'Marked a body record as private in this local preview.';
        privateOwner = YOU;
        break;
      }
      case 'template.save': {
        text(command.name, 100, 'Template name');
        validateSets(command.sets);
        state.templates.push({
          id: id('template'),
          name: command.name.trim(),
          sets: clone(command.sets),
        });
        message = 'Saved a workout template. Templates do not earn points.';
        break;
      }
      case 'targets.propose': {
        const targets = validateTargets(command.targets);
        state.proposals.push({
          id: id('proposal'),
          ownerId: YOU,
          proposedBy: YOU,
          targets,
          effectiveWeek: nextMonday(now, state.competition.timezone),
          approvals: [YOU],
          status: 'pending',
        });
        message =
          'Proposed next-week targets. Your partner must approve through the real backend before they can take effect.';
        break;
      }
      case 'proposal.approve': {
        const proposal = state.proposals.find((item) => item.id === command.id);
        requireThat(proposal, 'NOT_FOUND', 'That proposal was not found.', 404);
        if (!proposal.approvals.includes(YOU)) proposal.approvals.push(YOU);
        message =
          'Your approval is recorded locally. Partner approval is unavailable in this preview.';
        break;
      }
      case 'competition.agree': {
        if (!state.competition.agreedBy.includes(YOU)) state.competition.agreedBy.push(YOU);
        message = 'Recorded your local agreement to the fictional preview rules.';
        break;
      }
      case 'nutrition.goals.set': {
        const profile = state.profiles.find((item) => item.id === YOU)!;
        requireThat(
          Number.isInteger(command.expectedVersion) &&
            command.expectedVersion === (profile.nutritionGoalsVersion ?? 0),
          'VERSION_CONFLICT',
          'Your nutrition goals changed. Refresh before editing them.',
          409,
        );
        let goals;
        try {
          goals = validateNutrition(command.goals, true);
        } catch (error) {
          throw new GatewayError(
            'VALIDATION',
            error instanceof Error ? error.message : 'Check your nutrition goals.',
          );
        }
        const effectiveDate = dateKey(now, state.competition.timezone);
        profile.nutritionGoalHistory = [
          ...(profile.nutritionGoalHistory ?? []).filter(
            (entry) => entry.effectiveDate !== effectiveDate,
          ),
          { effectiveDate, goals },
        ];
        profile.nutritionGoalsVersion = (profile.nutritionGoalsVersion ?? 0) + 1;
        message =
          'Updated personal nutrition goals for today onward. Competition rules and points are unchanged.';
        break;
      }
      case 'profile.update': {
        text(command.displayName, 60, 'Display name');
        requireThat(
          ['kg', 'lb'].includes(command.massUnit) &&
            ['ml', 'L', 'fl oz'].includes(command.waterUnit) &&
            ['km', 'mi'].includes(command.distanceUnit),
          'VALIDATION',
          'Choose supported units.',
        );
        const profile = state.profiles.find((item) => item.id === YOU)!;
        profile.displayName = command.displayName.trim();
        profile.initials = profile.displayName
          .split(/\s+/)
          .map((part) => part[0])
          .slice(0, 2)
          .join('')
          .toUpperCase();
        profile.massUnit = command.massUnit;
        profile.waterUnit = command.waterUnit;
        profile.distanceUnit = command.distanceUnit;
        message = 'Updated your fictional preview profile.';
        break;
      }
      default:
        throw new GatewayError('COMMAND_UNSUPPORTED', 'This change is not supported.');
    }
    state.audit.unshift({
      id: id('audit'),
      actorId: YOU,
      at: now.toISOString(),
      message,
      ...(privateOwner ? { privateOwner } : {}),
    });
    // Store only a one-way request hash: deleted body values never remain in a replay response cache.
    state.requests = { ...state.requests, [envelope.requestId]: { fingerprint: serialized } };
    this.save(state);
    return this.project(state);
  }

  async exportOwn(): Promise<object> {
    const state = this.load();
    return clone({
      format: 'gym-progress-duo-own-export-v1',
      preview: true,
      exportedAt: this.now().toISOString(),
      profile: state.profiles.find((item) => item.id === YOU),
      competition: state.competition,
      logs: state.logs.filter((log) => log.ownerId === YOU),
      templates: state.templates,
      proposals: state.proposals.filter((item) => item.ownerId === YOU),
      audit: state.audit
        .filter((item) => item.actorId === YOU)
        .map(({ privateOwner: _privateOwner, ...entry }) => entry),
    });
  }

  async upload(_file: File): Promise<{ mediaId: string }> {
    throw new GatewayError(
      'PRIVATE_MEDIA_UNAVAILABLE',
      'Photo uploads are disabled in the local preview. A private storage backend must be connected before any image is uploaded.',
      501,
    );
  }

  async logout(): Promise<void> {
    /* Preview has no authenticated session. */
  }
  resetPreview(): void {
    this.storage.removeItem(PREVIEW_STORAGE_KEY);
  }
}

export function resetPreview(storage: PreviewStorage = browserStorage()): void {
  storage.removeItem(PREVIEW_STORAGE_KEY);
}
