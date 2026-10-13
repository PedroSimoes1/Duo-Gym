import { useId, useRef, useState } from 'react';
import { ImagePlus, Plus, Trash2, LockKeyhole, Save } from 'lucide-react';
import type {
  CommandEnvelope,
  ExerciseSet,
  LogInput,
  LogKind,
  LogRecord,
  Profile,
  NutrientKey,
} from '../../shared/contracts';
import { Modal } from './ui';
import type { Gateway } from '../data/http';
import ExercisePicker from './ExercisePicker';
import type { CommonExercise } from '../data/exercises';
import { nutritionFields, validateNutrition } from '../../shared/nutrition';

const titles: Record<LogKind, string> = {
  workout: 'Log a workout',
  cardio: 'Log cardio',
  meal: 'Log a meal',
  hydration: 'Log your water',
  body: 'Add a body record',
};
function localInput(iso: string) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export interface LogFormProps {
  kind: LogKind;
  initial?: LogRecord;
  copiedSets?: ExerciseSet[];
  profile: Profile;
  checklist: string[];
  gateway: Gateway;
  preview: boolean;
  privateMedia: boolean;
  nutritionTracking?: boolean;
  onClose: () => void;
  onSave: (request: CommandEnvelope) => Promise<void>;
}
export default function LogForm({
  kind,
  initial,
  copiedSets,
  profile,
  checklist,
  gateway,
  preview,
  privateMedia,
  nutritionTracking = false,
  onClose,
  onSave,
}: LogFormProps) {
  const [date, setDate] = useState(localInput(initial?.occurredAt || new Date().toISOString()));
  const [title, setTitle] = useState(initial?.title || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [sets, setSets] = useState<ExerciseSet[]>(
    initial?.sets ||
      copiedSets || [
        { exercise: '', equipment: '', repetitions: 8, load: 0, unit: profile.massUnit },
      ],
  );
  const [activity, setActivity] = useState(initial?.activity || 'Walking');
  const [duration, setDuration] = useState(String(initial?.durationMinutes || ''));
  const [distance, setDistance] = useState(String(initial?.distance ?? ''));
  const [distanceUnit, setDistanceUnit] = useState(initial?.distanceUnit || profile.distanceUnit);
  const [steps, setSteps] = useState(String(initial?.steps ?? ''));
  const [water, setWater] = useState(String(initial?.water ?? ''));
  const [waterUnit, setWaterUnit] = useState(initial?.waterUnit || profile.waterUnit);
  const [weight, setWeight] = useState(String(initial?.bodyWeight ?? ''));
  const [bodyUnit, setBodyUnit] = useState(initial?.bodyUnit || profile.massUnit);
  const [waist, setWaist] = useState(String(initial?.waist ?? ''));
  const [measurementUnit, setMeasurementUnit] = useState<'cm' | 'in'>(
    initial?.measurementUnit || 'in',
  );
  const [checks, setChecks] = useState(checklist.map((_, i) => initial?.checklist?.[i] ?? false));
  const [nutrition, setNutrition] = useState<Partial<Record<NutrientKey, string>>>(() =>
    Object.fromEntries(
      nutritionFields.map(({ key }) => [key, String(initial?.nutrition?.[key] ?? '')]),
    ),
  );
  const [shared, setShared] = useState(initial?.shared ?? false);
  const [file, setFile] = useState<File>();
  const [fileName, setFileName] = useState(initial?.mediaId ? 'Previously selected image' : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exerciseFeedback, setExerciseFeedback] = useState('');
  const setId = useId();
  const lock = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const uploaded = useRef<string | undefined>(initial?.mediaId);
  function setSet(index: number, field: keyof ExerciseSet, value: string | number) {
    setSets((current) => current.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  }
  function selectExercise(preset: CommonExercise) {
    // Only reuse a completely unnamed row. Never overwrite typed, copied, or saved exercises.
    const blank = sets.findIndex((set) => !set.exercise.trim() && !set.equipment.trim());
    const index = blank >= 0 ? blank : sets.length;
    if (index >= 100) {
      setExerciseFeedback(
        'This workout already has 100 sets. Edit or remove a set to add another.',
      );
      return;
    }
    const selected: ExerciseSet =
      blank >= 0
        ? { ...sets[blank], exercise: preset.exercise, equipment: preset.equipment }
        : {
            exercise: preset.exercise,
            equipment: preset.equipment,
            repetitions: 8,
            load: 0,
            unit: profile.massUnit,
          };
    setSets((current) =>
      blank >= 0 ? current.map((set, i) => (i === blank ? selected : set)) : [...current, selected],
    );
    setExerciseFeedback(`${preset.exercise} added to set ${index + 1}. Set your reps below.`);
    requestAnimationFrame(() =>
      document
        .getElementById(`${setId}-${index}`)
        ?.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const occurredAt = new Date(date).toISOString();
      if (new Date(occurredAt).getTime() > Date.now())
        throw new Error('Choose a time that has already happened.');
      if (file && !uploaded.current) {
        if (!privateMedia)
          throw new Error('Secure photo storage is not connected. Photos cannot be saved yet.');
        uploaded.current = (await gateway.upload(file, kind === 'body' ? 'body' : 'meals')).mediaId;
      }
      const log: LogInput = {
        kind,
        occurredAt,
        title:
          title.trim() ||
          {
            workout: 'Strength workout',
            cardio: activity,
            meal: 'Meal',
            hydration: 'Daily hydration',
            body: 'Body check-in',
          }[kind],
        notes: notes.trim(),
      };
      if (kind === 'workout') {
        if (
          sets.some(
            (s) =>
              !s.exercise.trim() ||
              !s.equipment.trim() ||
              s.repetitions < 1 ||
              !Number.isInteger(s.repetitions),
          )
        )
          throw new Error('Complete every exercise, equipment, and repetition count.');
        Object.assign(log, { sets, completed: true });
      }
      if (kind === 'cardio')
        Object.assign(log, {
          activity,
          durationMinutes: Number(duration),
          ...(distance ? { distance: Number(distance), distanceUnit } : {}),
          ...(steps ? { steps: Number(steps) } : {}),
        });
      if (kind === 'meal')
        Object.assign(log, {
          checklist: checks,
          ...(uploaded.current ? { mediaId: uploaded.current } : {}),
          ...(nutritionTracking
            ? {
                nutrition: validateNutrition(
                  Object.fromEntries(
                    nutritionFields
                      .filter(({ key }) => nutrition[key]?.trim())
                      .map(({ key }) => [key, Number(nutrition[key])]),
                  ),
                ),
              }
            : initial?.nutrition
              ? { nutrition: initial.nutrition }
              : {}),
        });
      if (kind === 'hydration') Object.assign(log, { water: Number(water), waterUnit });
      if (kind === 'body') {
        if (!weight && !waist && !uploaded.current) throw new Error('Add a weight or measurement.');
        Object.assign(log, {
          ...(weight ? { bodyWeight: Number(weight), bodyUnit } : {}),
          ...(waist ? { waist: Number(waist), measurementUnit } : {}),
          ...(uploaded.current ? { mediaId: uploaded.current } : {}),
          shared,
        });
      }
      const command = initial
        ? { type: 'log.update' as const, id: initial.id, expectedVersion: initial.version, log }
        : { type: 'log.create' as const, log };
      const key = JSON.stringify(command);
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
      await onSave({ requestId: request.current.id, command });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Please retry.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={initial ? 'Edit record' : copiedSets ? 'Complete your copied workout' : titles[kind]}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} className="log-form">
        {preview && (
          <p className="form-notice">
            Local preview only. Use sample information; this is not a private account.
          </p>
        )}
        {copiedSets && (
          <p className="form-notice">
            Editable draft. No points are counted until you complete and save.
          </p>
        )}
        {kind === 'body' && (
          <p className="privacy-note">
            <LockKeyhole size={17} />
            Private by default. Body changes never earn points.
          </p>
        )}
        {kind === 'workout' && (
          <ExercisePicker
            onSelect={selectExercise}
            defaultMode={initial || copiedSets ? 'custom' : 'common'}
            disabled={busy}
          />
        )}
        <label>
          {kind === 'meal' ? 'Brief description' : 'Title (optional)'}
          <input
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder={
              kind === 'workout'
                ? 'e.g. Upper body'
                : kind === 'meal'
                  ? 'e.g. Chicken, rice & greens'
                  : 'Give this entry a name'
            }
            required={kind === 'meal'}
            autoFocus={kind !== 'workout' || Boolean(initial || copiedSets)}
          />
        </label>
        <label>
          Activity date & time
          <input
            name="occurredAt"
            type="datetime-local"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <small>Entered in your device’s timezone. Competition days use New York time.</small>
        </label>
        {kind === 'workout' && (
          <fieldset>
            <legend>Exercise sets</legend>
            {exerciseFeedback && (
              <p className="exercise-added" role="status">
                {exerciseFeedback}
              </p>
            )}
            {sets.map((s, i) => (
              <div className="set-card" key={i} id={`${setId}-${i}`}>
                <div className="set-heading">
                  <span>SET {i + 1}</span>
                  {sets.length > 1 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove set ${i + 1}`}
                      onClick={() => setSets((v) => v.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
                <div className="form-grid">
                  <label>
                    Exercise
                    <input
                      aria-label={`Exercise ${i + 1}`}
                      value={s.exercise}
                      onChange={(e) => setSet(i, 'exercise', e.target.value)}
                      placeholder="Bench press"
                      required
                      maxLength={100}
                    />
                  </label>
                  <label>
                    Equipment / variation
                    <input
                      aria-label={`Equipment ${i + 1}`}
                      value={s.equipment}
                      onChange={(e) => setSet(i, 'equipment', e.target.value)}
                      placeholder="Barbell · flat"
                      required
                      maxLength={100}
                    />
                  </label>
                </div>
                <div className="form-grid">
                  <label>
                    Reps
                    <input
                      aria-label={`Repetitions ${i + 1}`}
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="1000"
                      step="1"
                      value={s.repetitions}
                      onChange={(e) => setSet(i, 'repetitions', Number(e.target.value))}
                      required
                    />
                  </label>
                  <label>
                    Unit
                    <select
                      aria-label={`Load unit ${i + 1}`}
                      value={s.unit}
                      onChange={(e) => setSet(i, 'unit', e.target.value)}
                    >
                      <option>lb</option>
                      <option>kg</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="button secondary full"
              disabled={busy || sets.length >= 100}
              onClick={() => setSets((v) => [...v, { ...v[v.length - 1] }])}
            >
              <Plus size={17} />
              Add a set
            </button>
          </fieldset>
        )}
        {kind === 'cardio' && (
          <>
            <label>
              Activity
              <select value={activity} onChange={(e) => setActivity(e.target.value)}>
                {['Walking', 'Running', 'Cycling', 'Swimming', 'Rowing', 'Elliptical', 'Other'].map(
                  (a) => (
                    <option key={a}>{a}</option>
                  ),
                )}
              </select>
            </label>
            <div className="form-grid">
              <label>
                Duration (minutes)
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.1"
                  max="1440"
                  step="0.1"
                  required
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                />
              </label>
              <label>
                Steps (optional)
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  max="200000"
                  step="1"
                  value={steps}
                  onChange={(e) => setSteps(e.target.value)}
                />
              </label>
            </div>
            <div className="form-grid">
              <label>
                Distance (optional)
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  value={distance}
                  onChange={(e) => setDistance(e.target.value)}
                />
              </label>
              <label>
                Distance unit
                <select
                  value={distanceUnit}
                  onChange={(e) => setDistanceUnit(e.target.value as typeof distanceUnit)}
                >
                  <option>mi</option>
                  <option>km</option>
                </select>
              </label>
            </div>
            <p className="helper">
              Your agreed qualifying session: {profile.targets.cardioActivity}, at least{' '}
              {profile.targets.cardioMinimumMinutes} minutes. A personal agreement, not an exercise
              prescription.
            </p>
          </>
        )}
        {kind === 'meal' && nutritionTracking && (
          <fieldset className="meal-nutrition-fields">
            <legend>
              Nutrition for this meal <span className="small-tag">OPTIONAL</span>
            </legend>
            <p className="helper">
              Enter totals for the portion you ate, from a label or your own calculation. Leave
              unknown values blank. No photo estimates.
            </p>
            <div className="form-grid">
              {nutritionFields.slice(0, 4).map((field) => (
                <label key={field.key}>
                  {field.label} ({field.unit})
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max={field.max}
                    step="any"
                    placeholder="Not entered"
                    value={nutrition[field.key] ?? ''}
                    onChange={(event) =>
                      setNutrition((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
            <details
              className="meal-extra-nutrients"
              open={
                nutritionFields
                  .slice(4)
                  .some(({ key }) => initial?.nutrition?.[key] !== undefined) || undefined
              }
            >
              <summary>Fiber, sugar & sodium (optional)</summary>
              <div className="form-grid">
                {nutritionFields.slice(4).map((field) => (
                  <label key={field.key}>
                    {field.label} ({field.unit})
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max={field.max}
                      step="any"
                      placeholder="Not entered"
                      value={nutrition[field.key] ?? ''}
                      onChange={(event) =>
                        setNutrition((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
            </details>
            <small>
              Added to your daily rings even without a photo. Shared with your duo as part of the
              meal; nutrition amounts never earn points.
            </small>
          </fieldset>
        )}
        {(kind === 'meal' || kind === 'body') && (
          <div className="photo-picker">
            <ImagePlus size={26} />
            <strong>
              {privateMedia ? 'Choose one existing image' : 'Photo storage is not connected'}
            </strong>
            <p>
              {privateMedia
                ? 'The selected image will be uploaded and stored privately. No library scanning or in-app camera.'
                : 'You can preview the other form controls. Image upload will unlock once private storage is verified.'}
            </p>
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              aria-label="Choose existing image"
              disabled={!privateMedia}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (
                  f &&
                  (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type) ||
                    f.size > 10 * 1024 * 1024)
                ) {
                  setError(
                    'Use a JPEG, PNG, or WebP image under 10 MB. Convert HEIC to JPEG in Photos or Files first.',
                  );
                  e.target.value = '';
                  return;
                }
                setFile(f);
                setFileName(f?.name || '');
                uploaded.current = undefined;
                setError('');
              }}
            />
            {fileName && <small>{fileName}</small>}
            <small>JPEG, PNG, WebP · max 10 MB. For HEIC, export a JPEG first.</small>
          </div>
        )}
        {kind === 'meal' && (
          <fieldset>
            <legend>Self-reported meal checklist</legend>
            {checklist.map((item, i) => (
              <label className="check-label" key={i}>
                <input
                  type="checkbox"
                  checked={checks[i]}
                  onChange={(e) =>
                    setChecks((c) => c.map((v, j) => (j === i ? e.target.checked : v)))
                  }
                />
                <span>{item}</span>
              </label>
            ))}
            <p className="helper">
              One qualifying day counts, however many meals you log. Photos do not prove nutrition
              or calories.
              {!privateMedia ? ' Meals saved without a photo do not earn preview points.' : ''}
            </p>
          </fieldset>
        )}
        {kind === 'hydration' && (
          <>
            <div className="form-grid">
              <label>
                Daily total
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100000"
                  step="0.1"
                  required
                  value={water}
                  onChange={(e) => setWater(e.target.value)}
                />
              </label>
              <label>
                Unit
                <select
                  value={waterUnit}
                  onChange={(e) => setWaterUnit(e.target.value as typeof waterUnit)}
                >
                  <option>ml</option>
                  <option>L</option>
                  <option>fl oz</option>
                </select>
              </label>
            </div>
            <p className="helper">
              Enter your total for the day, not an additional amount. More than your target earns no
              extra points.
            </p>
          </>
        )}
        {kind === 'body' && (
          <>
            <div className="form-grid">
              <label>
                Weight (optional)
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.1"
                  max="2000"
                  step="0.1"
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                />
              </label>
              <label>
                Weight unit
                <select
                  value={bodyUnit}
                  onChange={(e) => setBodyUnit(e.target.value as typeof bodyUnit)}
                >
                  <option>lb</option>
                  <option>kg</option>
                </select>
              </label>
              <label>
                Waist (optional)
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.1"
                  max="1000"
                  step="0.1"
                  value={waist}
                  onChange={(e) => setWaist(e.target.value)}
                />
              </label>
              <label>
                Measurement unit
                <select
                  value={measurementUnit}
                  onChange={(e) => setMeasurementUnit(e.target.value as 'cm' | 'in')}
                >
                  <option>in</option>
                  <option>cm</option>
                </select>
              </label>
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
              />
              <span>Share this individual record with my partner</span>
            </label>
            <p className="helper">You can revoke sharing from this record at any time.</p>
          </>
        )}
        <label>
          Notes (optional)
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="How did it feel?"
          />
        </label>
        <p className="helper">
          Log within 48 hours for points. Older entries stay in your history without points. Future
          activity times are not accepted.
        </p>
        {error && (
          <div role="alert" className="error-box">
            {error}
          </div>
        )}
        <footer className="form-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            <Save size={17} />
            {busy ? 'Saving…' : kind === 'workout' ? 'Complete & save' : 'Save record'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
