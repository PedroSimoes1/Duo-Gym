import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Copy,
  Droplets,
  Dumbbell,
  Heart,
  Home,
  Leaf,
  LockKeyhole,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Target,
  Trash2,
  Trophy,
  Users,
  Utensils,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  Bootstrap,
  Command,
  CommandEnvelope,
  ExerciseSet,
  LogKind,
  LogRecord,
  Profile,
  ScoreBreakdown,
  Targets,
} from '../shared/contracts';
import { weekKey, dateKey } from '../shared/time';
import { HttpGateway } from './data/http';
import type { Gateway } from './data/http';
import { PreviewGateway, resetPreview } from './data/preview';
import { isSupabaseConfigured, SupabaseGateway } from './data/supabase';
import {
  Breakdown,
  Card,
  categories,
  displayDate,
  Empty,
  LineChart,
  Modal,
  points,
  ScoreRing,
  SectionTitle,
  StatusPill,
  TextLink,
} from './components/ui';
import LogForm from './components/LogForm';
import NutritionPanel from './components/NutritionPanel';
import { nutritionFields } from '../shared/nutrition';

type Page = 'today' | 'workouts' | 'food' | 'progress' | 'competition' | 'settings';
const navigation: { id: Page; label: string; short: string; icon: LucideIcon }[] = [
  { id: 'today', label: 'Today', short: 'Today', icon: Home },
  { id: 'workouts', label: 'Workouts', short: 'Train', icon: Dumbbell },
  { id: 'food', label: 'Meals & water', short: 'Food', icon: Utensils },
  { id: 'progress', label: 'My progress', short: 'Progress', icon: Activity },
  { id: 'competition', label: 'The competition', short: 'Duo', icon: Trophy },
  { id: 'settings', label: 'Settings', short: 'Settings', icon: Settings },
];
const logMeta: Record<LogKind, { icon: LucideIcon; color: string; label: string }> = {
  workout: { icon: Dumbbell, color: 'lime', label: 'Strength' },
  cardio: { icon: Heart, color: 'lavender', label: 'Cardio' },
  meal: { icon: Utensils, color: 'peach', label: 'Meal' },
  hydration: { icon: Droplets, color: 'blue', label: 'Water' },
  body: { icon: Activity, color: 'lavender', label: 'Body' },
};
const zero: ScoreBreakdown = {
  strength: 0,
  meals: 0,
  cardio: 0,
  hydration: 0,
  improvement: 0,
  total: 0,
};
function currentPage(): Page {
  const hash = window.location.hash.slice(1);
  return navigation.some((n) => n.id === hash) ? (hash as Page) : 'today';
}
function connectedGateway() {
  if (isSupabaseConfigured) return new SupabaseGateway();
  return new HttpGateway(undefined, import.meta.env.VITE_API_BASE_URL || '/api/v1');
}

