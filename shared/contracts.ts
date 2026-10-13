/** v1 boundary shared with the backend. Requests never accept scores, owners or approval IDs. */
export type LogKind = 'workout' | 'cardio' | 'meal' | 'hydration' | 'body';
export type MassUnit = 'lb' | 'kg';
export type WaterUnit = 'ml' | 'L' | 'fl oz';
export type DistanceUnit = 'km' | 'mi';
export type NutrientKey = 'calories' | 'protein' | 'carbs' | 'fat' | 'fiber' | 'sugar' | 'sodium';
export type NutritionValues = Partial<Record<NutrientKey, number>>;
export type NutritionGoalKey = 'calories' | 'protein' | 'carbs' | 'fat' | 'fiber';
export type NutritionGoals = Partial<Record<NutritionGoalKey, number>>;
/** Tracking preferences, not competition scoring targets or medical recommendations. */
export interface NutritionGoalSnapshot {
  effectiveDate: string;
  goals: NutritionGoals;
}
export interface ExerciseSet {
  exercise: string;
  equipment: string;
  repetitions: number;
  load: number;
  unit: MassUnit;
}
export interface LogInput {
  kind: LogKind;
  occurredAt: string;
  title: string;
  notes: string;
  completed?: boolean;
  sets?: ExerciseSet[];
  activity?: string;
  durationMinutes?: number;
  distance?: number;
  distanceUnit?: DistanceUnit;
  steps?: number;
  checklist?: boolean[];
  nutrition?: NutritionValues;
  mediaId?: string;
  water?: number;
  waterUnit?: WaterUnit;
  bodyWeight?: number;
  bodyUnit?: MassUnit;
  waist?: number;
  measurementUnit?: 'cm' | 'in';
  shared?: boolean;
}
export interface LogRecord extends LogInput {
  id: string;
  ownerId: string;
  version: number;
  createdAt: string;
  originalOccurredAt: string;
  eligibility: 'eligible' | 'historical' | 'draft' | 'unscored';
  eligibilityReason?: string;
  mediaAvailable?: boolean;
}
export interface Targets {
  strength: number;
  cardio: number;
  waterMl: number;
  cardioMinimumMinutes: number;
  cardioActivity: string;
}
export interface Profile {
  id: string;
  displayName: string;
  initials: string;
  massUnit: MassUnit;
  waterUnit: WaterUnit;
  distanceUnit: DistanceUnit;
  targets: Targets;
  nutritionGoalHistory?: NutritionGoalSnapshot[];
  nutritionGoalsVersion?: number;
}
export interface Competition {
  id: string;
  name: string;
  startDate: string;
  timezone: string;
  rulesVersion: string;
  agreedBy: string[];
  mealChecklist: string[];
}
export interface ScoreBreakdown {
  strength: number;
  meals: number;
  cardio: number;
  hydration: number;
  improvement: number;
  total: number;
}
export interface WeeklyScore {
  week: string;
  ownerId: string;
  points: ScoreBreakdown;
  days: { strength: number; meals: number; cardio: number; hydration: number };
  targets: Targets;
  provisional: boolean;
}
export interface WorkoutTemplate {
  id: string;
  name: string;
  sets: ExerciseSet[];
}
export interface ChangeProposal {
  id: string;
  ownerId: string;
  proposedBy: string;
  targets: Targets;
  effectiveWeek: string;
  approvals: string[];
  status: 'pending' | 'approved';
}
export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  message: string;
}
export interface TrendSeries {
  label: string;
  unit: string;
  points: { date: string; value: number }[];
}
export interface Bootstrap {
  currentUserId: string;
  profiles: Profile[];
  competition: Competition;
  logs: LogRecord[];
  weeks: WeeklyScore[];
  allTime: { ownerId: string; total: number }[];
  templates: WorkoutTemplate[];
  proposals: ChangeProposal[];
  audit: AuditEntry[];
  trends: { strength: TrendSeries[]; cardio: TrendSeries[] };
  capabilities: {
    privateMedia: boolean;
    accountDeletion: boolean;
    authoritativeScoring: boolean;
    nutritionTracking?: boolean;
  };
}
export type Command =
  | { type: 'log.create'; log: LogInput }
  | { type: 'log.update'; id: string; expectedVersion: number; log: LogInput }
  | { type: 'log.delete'; id: string; expectedVersion: number }
  | { type: 'body.share'; id: string; expectedVersion: number; shared: boolean }
  | { type: 'template.save'; name: string; sets: ExerciseSet[] }
  | { type: 'targets.propose'; targets: Targets }
  | { type: 'proposal.approve'; id: string }
  | { type: 'competition.agree' }
  | { type: 'nutrition.goals.set'; goals: NutritionGoals; expectedVersion: number }
  | {
      type: 'profile.update';
      displayName: string;
      massUnit: MassUnit;
      waterUnit: WaterUnit;
      distanceUnit: DistanceUnit;
    };
export interface CommandEnvelope {
  requestId: string;
  command: Command;
}
export interface ApiErrorBody {
  error: { code: string; message: string; retryable: boolean };
}
