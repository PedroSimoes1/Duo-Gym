import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { CircleHelp, Pencil, Plus, Save, Utensils } from 'lucide-react';
import type { Bootstrap, Command, NutritionGoals, Profile } from '../../shared/contracts';
import {
  goalKeys,
  nutritionFields,
  nutritionGoalsForDate,
  summarizeNutrition,
} from '../../shared/nutrition';
import { dateKey } from '../../shared/time';
import { Card, Modal, SectionTitle } from './ui';
import './nutrition.css';

export interface NutritionPanelProps {
  data: Bootstrap;
  onCommand: (command: Command) => Promise<void>;
  onLogMeal: () => void;
  busy: boolean;
}

const goalLabels: Record<keyof NutritionGoals, string> = {
  calories: 'Calorie goal (kcal)',
  protein: 'Protein goal (g)',
  carbs: 'Carb goal (g)',
  fat: 'Fat goal (g)',
  fiber: 'Fiber goal (g)',
};
const colors: Record<keyof NutritionGoals, string> = {
  calories: 'var(--lime)',
  protein: 'var(--peach)',
  carbs: 'var(--lavender)',
  fat: 'var(--blue)',
  fiber: 'var(--yellow)',
};
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });

function NutritionRing({
  label,
  unit,
  value,
  recorded,
  goal,
  color,
  large = false,
}: {
  label: string;
  unit: string;
  value: number;
  recorded: number;
  goal?: number;
  color: string;
  large?: boolean;
}) {
  const known = recorded > 0;
  const hasGoal = typeof goal === 'number' && goal > 0;
  const fraction = known && hasGoal ? Math.min(value / goal, 1) : 0;
  const circumference = 2 * Math.PI * 43;
  const status = !known
    ? 'Not logged'
    : !hasGoal
      ? 'No goal set'
      : value > goal
        ? `${number(value - goal)} ${unit} over goal`
        : value === goal
          ? 'Goal reached'
          : `${number(goal - value)} ${unit} remaining`;
  return (
    <article
      className={`nutrition-metric${large ? ' nutrition-calories' : ''}`}
      style={{ '--nutrition-accent': color } as CSSProperties}
      aria-label={`${label} summary`}
    >
      <div
        className="nutrition-dial"
        role="img"
        aria-label={`${label}: ${known ? `${number(value)} ${unit} logged` : 'not logged'}. ${hasGoal ? `Goal ${number(goal)} ${unit}.` : 'No goal set.'} ${status}.`}
      >
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle className="nutrition-dial-track" cx="50" cy="50" r="43" />
          <circle
            className="nutrition-dial-value"
            cx="50"
            cy="50"
            r="43"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
            opacity={fraction > 0 ? 1 : 0}
            transform="rotate(-90 50 50)"
          />
        </svg>
        <div className="nutrition-dial-center">
          <strong>{known ? number(value) : '—'}</strong>
          <span>{hasGoal ? `/ ${number(goal)} ${unit}` : `${unit} logged`}</span>
        </div>
      </div>
      <div className="nutrition-metric-copy">
        <h3>{label}</h3>
        <p>{status}</p>
        {!hasGoal && !known && <small>No goal set</small>}
      </div>
    </article>
  );
}

