import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuditEntry,
  Bootstrap,
  ChangeProposal,
  CommandEnvelope,
  ExerciseSet,
  LogInput,
  LogRecord,
  NutritionGoals,
  Profile,
  Targets,
  WeeklyScore,
  WorkoutTemplate,
} from '../../shared/contracts';
import { dateKey } from '../../shared/time';
import { GatewayError, type Gateway } from './http';

type Row = Record<string, unknown>;
type RpcResult = { data: unknown; error: { message: string; code?: string } | null };

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && publishableKey);

function client(): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new GatewayError(
      'BACKEND_NOT_CONFIGURED',
      'The private backend is present but not connected yet. Add the Supabase URL and publishable key to .env.local.',
      503,
    );
  }
  return createClient(supabaseUrl!, publishableKey!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

function apiError(
  error: { message: string; code?: string } | null,
  fallback: string,
): GatewayError {
  const message = error?.message || fallback;
  const code = error?.code || 'SUPABASE_ERROR';
  if (/JWT|session|not authenticated/i.test(message)) {
    return new GatewayError('UNAUTHENTICATED', 'Sign in to your invited account to continue.', 401);
  }
  if (code === '42501' || /permission|member|invited|own logs/i.test(message)) {
    return new GatewayError('FORBIDDEN', message, 403);
  }
  return new GatewayError(code, message, 400, /network|fetch/i.test(message));
}

function string(row: Row, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string' ? value : fallback;
}

function number(row: Row, key: string, fallback = 0): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : fallback;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

function asTargets(row?: Row): Targets {
  return {
    strength: row ? number(row, 'strength_days_target', 3) : 3,
    cardio: row ? number(row, 'cardio_days_target', 3) : 3,
    waterMl: row ? number(row, 'hydration_target_ml', 2000) : 2000,
    cardioMinimumMinutes: row ? number(row, 'cardio_min_minutes', 20) : 20,
    cardioActivity: row
      ? string(row, 'cardio_definition', 'Your chosen cardio activity')
      : 'Your chosen cardio activity',
  };
}

function latestForUser(targets: Row[], userId: string, week: string): Row | undefined {
  return targets
    .filter((row) => string(row, 'user_id') === userId && string(row, 'effective_week') <= week)
    .sort((a, b) => string(b, 'effective_week').localeCompare(string(a, 'effective_week')))[0];
}

function eligibility(
  row: Row,
  kind: LogRecord['kind'],
  creditIds: Set<string>,
): Pick<LogRecord, 'eligibility' | 'eligibilityReason'> {
  if (kind === 'body')
    return { eligibility: 'unscored', eligibilityReason: 'Body records never earn points.' };
  if (kind === 'workout' && string(row, 'status') === 'draft') {
    return {
      eligibility: 'draft',
      eligibilityReason: 'Complete and save this draft before it can earn points.',
    };
  }
  if (creditIds.has(string(row, 'id'))) return { eligibility: 'eligible' };
  return {
    eligibility: 'historical',
    eligibilityReason: 'Kept in history, but it does not currently earn points.',
  };
}

function makeLog(row: Row, kind: LogRecord['kind'], creditIds: Set<string>): LogRecord {
  const occurredAt =
    string(row, 'activity_at') ||
    string(row, 'original_activity_at') ||
    `${string(row, 'recorded_on')}T12:00:00.000Z`;
  const base: LogRecord = {
    id: string(row, 'id'),
    ownerId: string(row, 'user_id'),
    version: number(row, 'version', 1),
    kind,
    occurredAt,
    originalOccurredAt: string(row, 'original_activity_at', occurredAt),
    createdAt: string(row, 'created_at', string(row, 'submitted_at', occurredAt)),
    title: '',
    notes: string(row, 'notes'),
    ...eligibility(row, kind, creditIds),
  };

  if (kind === 'workout') {
    const workoutSets = rows(row.workout_sets);
    base.title = string(row, 'title') || 'Workout';
    base.completed = string(row, 'status') === 'completed';
    base.sets = workoutSets.flatMap((set) => {
      const value: ExerciseSet = {
        exercise: string(set, 'exercise'),
        equipment: string(set, 'equipment'),
        repetitions: number(set, 'reps'),
        load: number(set, 'weight'),
        unit: string(set, 'weight_unit') === 'kg' ? 'kg' : 'lb',
      };
      return Array.from({ length: Math.max(1, number(set, 'sets', 1)) }, () => ({ ...value }));
    });
  } else if (kind === 'cardio') {
    base.title = string(row, 'activity') || 'Cardio';
    base.activity = string(row, 'activity');
    base.durationMinutes = number(row, 'duration_s') / 60;
    if (row.distance != null) base.distance = number(row, 'distance');
    if (row.distance_unit === 'mi' || row.distance_unit === 'km')
      base.distanceUnit = row.distance_unit;
    if (row.steps != null) base.steps = number(row, 'steps');
  } else if (kind === 'meal') {
    base.title = string(row, 'description') || 'Meal';
    const checklist = (
      row.checklist && typeof row.checklist === 'object' ? row.checklist : {}
    ) as Record<string, unknown>;
    base.checklist = Object.values(checklist).map(Boolean);
    base.mediaId = string(row, 'photo_path') || undefined;
    base.mediaAvailable = Boolean(base.mediaId);
    if (row.nutrition && typeof row.nutrition === 'object')
      base.nutrition = row.nutrition as LogRecord['nutrition'];
  } else if (kind === 'hydration') {
    base.title = 'Water';
    base.water = number(row, 'amount');
    base.waterUnit = string(row, 'unit') === 'oz' ? 'fl oz' : 'ml';
  } else {
    base.title = 'Body check-in';
    if (row.weight != null) base.bodyWeight = number(row, 'weight');
    base.bodyUnit = string(row, 'weight_unit') === 'kg' ? 'kg' : 'lb';
    const measurements = (
      row.measurements && typeof row.measurements === 'object' ? row.measurements : {}
    ) as Record<string, { value?: number; unit?: 'cm' | 'in' }>;
    const waist = measurements.waist;
    if (waist?.value != null) base.waist = Number(waist.value);
    if (waist?.unit) base.measurementUnit = waist.unit;
    base.shared = Boolean(row.shared);
    base.mediaId = string(row, 'photo_path') || undefined;
    base.mediaAvailable = Boolean(base.mediaId);
  }
  return base;
}

function imageExtension(type: string): string {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
}

async function strippedImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new GatewayError(
      'IMAGE_DECODE',
      'This image could not be safely processed. Export it as JPEG or PNG and try again.',
    );
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new GatewayError('IMAGE_DECODE', 'This browser could not prepare the image.');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outputType, 0.9));
  if (!blob) throw new GatewayError('IMAGE_DECODE', 'This browser could not prepare the image.');
  return blob;
}