export default function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [gateway, setGateway] = useState<Gateway>(connectedGateway);
  const [data, setData] = useState<Bootstrap>();
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{
    kind: LogKind;
    initial?: LogRecord;
    copiedSets?: ExerciseSet[];
  }>();
  const [deleteRecord, setDeleteRecord] = useState<LogRecord>();
  const [rules, setRules] = useState(false);
  const [connectionHelp, setConnectionHelp] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginStep, setLoginStep] = useState<'email' | 'code'>('email');
  const [progressTab, setProgressTab] = useState<'strength' | 'cardio' | 'body'>('strength');
  const [workoutTab, setWorkoutTab] = useState<'history' | 'templates'>('history');
  const [selectedWeek, setSelectedWeek] = useState(weekKey(new Date().toISOString()));
  const mutationLock = useRef(false);
  const requests = useRef(new Map<string, string>());
  useEffect(() => {
    let active = true;
    gateway
      .bootstrap()
      .then((d) => {
        if (active) {
          setData(d);
          setConnectionError('');
        }
      })
      .catch((e) => {
        if (active) setConnectionError(e instanceof Error ? e.message : 'Backend not connected.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [gateway]);
  useEffect(() => {
    const handle = () => setPage(currentPage());
    window.addEventListener('hashchange', handle);
    return () => window.removeEventListener('hashchange', handle);
  }, []);
  function navigate(next: Page) {
    setPage(next);
    window.location.hash = next;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  async function openPreview() {
    setLoading(true);
    setPreview(true);
    setGateway(new PreviewGateway());
  }
  async function refresh() {
    setLoading(true);
    setError('');
    try {
      setData(await gateway.bootstrap());
      setConnectionError('');
    } catch (e) {
      setConnectionError(e instanceof Error ? e.message : 'Unable to connect.');
      setError('Could not refresh. Your saved view is still here. Try again.');
    } finally {
      setLoading(false);
    }
  }
  async function execute(envelope: CommandEnvelope) {
    if (mutationLock.current) throw new Error('A save is already in progress. Please wait.');
    mutationLock.current = true;
    setBusy(true);
    setError('');
    try {
      setData(await gateway.execute(envelope));
      setNotice(preview ? 'Saved in this browser’s local preview.' : 'Saved to your account.');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save. Please retry.';
      setError(message);
      throw e;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function command(command: Command) {
    const key = JSON.stringify(command);
    const requestId = requests.current.get(key) || crypto.randomUUID();
    requests.current.set(key, requestId);
    await execute({ requestId, command });
    requests.current.delete(key);
  }
  async function run(commandValue: Command) {
    try {
      await command(commandValue);
    } catch {
      /* inline error keeps the action available */
    }
  }
  async function exportData() {
    try {
      const exported = await gateway.exportOwn();
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `duo-${preview ? 'preview-' : ''}export-${dateKey(new Date().toISOString())}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Your own records were exported.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed. Please retry.');
    }
  }
  async function exit() {
    try {
      await gateway.logout();
      setData(undefined);
      setPreview(false);
      setLoading(true);
      setGateway(connectedGateway());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign out.');
    }
  }
  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!gateway.sendLoginCode || !gateway.verifyLoginCode) {
        throw new Error('Add the Supabase connection values to .env.local, then restart the app.');
      }
      if (loginStep === 'email') {
        await gateway.sendLoginCode(loginEmail);
        setLoginStep('code');
        setNotice('A six-digit sign-in code was sent to your invited email.');
      } else {
        await gateway.verifyLoginCode(loginEmail, loginCode);
        setData(await gateway.bootstrap());
        setConnectionHelp(false);
        setConnectionError('');
        setNotice('Signed in to your private competition.');
      }
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Sign-in failed. Please retry.');
    } finally {
      setBusy(false);
    }
  }
  if (loading && !data)
    return (
      <main className="loading-screen">
        <div className="brand-mark">
          <TwinPlatesMark />
        </div>
        <p>
          Getting your space ready<span className="loading-dots">…</span>
        </p>
      </main>
    );
  if (!data)
    return (
      <main className="welcome">
        <div className="welcome-top">
          <Brand />
          <span className="outline-tag">YOUR HABITS. YOUR PACE.</span>
        </div>
        <div className="welcome-grid">
          <div>
            <span className="eyebrow lime-text">A LITTLE BETTER, TOGETHER</span>
            <h1>
              Show up.
              <br />
              Build strength.
              <br />
              <em>Bring a friend.</em>
            </h1>
            <p>
              A shared commitment to the little things that add up. Your workouts, your habits, your
              own kind of progress.
            </p>
            <div className="welcome-actions">
              <button className="button primary" onClick={openPreview}>
                Explore local preview
                <ArrowRight size={18} />
              </button>
              <button className="button secondary" onClick={() => setConnectionHelp(true)}>
                Connect backend
              </button>
            </div>
            <div className="welcome-note">
              <LockKeyhole size={17} />
              <span>
                {isSupabaseConfigured
                  ? 'Private login is connected. Only the two invited accounts can enter.'
                  : 'The backend code is present, but this device still needs its Supabase connection values. Preview data is fictional and stays in this browser.'}
              </span>
            </div>
          </div>
          <Card className="welcome-preview">
            <div className="section-title">
              <span className="eyebrow">BUILT AROUND YOU</span>
              <Sparkles size={20} />
            </div>
            <div className="welcome-symbol">
              <Dumbbell size={82} strokeWidth={1} />
            </div>
            <h2>Consistency wins.</h2>
            <p>
              Five ways to show up.
              <br />
              One hundred possible points.
              <br />
              Two people cheering each other on.
            </p>
            <div className="color-dots">
              {categories.map((c) => (
                <i key={c.key} style={{ background: c.color }} />
              ))}
            </div>
          </Card>
        </div>
        <footer>No tracking. No body rankings. Just your agreed habits.</footer>
        {connectionHelp && (
          <Modal title="Connect your backend" onClose={() => setConnectionHelp(false)}>
            <div className="modal-content">
              {isSupabaseConfigured ? (
                <>
                  <p>Sign in with one of the two email addresses invited in Supabase.</p>
                  <form className="stack" onSubmit={submitLogin}>
                    <label>
                      Email
                      <input
                        type="email"
                        autoComplete="email"
                        value={loginEmail}
                        onChange={(event) => setLoginEmail(event.target.value)}
                        disabled={busy || loginStep === 'code'}
                        required
                      />
                    </label>
                    {loginStep === 'code' && (
                      <label>
                        Six-digit code
                        <input
                          type="text"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          pattern="[0-9]{6}"
                          maxLength={6}
                          value={loginCode}
                          onChange={(event) => setLoginCode(event.target.value.replace(/\D/g, ''))}
                          required
                        />
                      </label>
                    )}
                    <div className="button-row">
                      {loginStep === 'code' && (
                        <button
                          className="button secondary"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setLoginCode('');
                            setLoginStep('email');
                          }}
                        >
                          Use another email
                        </button>
                      )}
                      <button className="button primary" type="submit" disabled={busy}>
                        {loginStep === 'email' ? 'Send sign-in code' : 'Verify and enter'}
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <>
                  <p>
                    Create <code>.env.local</code> from <code>.env.example</code>, add the project
                    URL and publishable key from Supabase, then restart the local app. These two
                    values identify the project; they are not the private service-role credential.
                  </p>
                  <p>
                    Run the migrations in <code>supabase/migrations</code> first, then add exactly
                    two invited users using the private setup instructions.
                  </p>
                </>
              )}
              <details>
                <summary>Connection details</summary>
                <p>{connectionError || 'No authenticated session returned.'}</p>
              </details>
              {!isSupabaseConfigured && (
                <div className="button-row">
                  <button
                    className="button primary"
                    onClick={() => {
                      setConnectionHelp(false);
                      void refresh();
                    }}
                  >
                    Retry connection
                  </button>
                </div>
              )}
              {error && <p className="error-banner">{error}</p>}
            </div>
          </Modal>
        )}
      </main>
    );
  const me = data.profiles.find((p) => p.id === data.currentUserId)!;
  const partner = data.profiles.find((p) => p.id !== data.currentUserId);
  const week = weekKey(new Date().toISOString(), data.competition.timezone);
  const mine = data.weeks.find((w) => w.ownerId === me.id && w.week === week);
  const mineLogs = data.logs
    .filter((l) => l.ownerId === me.id)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const todayKey = dateKey(new Date().toISOString(), data.competition.timezone);
  const todayLogs = mineLogs.filter(
    (l) => dateKey(l.occurredAt, data.competition.timezone) === todayKey,
  );
  const weekList = [...new Set([...data.weeks.map((w) => w.week), week])].sort().reverse();
  const summary = mine?.points || zero;
  function startLog(kind: LogKind) {
    const initial =
      kind === 'hydration' ? todayLogs.find((l) => l.kind === 'hydration') : undefined;
    setForm({ kind, initial });
  }
  function recordActions(record: LogRecord) {
    return record.ownerId === me.id ? (
      <div className="record-actions">
        <button
          className="icon-button"
          aria-label={`Edit ${record.title}`}
          onClick={() => setForm({ kind: record.kind, initial: record })}
        >
          <Pencil size={16} />
        </button>
        {record.kind === 'workout' && (
          <button
            className="icon-button"
            aria-label={`Copy ${record.title} as draft`}
            onClick={() =>
              setForm({ kind: 'workout', copiedSets: record.sets?.map((s) => ({ ...s })) })
            }
          >
            <Copy size={16} />
          </button>
        )}
        <button
          className="icon-button danger-text"
          aria-label={`Delete ${record.title}`}
          onClick={() => setDeleteRecord(record)}
        >
          <Trash2 size={16} />
        </button>
      </div>
    ) : null;
  }
  function recordList(records: LogRecord[], withOwner = false) {
    return records.length ? (
      <div className="record-list">
        {records.map((l) => {
          const meta = logMeta[l.kind];
          const Icon = meta.icon;
          return (
            <article className="record" key={l.id}>
              <span className={`activity-icon ${meta.color}`}>
                <Icon size={20} />
              </span>
              <div className="record-content">
                <div className="record-title">
                  <strong>{l.title}</strong>
                  <StatusPill record={l} />
                </div>
                <p>
                  {withOwner
                    ? `${data!.profiles.find((p) => p.id === l.ownerId)?.displayName || 'Member'} · `
                    : ''}
                  {displayDate(l.occurredAt)} ·{' '}
                  {l.kind === 'workout'
                    ? `${l.sets?.length || 0} sets`
                    : l.kind === 'cardio'
                      ? `${l.durationMinutes} min${l.distance ? ` · ${l.distance} ${l.distanceUnit}` : ''}`
                      : l.kind === 'hydration'
                        ? `${l.water} ${l.waterUnit} total`
                        : l.kind === 'body'
                          ? `${l.bodyWeight ? `${l.bodyWeight} ${l.bodyUnit}` : ''}${l.waist ? ` · waist ${l.waist} ${l.measurementUnit}` : ''}`
                          : 'Self-reported'}
                </p>
                {l.notes && <p className="record-notes">{l.notes}</p>}
                {l.kind === 'meal' && l.nutrition && Object.keys(l.nutrition).length > 0 && (
                  <p className="record-nutrition">
                    {nutritionFields
                      .filter(({ key }) => l.nutrition?.[key] !== undefined)
                      .map(
                        ({ key, label, unit }) =>
                          `${label}: ${l.nutrition![key]!.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${unit}`,
                      )
                      .join(' · ')}
                  </p>
                )}
                {l.eligibilityReason && <small>{l.eligibilityReason}</small>}
                {l.kind === 'workout' && (
                  <details className="set-details">
                    <summary>View sets</summary>
                    {l.sets?.map((s, i) => (
                      <p key={i}>
                        {s.exercise} · {s.equipment} · {s.repetitions} reps
                        {s.load > 0 ? ` × ${s.load} ${s.unit}` : ''}
                      </p>
                    ))}
                    <button
                      className="text-link"
                      disabled={busy}
                      onClick={() =>
                        void run({ type: 'template.save', name: l.title, sets: l.sets || [] })
                      }
                    >
                      Save as template
                      <Plus size={14} />
                    </button>
                  </details>
                )}
                {l.kind === 'body' && (
                  <button
                    className="sharing-button"
                    disabled={busy}
                    onClick={() =>
                      void run({
                        type: 'body.share',
                        id: l.id,
                        expectedVersion: l.version,
                        shared: !l.shared,
                      })
                    }
                  >
                    {l.shared ? <Users size={14} /> : <LockKeyhole size={14} />}{' '}
                    {l.shared ? 'Shared with partner · revoke' : 'Only me · share record'}
                  </button>
                )}
              </div>
              {recordActions(l)}
            </article>
          );
        })}
      </div>
    ) : (
      <Empty title="A fresh page">Your next entry starts the story.</Empty>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-caption">YOUR EVERYDAY, BETTER.</div>
        <nav aria-label="Main navigation">
          {navigation.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate(n.id)}
              aria-current={page === n.id ? 'page' : undefined}
            >
              <n.icon size={19} />
              <span>{n.label}</span>
              {page === n.id && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="profile-button" onClick={() => navigate('settings')}>
            <span className="avatar">YOU</span>
            <span>
              <strong>{me.displayName}</strong>
              <small>{preview ? 'Local preview' : 'Your profile'}</small>
            </span>
            <MoreHorizontal size={19} />
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="mobile-brand">
            <Brand />
          </div>
          <div className="breadcrumb">
            <button
              type="button"
              className="breadcrumb-home"
              onClick={() => navigate('today')}
              aria-label="Return to Today"
            >
              YOUR SPACE
            </button>
            <ChevronRight size={13} />
            <span>{navigation.find((n) => n.id === page)?.label}</span>
          </div>
          <div className="topbar-right">
            <span className="workspace-pill">
              <span />
              {preview ? 'Local preview' : 'Members only'}
            </span>
            <button
              className="icon-button"
              onClick={() => setRules(true)}
              aria-label="Scoring rules"
            >
              <CircleHelp size={20} />
            </button>
          </div>
        </header>
        {preview && (
          <div className="preview-banner">
            <span>
              <strong>LOCAL PREVIEW</strong> Fictional data · stored in this browser · no secure
              accounts
            </span>
            <button onClick={exit}>
              Exit
              <X size={14} />
            </button>
          </div>
        )}
        <main className="page-content" id="main-content">
          {notice && (
            <div className="toast" role="status">
              <CheckCheck size={17} />
              {notice}
              <button
                className="icon-button"
                aria-label="Dismiss saved message"
                onClick={() => setNotice('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
              <button className="text-link" onClick={refresh}>
                Refresh saved data
                <RefreshCw size={15} />
              </button>
            </div>
          )}
          {page === 'today' && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    {displayDate(new Date().toISOString(), {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </span>
                  <h1>
                    Your pace.
                    <br className="mobile-break" /> <span>Your progress.</span>
                  </h1>
                  <p>Every small effort adds up. Let’s make room for one today.</p>
                </div>
                <div className="week-chip">
                  <i />
                  <span>
                    Week of {displayDate(week)}
                    <small>New York time · provisional</small>
                  </span>
                </div>
              </div>
              <div className="dashboard-grid">
                <Card className="weekly-card">
                  <SectionTitle
                    eyebrow="THE WEEK SO FAR"
                    title="Look at you showing up."
                    action={<span className="small-tag">{preview ? 'PREVIEW' : 'THIS WEEK'}</span>}
                  />
                  <div className="weekly-core">
                    <ScoreRing value={summary.total} />
                    <div className="weekly-message">
                      <span className="tiny-label">YOUR WEEKLY POINTS</span>
                      <h3>
                        A little effort.
                        <br />A lasting habit.
                      </h3>
                      <p>
                        Show up for your own goals.
                        <br />
                        Every category has a cap.
                      </p>
                      <button className="text-link" onClick={() => navigate('competition')}>
                        See the breakdown
                        <ArrowUpRight size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="category-strip">
                    {categories.map((c) => (
                      <div key={c.key}>
                        <i style={{ background: c.color }} />
                        <small>{c.label}</small>
                        <strong>
                          {points(summary[c.key])}
                          <span>/{c.max}</span>
                        </strong>
                      </div>
                    ))}
                  </div>
                </Card>
                <Card className="quick-card">
                  <SectionTitle eyebrow="A MOMENT FOR YOU" title="Log something good." />
                  <div className="quick-actions">
                    {(['workout', 'meal', 'cardio', 'hydration'] as LogKind[]).map((k) => {
                      const m = logMeta[k];
                      return (
                        <button
                          key={k}
                          className={`quick-action ${m.color}`}
                          onClick={() => startLog(k)}
                        >
                          <m.icon size={24} strokeWidth={1.6} />
                          <span>
                            {k === 'workout' ? 'Workout' : k === 'hydration' ? 'Water' : m.label}
                          </span>
                          <Plus size={17} />
                        </button>
                      );
                    })}
                  </div>
                  <p className="quick-foot">
                    <LockKeyhole size={14} />
                    Manual logging. Always on your terms.
                  </p>
                </Card>
              </div>
              <div className="target-grid">
                {[
                  {
                    icon: Dumbbell,
                    label: 'Strength days',
                    value: mine?.days.strength || 0,
                    target: me.targets.strength,
                    unit: 'days',
                    color: 'lime',
                  },
                  {
                    icon: Heart,
                    label: 'Cardio days',
                    value: mine?.days.cardio || 0,
                    target: me.targets.cardio,
                    unit: 'days',
                    color: 'lavender',
                  },
                  {
                    icon: Utensils,
                    label: 'Meal consistency',
                    value: mine?.days.meals || 0,
                    target: 5,
                    unit: 'days',
                    color: 'peach',
                  },
                  {
                    icon: Droplets,
                    label: 'Hydration days',
                    value: mine?.days.hydration || 0,
                    target: 7,
                    unit: 'days',
                    color: 'blue',
                  },
                ].map((t) => (
                  <Card className="target-card" key={t.label}>
                    <span className={`activity-icon ${t.color}`}>
                      <t.icon size={20} />
                    </span>
                    <span className="target-label">{t.label}</span>
                    <div className="target-value">
                      {t.value}
                      <span>
                        {' '}
                        / {t.target} <small>{t.unit}</small>
                      </span>
                    </div>
                    <div className={`track ${t.color}`}>
                      <div style={{ width: `${Math.min(t.value / t.target, 1) * 100}%` }} />
                    </div>
                  </Card>
                ))}
              </div>
              <div className="lower-grid">
                <Card>
                  <SectionTitle
                    title="Your rhythm"
                    action={<span className="tiny-label">THIS WEEK</span>}
                  />
                  <WeekRhythm logs={mineLogs} week={week} today={todayKey} />
                  <p className="helper">
                    Any completed workout, cardio, meal, or water log. No streak penalties.
                  </p>
                </Card>
                <Card className="partner-card">
                  <div className="partner-heading">
                    <div className="overlap-avatars">
                      <span>YOU</span>
                      <span>{partner?.initials || '?'}</span>
                    </div>
                    <span className="small-tag">YOUR DUO</span>
                  </div>
                  <h2>
                    Different goals.
                    <br />
                    Same commitment.
                  </h2>
                  <p>
                    You each have 100 possible points a week. It’s the effort toward your own
                    targets that counts.
                  </p>
                  <TextLink onClick={() => navigate('competition')}>Visit the competition</TextLink>
                </Card>
              </div>
              <Card>
                <SectionTitle
                  title="Today’s little wins"
                  action={<TextLink onClick={() => navigate('workouts')}>View history</TextLink>}
                />
                {todayLogs.length ? (
                  recordList(todayLogs)
                ) : (
                  <Empty title="Your day is a blank canvas">
                    Log a little effort when you’re ready.
                  </Empty>
                )}
              </Card>
            </>
          )}
          {page === 'workouts' && (
            <>
              <PageHeading
                eyebrow="BUILD YOUR BASE"
                title="Stronger, one session at a time."
                description="Your sessions, saved your way. A workout day counts once."
                action={
                  <button className="button primary" onClick={() => setForm({ kind: 'workout' })}>
                    <Plus size={18} />
                    Log workout
                  </button>
                }
              />
              <div className="toolbar">
                <div className="tabs">
                  <button
                    className={workoutTab === 'history' ? 'selected' : ''}
                    onClick={() => setWorkoutTab('history')}
                  >
                    History
                  </button>
                  <button
                    className={workoutTab === 'templates' ? 'selected' : ''}
                    onClick={() => setWorkoutTab('templates')}
                  >
                    Templates
                  </button>
                </div>
                <button className="button secondary" onClick={() => setForm({ kind: 'cardio' })}>
                  <Heart size={17} />
                  Log cardio
                </button>
              </div>
              {workoutTab === 'history' ? (
                <Card>
                  {recordList(mineLogs.filter((l) => l.kind === 'workout' || l.kind === 'cardio'))}
                </Card>
              ) : (
                <div className="template-grid">
                  {data.templates.length ? (
                    data.templates.map((t) => (
                      <Card key={t.id} className="template-card">
                        <span className="activity-icon lime">
                          <Dumbbell size={24} />
                        </span>
                        <h2>{t.name}</h2>
                        <p>
                          {t.sets.length} sets · {new Set(t.sets.map((s) => s.exercise)).size}{' '}
                          exercises
                        </p>
                        <ul>
                          {[...new Set(t.sets.map((s) => s.exercise))].map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ul>
                        <button
                          className="button secondary full"
                          onClick={() =>
                            setForm({ kind: 'workout', copiedSets: t.sets.map((s) => ({ ...s })) })
                          }
                        >
                          <Copy size={16} />
                          Use as editable draft
                        </button>
                        <small>No points until completed and saved.</small>
                      </Card>
                    ))
                  ) : (
                    <Card>
                      <Empty title="Keep your favorites close">
                        Save a workout as a template from its history entry.
                      </Empty>
                    </Card>
                  )}
                </div>
              )}
            </>
          )}
          {page === 'food' && (
            <>
              <PageHeading
                eyebrow="THE EVERYDAY ESSENTIALS"
                title="Nourish. Hydrate. Repeat."
                description="Your daily fuel, at a glance. Manual nutrition tracking, without food judgments."
              />
              <NutritionPanel
                data={data}
                onCommand={command}
                onLogMeal={() => setForm({ kind: 'meal' })}
                busy={busy}
              />
              <div className="food-grid">
                <Card className="meal-feature">
                  <span className="activity-icon peach">
                    <Utensils size={27} />
                  </span>
                  <h2>A moment for your meal.</h2>
                  <p>
                    Add a brief description and confirm your agreed checklist. One qualifying meal
                    day is enough.
                  </p>
                  <button className="button primary" onClick={() => setForm({ kind: 'meal' })}>
                    <Plus size={18} />
                    Log a meal
                  </button>
                </Card>
                <Card className="water-feature">
                  <span className="activity-icon blue">
                    <Droplets size={27} />
                  </span>
                  <h2>Keep it simple.</h2>
                  <p>
                    Your agreed daily water target is{' '}
                    <strong>{me.targets.waterMl.toLocaleString()} ml</strong>. Meeting it counts.
                    Extra water earns no more points.
                  </p>
                  <button className="button secondary" onClick={() => startLog('hydration')}>
                    <Plus size={18} />
                    Update daily water
                  </button>
                </Card>
              </div>
              <Card>
                <SectionTitle
                  title="Meals & water history"
                  action={<span className="small-tag">SELF-REPORTED</span>}
                />
                {recordList(mineLogs.filter((l) => l.kind === 'meal' || l.kind === 'hydration'))}
              </Card>
            </>
          )}
          {page === 'progress' && (
            <>
              <PageHeading
                eyebrow="YOUR ONLY COMPARISON IS YOU"
                title="See how far you’ve come."
                description="Personal performance trends. Body changes never earn points."
              />
              <div className="tabs wide">
                <button
                  className={progressTab === 'strength' ? 'selected' : ''}
                  onClick={() => setProgressTab('strength')}
                >
                  <Dumbbell size={16} />
                  Strength
                </button>
                <button
                  className={progressTab === 'cardio' ? 'selected' : ''}
                  onClick={() => setProgressTab('cardio')}
                >
                  <Heart size={16} />
                  Cardio
                </button>
                <button
                  className={progressTab === 'body' ? 'selected' : ''}
                  onClick={() => setProgressTab('body')}
                >
                  <LockKeyhole size={16} />
                  Body records
                </button>
              </div>
              {progressTab === 'body' ? (
                <Card>
                  <SectionTitle
                    title="Your private check-ins"
                    action={
                      <button
                        className="button secondary"
                        onClick={() => setForm({ kind: 'body' })}
                      >
                        <Plus size={17} />
                        Add record
                      </button>
                    }
                  />
                  <p className="privacy-note">
                    <LockKeyhole size={16} />
                    {preview
                      ? 'Preview sharing controls only. Real privacy requires the connected backend.'
                      : 'Only you can see a record unless you explicitly share it.'}
                  </p>
                  {recordList(mineLogs.filter((l) => l.kind === 'body'))}
                </Card>
              ) : (
                <>
                  <div className="chart-grid">
                    {data.trends[progressTab].length ? (
                      data.trends[progressTab].map((s, i) => (
                        <Card key={`${s.label}-${i}`}>
                          <SectionTitle
                            eyebrow={
                              progressTab === 'strength'
                                ? 'LOAD AT MATCHING REPS'
                                : 'LOGGED DURATION · NOT A BENCHMARK'
                            }
                            title={s.label}
                            action={
                              <span className="small-tag">
                                {preview ? 'PREVIEW HISTORY' : 'PERSONAL TREND'}
                              </span>
                            }
                          />
                          <div className="trend-value">
                            {s.points.at(-1)?.value}
                            <span>{s.unit}</span>
                          </div>
                          <LineChart
                            series={s}
                            color={progressTab === 'strength' ? 'var(--lime)' : 'var(--lavender)'}
                          />
                        </Card>
                      ))
                    ) : (
                      <Card>
                        <Empty title="Progress takes a little history">
                          Your comparable logged sessions will appear here.
                        </Empty>
                      </Card>
                    )}
                  </div>
                  <Card className="info-card">
                    <Target size={25} />
                    <div>
                      <h3>Progress bonuses need agreed benchmarks.</h3>
                      <p>
                        {data.capabilities.authoritativeScoring
                          ? 'Your server calculates eligible improvements from approved benchmarks.'
                          : 'Benchmark setup, baseline history, and the two 5-point bonuses are part of the backend handoff. Preview totals award no improvement points.'}{' '}
                        No one-rep-max testing is required.
                      </p>
                    </div>
                  </Card>
                </>
              )}
            </>
          )}
          {page === 'competition' && (
            <>
              <PageHeading
                eyebrow="A FRIENDLY PUSH FORWARD"
                title="In good company."
                description="Shared effort. Personal goals. A total that keeps growing."
                action={
                  <button className="button secondary" onClick={() => setRules(true)}>
                    <CircleHelp size={17} />
                    The rules
                  </button>
                }
              />
              <div className="leaderboard-grid">
                {[...data.allTime]
                  .sort((a, b) => b.total - a.total)
                  .map((entry, i) => {
                    const p = data.profiles.find((p) => p.id === entry.ownerId);
                    return (
                      <Card
                        className={`leaderboard-card ${entry.ownerId === me.id ? 'is-me' : ''}`}
                        key={entry.ownerId}
                      >
                        <div className="leaderboard-top">
                          <span className="avatar large">
                            {entry.ownerId === me.id ? 'YOU' : p?.initials}
                          </span>
                          <span className="small-tag">
                            {i === 0 ? 'LEADING THE WAY' : 'BUILDING MOMENTUM'}
                          </span>
                        </div>
                        <h2>
                          {p?.displayName}
                          {entry.ownerId === me.id && <small>YOU</small>}
                        </h2>
                        <div className="leaderboard-total">
                          {points(entry.total)}
                          <span>all-time points</span>
                        </div>
                        <p>Since {displayDate(data.competition.startDate)} · never resets</p>
                      </Card>
                    );
                  })}
              </div>
              <div className="section-title history-heading">
                <h2>A week at a time</h2>
                <label className="inline-label">
                  Week
                  <select value={selectedWeek} onChange={(e) => setSelectedWeek(e.target.value)}>
                    {weekList.map((w) => (
                      <option key={w} value={w}>
                        {displayDate(w)}
                        {w === week ? ' · this week' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="comparison-grid">
                {data.profiles.map((p) => {
                  const w = data.weeks.find((w) => w.ownerId === p.id && w.week === selectedWeek);
                  return (
                    <Card key={p.id}>
                      <SectionTitle
                        title={p.displayName}
                        action={
                          <span className="small-tag">
                            {w?.provisional ? 'PROVISIONAL' : 'WEEKLY VIEW'}
                          </span>
                        }
                      />
                      <div className="comparison-total">
                        {points(w?.points.total || 0)}
                        <small> / 100</small>
                      </div>
                      <Breakdown value={w?.points || zero} />
                    </Card>
                  );
                })}
              </div>
              <p className="helper">
                Changing this view never resets all-time points. A week stays provisional until its
                48-hour entry window closes.
              </p>
              <Card>
                <SectionTitle title="Showing up, together" action={<Users size={19} />} />
                {recordList(
                  data.logs
                    .filter((l) => l.kind !== 'body' && l.completed !== false)
                    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
                    .slice(0, 8),
                  true,
                )}
              </Card>
              <Card>
                <SectionTitle title="Activity & corrections" />
                {data.audit.length ? (
                  <ul className="audit-list">
                    {data.audit
                      .slice()
                      .sort((a, b) => b.at.localeCompare(a.at))
                      .slice(0, 12)
                      .map((a) => (
                        <li key={a.id}>
                          <span className="audit-dot" />
                          <div>
                            {a.message}
                            <small>
                              {displayDate(a.at, { hour: 'numeric', minute: '2-digit' })}
                            </small>
                          </div>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="helper">Your saved actions will appear here.</p>
                )}
              </Card>
            </>
          )}
          {page === 'settings' && (
            <>
              <PageHeading
                eyebrow="MAKE THIS YOURS"
                title="A shared commitment."
                description="Personal preferences. Agreed rules. No silent changes."
              />
              <div className="settings-grid">
                <Card>
                  <SectionTitle title="Your profile" />
                  <ProfileForm profile={me} busy={busy} onSave={command} />
                </Card>
                <Card>
                  <SectionTitle title="Your next weekly targets" action={<Target size={19} />} />
                  <p className="helper">
                    Changes need both approvals and start the following week. Your existing targets
                    remain in effect.
                  </p>
                  <TargetsForm targets={me.targets} busy={busy} onSave={command} />
                </Card>
              </div>
              <Card>
                <SectionTitle
                  title="Competition agreement"
                  action={<span className="small-tag">{data.competition.rulesVersion}</span>}
                />
                <div className="agreement-grid">
                  <div>
                    <span className="tiny-label">START DATE</span>
                    <strong>{displayDate(data.competition.startDate, { year: 'numeric' })}</strong>
                  </div>
                  <div>
                    <span className="tiny-label">COMPETITION TIMEZONE</span>
                    <strong>{data.competition.timezone}</strong>
                  </div>
                  <div>
                    <span className="tiny-label">APPROVALS</span>
                    <strong>{data.competition.agreedBy.length} of 2</strong>
                  </div>
                </div>
                <p className="helper">
                  Initial setup defaults to next Monday. The backend must collect both people’s
                  agreement on the date, targets, meal checklist, and benchmarks before competition
                  starts.
                </p>
                <button
                  className="button secondary"
                  disabled={busy || data.competition.agreedBy.includes(me.id)}
                  onClick={() => void run({ type: 'competition.agree' })}
                >
                  <Check size={17} />
                  {data.competition.agreedBy.includes(me.id)
                    ? 'You agreed to these rules'
                    : 'Agree to these rules'}
                </button>
              </Card>
              <Card>
                <SectionTitle title="Proposed changes" />
                {data.proposals.length ? (
                  data.proposals.map((p) => (
                    <div className="proposal" key={p.id}>
                      <div>
                        <strong>
                          {data.profiles.find((m) => m.id === p.ownerId)?.displayName}’s targets
                        </strong>
                        <p>
                          {p.targets.strength} strength days · {p.targets.cardio} cardio days ·{' '}
                          {p.targets.waterMl} ml daily
                        </p>
                        <small>
                          Effective {displayDate(p.effectiveWeek)} if both approve ·{' '}
                          {p.approvals.length}/2 approvals
                        </small>
                      </div>
                      <button
                        className="button secondary"
                        disabled={busy || p.approvals.includes(me.id)}
                        onClick={() => void run({ type: 'proposal.approve', id: p.id })}
                      >
                        {p.approvals.includes(me.id) ? 'Waiting for partner' : 'Approve'}
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="helper">No proposed changes. Your agreed settings carry forward.</p>
                )}
              </Card>
              <div className="settings-grid">
                <Card>
                  <SectionTitle title="Your data, your choice" />
                  <p className="helper">
                    Export your own logs. Delete individual records from their history. Private
                    photo storage and account deletion need the connected backend.
                  </p>
                  <div className="button-row">
                    <button className="button secondary" onClick={exportData}>
                      <ArrowDownToLine size={17} />
                      Export my logs
                    </button>
                    <button className="button secondary" onClick={exit}>
                      <LogOut size={17} />
                      {preview ? 'Exit preview' : 'Sign out'}
                    </button>
                  </div>
                  {preview && (
                    <button
                      className="text-link danger-text"
                      onClick={() => {
                        if (
                          window.confirm(
                            'Reset only the fictional local preview data in this browser?',
                          )
                        ) {
                          resetPreview();
                          setGateway(new PreviewGateway());
                          setNotice('Local preview reset.');
                        }
                      }}
                    >
                      Reset fictional preview
                    </button>
                  )}
                </Card>
                <Card>
                  <SectionTitle title="At home on your iPhone" />
                  <p className="helper">
                    Once your private hosted app is connected, open it in Safari, tap Share, then
                    Add to Home Screen. This creates a shortcut, not an App Store app.
                  </p>
                  <p className="helper">
                    No camera, location, contacts, notifications, HealthKit, or background tracking
                    permissions are requested.
                  </p>
                </Card>
              </div>
            </>
          )}
          <footer className="page-footer">
            <Leaf size={14} />
            <span>
              Points reflect agreed habits and logged performance, not a medical health score.
            </span>
            <span>GYM PROGRESS DUO</span>
          </footer>
        </main>
      </div>
      <nav className="bottom-nav" aria-label="Mobile navigation">
        {navigation.map((n) => (
          <button
            className={page === n.id ? 'active' : ''}
            key={n.id}
            onClick={() => navigate(n.id)}
            aria-current={page === n.id ? 'page' : undefined}
          >
            <n.icon size={20} />
            <span>{n.short}</span>
          </button>
        ))}
      </nav>
      {form && (
        <LogForm
          {...form}
          profile={me}
          checklist={data.competition.mealChecklist}
          gateway={gateway}
          preview={preview}
          privateMedia={data.capabilities.privateMedia}
          nutritionTracking={data.capabilities.nutritionTracking === true}
          onClose={() => setForm(undefined)}
          onSave={execute}
        />
      )}
      {deleteRecord && (
        <Modal
          title="Delete this record?"
          onClose={() => {
            if (!busy) setDeleteRecord(undefined);
          }}
        >
          <div className="modal-content">
            <p>
              <strong>{deleteRecord.title}</strong> will be removed
              {preview ? ' from this local preview' : ''}. Dependent points will be recalculated.
              Deleted private image bytes must be removed by the connected backend.
            </p>
            <div className="button-row">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setDeleteRecord(undefined)}
              >
                Keep record
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={async () => {
                  try {
                    await command({
                      type: 'log.delete',
                      id: deleteRecord.id,
                      expectedVersion: deleteRecord.version,
                    });
                    setDeleteRecord(undefined);
                  } catch {
                    /* global error retains dialog */
                  }
                }}
              >
                {busy ? 'Deleting…' : 'Delete record'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {rules && (
        <Modal title="A fair kind of competition." onClose={() => setRules(false)}>
          <div className="modal-content rules-content">
            <p>One hundred possible points per full week, based on each person’s agreed targets.</p>
            {categories.map((c) => (
              <div className="rule" key={c.key}>
                <span style={{ color: c.color }}>{c.max}</span>
                <div>
                  <h3>{c.label}</h3>
                  <p>
                    {
                      {
                        strength:
                          '40 × qualifying workout days ÷ your target, capped at 40. Completed workouts count once per day.',
                        meals:
                          '25 × qualifying meal days ÷ 5, capped at 25. One selected photo and your agreed checklist. Self-reported.',
                        cardio:
                          '15 × qualifying cardio days ÷ your target, capped at 15. Your agreed activity and protocol.',
                        hydration:
                          '10 × days meeting your water target ÷ 7. No extra points for exceeding the target.',
                        improvement:
                          'One 5-point strength bonus and one 5-point cardio bonus. Comparable personal benchmarks, baseline week first. Backend implementation required; preview awards zero.',
                      }[c.key]
                    }
                  </p>
                </div>
              </div>
            ))}
            <p>
              Weeks begin Monday at midnight in America/New_York. Submit within 48 elapsed hours of
              the activity. Late history earns no points; late corrections can only reduce existing
              awards.
            </p>
            <p>
              All-time points are the sum of weekly scores since the agreed start date. Changes need
              both approvals and only take effect in a future week. Body changes and appearance earn
              no points.
            </p>
            <p className="form-notice">
              This remains an honor-based competition. Photos cannot prove what was eaten or
              exercised. Points are not a diagnosis or an overall-health ranking.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand" aria-label="Gym Progress Duo">
      <span className="brand-mark">
        <TwinPlatesMark />
      </span>
      <span>
        duo<span className="brand-dot">.</span>
        <small>GYM PROGRESS</small>
      </span>
    </div>
  );
}

function TwinPlatesMark() {
  return (
    <svg className="twin-plates-mark" viewBox="0 0 48 48" aria-hidden="true">
      <path d="M15 16v16M10 19v10M33 16v16M38 19v10M15 24h18" />
      <circle cx="24" cy="24" r="3" />
    </svg>
  );
}
function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function WeekRhythm({ logs, week, today }: { logs: LogRecord[]; week: string; today: string }) {
  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return (
    <div className="rhythm">
      {labels.map((label, i) => {
        const d = new Date(`${week}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        const day = d.toISOString().slice(0, 10);
        const count = logs.filter(
          (l) => l.kind !== 'body' && l.completed !== false && dateKey(l.occurredAt) === day,
        ).length;
        return (
          <div className={`rhythm-day ${day === today ? 'current' : ''}`} key={day}>
            <span>{label}</span>
            <div className={count ? 'has-log' : ''}>
              {count ? <Check size={19} /> : <span>—</span>}
            </div>
            <small>{d.getUTCDate()}</small>
          </div>
        );
      })}
    </div>
  );
}
function ProfileForm({
  profile,
  busy,
  onSave,
}: {
  profile: Profile;
  busy: boolean;
  onSave: (command: Command) => Promise<void>;
}) {
  const [name, setName] = useState(profile.displayName);
  const [mass, setMass] = useState(profile.massUnit);
  const [water, setWater] = useState(profile.waterUnit);
  const [distance, setDistance] = useState(profile.distanceUnit);
  return (
    <form
      className="settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSave({
            type: 'profile.update',
            displayName: name.trim(),
            massUnit: mass,
            waterUnit: water,
            distanceUnit: distance,
          });
        } catch {
          /* global feedback */
        }
      }}
    >
      <label>
        Display name
        <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="form-grid three">
        <label>
          Weight
          <select value={mass} onChange={(e) => setMass(e.target.value as typeof mass)}>
            <option>lb</option>
            <option>kg</option>
          </select>
        </label>
        <label>
          Water
          <select value={water} onChange={(e) => setWater(e.target.value as typeof water)}>
            <option>ml</option>
            <option>L</option>
            <option>fl oz</option>
          </select>
        </label>
        <label>
          Distance
          <select value={distance} onChange={(e) => setDistance(e.target.value as typeof distance)}>
            <option>mi</option>
            <option>km</option>
          </select>
        </label>
      </div>
      <button className="button secondary" disabled={busy} type="submit">
        Save preferences
      </button>
    </form>
  );
}
function TargetsForm({
  targets,
  busy,
  onSave,
}: {
  targets: Targets;
  busy: boolean;
  onSave: (command: Command) => Promise<void>;
}) {
  const [draft, setDraft] = useState({ ...targets });
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await onSave({ type: 'targets.propose', targets: draft });
    } catch {
      /* global feedback */
    }
  }
  return (
    <form className="settings-form" onSubmit={submit}>
      <div className="form-grid">
        <label>
          Strength days / week
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="7"
            step="1"
            required
            value={draft.strength}
            onChange={(e) => setDraft({ ...draft, strength: Number(e.target.value) })}
          />
        </label>
        <label>
          Cardio days / week
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="7"
            step="1"
            required
            value={draft.cardio}
            onChange={(e) => setDraft({ ...draft, cardio: Number(e.target.value) })}
          />
        </label>
        <label>
          Daily water target (ml)
          <input
            type="number"
            inputMode="decimal"
            min="1"
            step="1"
            required
            value={draft.waterMl}
            onChange={(e) => setDraft({ ...draft, waterMl: Number(e.target.value) })}
          />
        </label>
        <label>
          Cardio duration (minutes)
          <input
            type="number"
            inputMode="decimal"
            min="1"
            max="1440"
            required
            value={draft.cardioMinimumMinutes}
            onChange={(e) => setDraft({ ...draft, cardioMinimumMinutes: Number(e.target.value) })}
          />
        </label>
      </div>
      <label>
        Qualifying cardio activity
        <select
          value={draft.cardioActivity}
          onChange={(e) => setDraft({ ...draft, cardioActivity: e.target.value })}
        >
          {['Walking', 'Running', 'Cycling', 'Swimming', 'Rowing', 'Elliptical', 'Other'].map(
            (a) => (
              <option key={a}>{a}</option>
            ),
          )}
        </select>
      </label>
      <button className="button secondary" disabled={busy} type="submit">
        Propose for next week
        <ArrowRight size={16} />
      </button>
    </form>
  );
}