function NutritionGoalsForm({
  profile,
  today,
  onCommand,
  onClose,
  onSaved,
}: {
  profile: Profile;
  today: string;
  onCommand: NutritionPanelProps['onCommand'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState(() => {
    const current = nutritionGoalsForDate(profile.nutritionGoalHistory ?? [], today);
    return Object.fromEntries(goalKeys.map((key) => [key, String(current[key] ?? '')]));
  });
  const [expectedVersion] = useState(profile.nutritionGoalsVersion ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const goals: NutritionGoals = {};
    for (const key of goalKeys) {
      if (!values[key].trim()) continue;
      const amount = Number(values[key]);
      const maximum = nutritionFields.find((field) => field.key === key)!.max;
      if (!Number.isFinite(amount) || amount <= 0 || amount > maximum) {
        setError('Enter a positive amount for each goal, or leave it blank.');
        return;
      }
      goals[key] = amount;
    }
    setError('');
    setSaving(true);
    try {
      await onCommand({ type: 'nutrition.goals.set', goals, expectedVersion });
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Your goals could not be saved. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Your daily nutrition goals" onClose={() => !saving && onClose()}>
      <form className="log-form nutrition-goals-form" onSubmit={submit}>
        <p className="form-notice">
          Choose your own daily goals. These are personal tracking preferences, not diet advice or
          competition rules. They earn no points and do not need your partner’s approval.
        </p>
        <p className="helper">
          Changes apply from today in the competition timezone. Past days keep their previous goals.
          Leave a field blank to track that nutrient without a goal.
        </p>
        <fieldset className="nutrition-goal-fields" disabled={saving}>
          <legend className="nutrition-visually-hidden">Optional nutrition goals</legend>
          {goalKeys.map((key) => (
            <label key={key}>
              {goalLabels[key]}
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max={nutritionFields.find((field) => field.key === key)!.max}
                step="any"
                placeholder="No goal set"
                value={values[key]}
                onChange={(event) =>
                  setValues((previous) => ({ ...previous, [key]: event.target.value }))
                }
              />
            </label>
          ))}
        </fieldset>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <footer className="form-footer">
          <button type="button" className="button secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            <Save size={17} aria-hidden="true" />
            {saving ? 'Saving…' : 'Save nutrition goals'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export default function NutritionPanel({ data, onCommand, onLogMeal, busy }: NutritionPanelProps) {
  const today = dateKey(new Date(), data.competition.timezone);
  const [day, setDay] = useState(today);
  const [ownerId, setOwnerId] = useState(data.currentUserId);
  const [editingGoals, setEditingGoals] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const profile = data.profiles.find((person) => person.id === ownerId);
  const own = ownerId === data.currentUserId;
  const supported = data.capabilities.nutritionTracking === true;
  const goals = nutritionGoalsForDate(profile?.nutritionGoalHistory ?? [], day);
  const summary = summarizeNutrition(data.logs, ownerId, day, data.competition.timezone);
  const hasGoals = goalKeys.some((key) => goals[key] !== undefined);

  return (
    <Card className="nutrition-panel">
      <SectionTitle
        eyebrow="YOUR DAILY PICTURE"
        title="Daily nutrition"
        action={
          supported && own && day === today ? (
            <button
              type="button"
              className="button secondary nutrition-goals-button"
              onClick={() => setEditingGoals(true)}
              disabled={busy}
            >
              <Pencil size={15} aria-hidden="true" />
              {hasGoals ? 'Edit nutrition goals' : 'Set nutrition goals'}
            </button>
          ) : undefined
        }
      />
      {!supported ? (
        <div className="nutrition-unavailable">
          <Utensils size={24} aria-hidden="true" />
          <h3>Nutrition tracking is not connected</h3>
          <p>
            The connected backend needs nutrition support before you can save meals with macros or
            goals.
          </p>
        </div>
      ) : (
        <>
          <div className="nutrition-controls">
            <label>
              Nutrition member
              <select
                value={ownerId}
                onChange={(event) => {
                  setOwnerId(event.target.value);
                  setSavedMessage('');
                }}
              >
                {data.profiles.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.id === data.currentUserId
                      ? `You · ${person.displayName}`
                      : person.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Nutrition date
              <input
                type="date"
                value={day}
                max={today}
                onChange={(event) => {
                  if (event.target.value && event.target.value <= today) {
                    setDay(event.target.value);
                    setSavedMessage('');
                  }
                }}
              />
            </label>
          </div>
          <div className="nutrition-day-context">
            <span>
              {day === today ? 'TODAY' : 'DAILY HISTORY'} · {data.competition.timezone}
            </span>
            <span>
              {summary.mealCount} {summary.mealCount === 1 ? 'meal' : 'meals'} logged
            </span>
          </div>
          {!own && (
            <p className="nutrition-read-only">
              Your partner’s shared nutrition. Only they can edit their meals and goals.
            </p>
          )}
          {day !== today && (
            <p className="nutrition-read-only">
              Showing the goals saved for this date. Goal changes can be made on today’s view.
            </p>
          )}
          <div className="nutrition-rings">
            {goalKeys.map((key) => {
              const field = nutritionFields.find((item) => item.key === key)!;
              return (
                <NutritionRing
                  key={key}
                  label={field.label}
                  unit={field.unit}
                  value={summary.totals[key]}
                  recorded={summary.recorded[key]}
                  goal={goals[key]}
                  color={colors[key]}
                  large={key === 'calories'}
                />
              );
            })}
          </div>
          <div className="nutrition-extras">
            {(['sugar', 'sodium'] as const).map((key) => {
              const field = nutritionFields.find((item) => item.key === key)!;
              return (
                <div key={key}>
                  <span>{field.label}</span>
                  <strong>
                    {summary.recorded[key] > 0
                      ? `${number(summary.totals[key])} ${field.unit}`
                      : 'Not logged'}
                  </strong>
                </div>
              );
            })}
          </div>
          {summary.missingMeals > 0 ? (
            <p className="nutrition-partial" role="status">
              <CircleHelp size={16} aria-hidden="true" />
              <span>
                Partial totals: {summary.missingMeals}{' '}
                {summary.missingMeals === 1 ? 'meal is' : 'meals are'} missing calories or macros.
                Blank values are not counted as zero.
              </span>
            </p>
          ) : summary.mealCount === 0 ? (
            <p className="nutrition-partial">
              No meals logged for this day. Enter amounts from your food labels or your own records
              to begin.
            </p>
          ) : null}
          <div className="nutrition-bottom">
            <p>
              Only entered values are totaled, so unlogged nutrients may make totals incomplete.
              These self-reported totals are shared within your duo. Nutrition goals are not a
              health grade and do not affect competition points.
            </p>
            {own && day === today && (
              <button type="button" className="button primary" onClick={onLogMeal} disabled={busy}>
                <Plus size={17} aria-hidden="true" />
                Add meal nutrition
              </button>
            )}
          </div>
          {savedMessage && (
            <p className="nutrition-save-status" role="status">
              {savedMessage}
            </p>
          )}
        </>
      )}
      {supported && editingGoals && own && day === today && profile && (
        <NutritionGoalsForm
          profile={profile}
          today={today}
          onCommand={onCommand}
          onClose={() => setEditingGoals(false)}
          onSaved={() => {
            setEditingGoals(false);
            setSavedMessage('Nutrition goals saved. Your rings are up to date.');
          }}
        />
      )}
    </Card>
  );
}