export class SupabaseGateway implements Gateway {
  private readonly supabase = client();
  private readonly kinds = new Map<string, LogRecord['kind']>();
  private readonly occurredAt = new Map<string, string>();
  private timezone = 'America/New_York';

  private async rpc<T>(name: string, args: Row = {}): Promise<T> {
    const result = (await this.supabase.rpc(name, args)) as RpcResult;
    if (result.error) throw apiError(result.error, `Could not run ${name}.`);
    return result.data as T;
  }

  private async select(table: string, query = '*'): Promise<Row[]> {
    const result = await this.supabase.from(table).select(query);
    if (result.error) throw apiError(result.error, `Could not load ${table}.`);
    return rows(result.data);
  }

  async sendLoginCode(email: string): Promise<void> {
    const { error } = await this.supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: false },
    });
    if (error) throw apiError(error, 'Could not send the sign-in code.');
  }

  async verifyLoginCode(email: string, code: string): Promise<void> {
    const { error } = await this.supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: 'email',
    });
    if (error)
      throw new GatewayError('BAD_CODE', 'That code is wrong or expired. Request a new one.', 401);
  }

  async bootstrap(): Promise<Bootstrap> {
    const { data: sessionData, error: sessionError } = await this.supabase.auth.getSession();
    if (sessionError) throw apiError(sessionError, 'Could not check your session.');
    if (!sessionData.session)
      throw new GatewayError(
        'UNAUTHENTICATED',
        'Sign in to your invited account to continue.',
        401,
      );

    await this.rpc<string>('join_competition');
    await this.rpc<void>('refresh_scores');
    const context = await this.rpc<Row>('get_my_context');
    const competition = context.competition as Row;
    this.timezone = string(competition, 'timezone', 'America/New_York');
    const currentWeek = string(context, 'current_week');
    const [
      rules,
      targetVersions,
      workouts,
      cardio,
      meals,
      hydration,
      body,
      scores,
      proposals,
      templates,
      credits,
      feed,
      nutritionGoals,
    ] = await Promise.all([
      this.select('rule_versions'),
      this.select('target_versions'),
      this.select('workouts', '*, workout_sets(*)'),
      this.select('cardio_logs'),
      this.select('meal_logs'),
      this.select('hydration_logs'),
      this.select('body_records'),
      this.select('weekly_scores'),
      this.select('change_proposals', '*, approvals:proposal_approvals(user_id, approved_at)'),
      this.select('workout_templates'),
      this.select('record_credits'),
      this.select('activity_feed'),
      this.select('nutrition_goal_versions'),
    ]);

    const creditIds = new Set(
      credits
        .filter((credit) => Boolean(credit.qualifies))
        .map((credit) => string(credit, 'record_id')),
    );
    const logs = [
      ...workouts.map((row) => makeLog(row, 'workout', creditIds)),
      ...cardio.map((row) => makeLog(row, 'cardio', creditIds)),
      ...meals.map((row) => makeLog(row, 'meal', creditIds)),
      ...hydration.map((row) => makeLog(row, 'hydration', creditIds)),
      ...body.map((row) => makeLog(row, 'body', creditIds)),
    ];
    this.kinds.clear();
    this.occurredAt.clear();
    logs.forEach((log) => {
      this.kinds.set(log.id, log.kind);
      this.occurredAt.set(log.id, log.occurredAt);
    });

    const members = rows(context.members);
    const profiles: Profile[] = members.map((member) => {
      const userId = string(member, 'user_id');
      const ownGoals = nutritionGoals
        .filter((goal) => string(goal, 'user_id') === userId)
        .sort((a, b) => string(a, 'effective_date').localeCompare(string(b, 'effective_date')));
      return {
        id: userId,
        displayName: string(member, 'display_name', 'Member'),
        initials: string(member, 'display_name', 'Member')
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0])
          .join('')
          .toUpperCase(),
        massUnit: string(member, 'weight_unit') === 'kg' ? 'kg' : 'lb',
        waterUnit: string(member, 'water_unit') === 'ml' ? 'ml' : 'fl oz',
        distanceUnit: string(member, 'distance_unit') === 'km' ? 'km' : 'mi',
        targets: asTargets(latestForUser(targetVersions, string(member, 'user_id'), currentWeek)),
        nutritionGoalHistory: ownGoals.map((goal) => ({
          effectiveDate: string(goal, 'effective_date'),
          goals: (goal.goals && typeof goal.goals === 'object' ? goal.goals : {}) as NutritionGoals,
        })),
        nutritionGoalsVersion: ownGoals.reduce(
          (maximum, goal) => Math.max(maximum, number(goal, 'version')),
          0,
        ),
      };
    });

    const rule = rules
      .filter((row) => string(row, 'effective_week') <= currentWeek)
      .sort((a, b) => string(b, 'effective_week').localeCompare(string(a, 'effective_week')))[0];
    const rulesPayload = (rule?.rules && typeof rule.rules === 'object' ? rule.rules : {}) as Row;
    const checklistRows = rows(rulesPayload.meal_checklist);

    const weeks: WeeklyScore[] = scores.map((score) => ({
      week: string(score, 'week_start'),
      ownerId: string(score, 'user_id'),
      points: {
        strength: number(score, 'strength_points'),
        meals: number(score, 'meal_points'),
        cardio: number(score, 'cardio_points'),
        hydration: number(score, 'hydration_points'),
        improvement: number(score, 'strength_bonus') + number(score, 'cardio_bonus'),
        total: number(score, 'total'),
      },
      days: {
        strength: number(score, 'strength_days'),
        meals: number(score, 'meal_days'),
        cardio: number(score, 'cardio_days'),
        hydration: number(score, 'hydration_days'),
      },
      targets: asTargets(
        (score.targets && typeof score.targets === 'object' ? score.targets : {}) as Row,
      ),
      provisional: string(score, 'status') !== 'final',
    }));

    const allTimeMap = new Map<string, number>();
    weeks.forEach((week) =>
      allTimeMap.set(week.ownerId, (allTimeMap.get(week.ownerId) || 0) + week.points.total),
    );

    const mappedProposals: ChangeProposal[] = proposals
      .filter(
        (proposal) =>
          string(proposal, 'kind') === 'targets' && string(proposal, 'status') === 'pending',
      )
      .map((proposal) => ({
        id: string(proposal, 'id'),
        ownerId: string(proposal, 'subject_user_id', string(proposal, 'proposed_by')),
        proposedBy: string(proposal, 'proposed_by'),
        targets: asTargets(
          (proposal.payload && typeof proposal.payload === 'object' ? proposal.payload : {}) as Row,
        ),
        effectiveWeek: string(proposal, 'effective_week', string(context, 'next_change_week')),
        approvals: rows(proposal.approvals).map((approval) => string(approval, 'user_id')),
        status: 'pending',
      }));

    const mappedTemplates: WorkoutTemplate[] = templates.map((template) => ({
      id: string(template, 'id'),
      name: string(template, 'name'),
      sets: rows(template.items).flatMap((item) => {
        const set: ExerciseSet = {
          exercise: string(item, 'exercise'),
          equipment: string(item, 'equipment'),
          repetitions: number(item, 'reps'),
          load: number(item, 'weight'),
          unit: string(item, 'weight_unit') === 'kg' ? 'kg' : 'lb',
        };
        return Array.from({ length: Math.max(1, number(item, 'sets', 1)) }, () => ({ ...set }));
      }),
    }));

    const audit: AuditEntry[] = feed.map((entry) => ({
      id: String(entry.id),
      at: string(entry, 'created_at'),
      actorId: string(entry, 'actor_id'),
      message: string(entry, 'summary'),
    }));

    return {
      currentUserId: string(context, 'user_id'),
      profiles,
      competition: {
        id: string(competition, 'id'),
        name: string(competition, 'name', 'Gym Progress Duo'),
        startDate: string(competition, 'start_date'),
        timezone: this.timezone,
        rulesVersion: string(rule ?? {}, 'id', 'v1'),
        agreedBy: members
          .filter((member) => Boolean(member.agreed_to_setup))
          .map((member) => string(member, 'user_id')),
        mealChecklist: checklistRows.map((item) => string(item, 'label')).filter(Boolean),
      },
      logs: logs.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
      weeks,
      allTime: [...allTimeMap].map(([ownerId, total]) => ({ ownerId, total })),
      templates: mappedTemplates,
      proposals: mappedProposals,
      audit,
      trends: { strength: [], cardio: [] },
      capabilities: {
        privateMedia: true,
        accountDeletion: false,
        authoritativeScoring: true,
        nutritionTracking: true,
      },
    };
  }

  private workoutPayload(log: LogInput, id: string | undefined, clientKey: string): Row {
    return {
      ...(id ? { id } : { client_key: clientKey }),
      title: log.title,
      notes: log.notes,
      activity_at: log.occurredAt,
      status: log.completed === false ? 'draft' : 'completed',
      sets: (log.sets || []).map((set) => ({
        exercise: set.exercise,
        equipment: set.equipment,
        sets: 1,
        reps: set.repetitions,
        weight: set.load,
        weight_unit: set.unit,
      })),
    };
  }

  private async saveLog(log: LogInput, requestId: string, id?: string): Promise<void> {
    if (log.kind === 'workout') {
      await this.rpc('save_workout', { p: this.workoutPayload(log, id, requestId) });
    } else if (log.kind === 'cardio') {
      await this.rpc('save_cardio', {
        p: {
          ...(id ? { id } : { client_key: requestId }),
          activity: log.activity || log.title,
          duration_s: Math.round((log.durationMinutes || 0) * 60),
          distance: log.distance ?? null,
          distance_unit: log.distance != null ? log.distanceUnit : null,
          steps: log.steps ?? null,
          notes: log.notes,
          activity_at: log.occurredAt,
        },
      });
    } else if (log.kind === 'meal') {
      if (!log.mediaId)
        throw new GatewayError('PHOTO_REQUIRED', 'Choose one meal photo before saving.');
      await this.rpc('save_meal', {
        p: {
          ...(id ? { id } : { client_key: requestId }),
          description: log.title,
          photo_path: log.mediaId,
          checklist: Object.fromEntries(
            (log.checklist || []).map((value, index) => [`item_${index + 1}`, value]),
          ),
          ...(log.nutrition ? { nutrition: log.nutrition } : {}),
          activity_at: log.occurredAt,
        },
      });
    } else if (log.kind === 'hydration') {
      await this.rpc('save_hydration', {
        p_day: dateKey(log.occurredAt, this.timezone),
        p_amount: log.water || 0,
        p_unit: log.waterUnit === 'fl oz' ? 'oz' : 'ml',
      });
    } else {
      await this.rpc('save_body_record', {
        p: {
          ...(id ? { id } : { client_key: requestId }),
          recorded_on: dateKey(log.occurredAt, this.timezone),
          weight: log.bodyWeight ?? null,
          weight_unit: log.bodyWeight != null ? log.bodyUnit : null,
          measurements:
            log.waist != null ? { waist: { value: log.waist, unit: log.measurementUnit } } : {},
          photo_path: log.mediaId ?? null,
          notes: log.notes,
        },
      });
    }
  }

  async execute(envelope: CommandEnvelope): Promise<Bootstrap> {
    const command = envelope.command;
    if (command.type === 'log.create') {
      await this.saveLog(command.log, envelope.requestId);
    } else if (command.type === 'log.update') {
      await this.saveLog(command.log, envelope.requestId, command.id);
    } else if (command.type === 'log.delete') {
      const kind = this.kinds.get(command.id);
      if (!kind) throw new GatewayError('NOT_FOUND', 'This record is no longer available.', 404);
      const fn =
        kind === 'workout'
          ? 'delete_workout'
          : kind === 'cardio'
            ? 'delete_cardio'
            : kind === 'meal'
              ? 'delete_meal'
              : kind === 'body'
                ? 'delete_body_record'
                : 'delete_hydration';
      const args =
        kind === 'hydration'
          ? { p_day: dateKey(this.occurredAt.get(command.id) || '', this.timezone) }
          : { p_id: command.id };
      const removed = await this.rpc<unknown>(fn, args);
      if ((kind === 'meal' || kind === 'body') && typeof removed === 'string' && removed) {
        const result = await this.supabase.storage.from('media').remove([removed]);
        if (result.error)
          throw apiError(
            result.error,
            'The record was removed, but its private image still needs cleanup.',
          );
      }
    } else if (command.type === 'body.share') {
      await this.rpc('set_body_record_shared', { p_id: command.id, p_shared: command.shared });
    } else if (command.type === 'template.save') {
      await this.rpc('save_template', {
        p: {
          name: command.name,
          items: command.sets.map((set) => ({
            exercise: set.exercise,
            equipment: set.equipment,
            sets: 1,
            reps: set.repetitions,
            weight: set.load,
            weight_unit: set.unit,
          })),
        },
      });
    } else if (command.type === 'targets.propose') {
      await this.rpc('propose_change', {
        p_kind: 'targets',
        p_payload: {
          strength_days_target: command.targets.strength,
          cardio_days_target: command.targets.cardio,
          hydration_target_ml: command.targets.waterMl,
          cardio_min_minutes: command.targets.cardioMinimumMinutes,
          cardio_definition: command.targets.cardioActivity,
        },
      });
    } else if (command.type === 'proposal.approve') {
      await this.rpc('approve_proposal', { p_id: command.id });
    } else if (command.type === 'competition.agree') {
      await this.rpc('agree_to_setup');
    } else if (command.type === 'profile.update') {
      await this.rpc('update_profile', {
        p: {
          display_name: command.displayName,
          weight_unit: command.massUnit,
          water_unit: command.waterUnit === 'fl oz' ? 'oz' : 'ml',
          distance_unit: command.distanceUnit,
        },
      });
    } else if (command.type === 'nutrition.goals.set') {
      await this.rpc('set_nutrition_goals', {
        p_goals: command.goals,
        p_expected_version: command.expectedVersion,
        p_request_id: envelope.requestId,
      });
    }
    return this.bootstrap();
  }

  async exportOwn(): Promise<object> {
    return this.rpc<object>('export_my_data');
  }

  async upload(file: File, purpose: 'meals' | 'body' = 'meals'): Promise<{ mediaId: string }> {
    if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
      throw new GatewayError(
        'IMAGE_FORMAT',
        'Export this photo as JPEG or PNG first. HEIC is not safely supported yet.',
      );
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new GatewayError('IMAGE_FORMAT', 'Choose one JPEG, PNG, or WebP image.');
    }
    if (file.size > 10 * 1024 * 1024)
      throw new GatewayError('IMAGE_SIZE', 'Choose an image smaller than 10 MB.');
    const { data, error } = await this.supabase.auth.getUser();
    if (error || !data.user)
      throw new GatewayError('UNAUTHENTICATED', 'Sign in before uploading a photo.', 401);
    const blob = await strippedImage(file);
    const path = `${data.user.id}/${purpose}/${crypto.randomUUID()}.${imageExtension(blob.type)}`;
    const result = await this.supabase.storage
      .from('media')
      .upload(path, blob, { contentType: blob.type, upsert: false });
    if (result.error) throw apiError(result.error, 'The private image upload failed.');
    return { mediaId: path };
  }

  async logout(): Promise<void> {
    const { error } = await this.supabase.auth.signOut();
    if (error) throw apiError(error, 'Could not sign out.');
  }
}
