import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, X, Sprout } from 'lucide-react';
import type { LogRecord, ScoreBreakdown, TrendSeries } from '../../shared/contracts';

export const categories: {
  key: Exclude<keyof ScoreBreakdown, 'total'>;
  label: string;
  max: number;
  color: string;
}[] = [
  { key: 'strength', label: 'Strength', max: 40, color: 'var(--lime)' },
  { key: 'meals', label: 'Meals', max: 25, color: 'var(--peach)' },
  { key: 'cardio', label: 'Cardio', max: 15, color: 'var(--lavender)' },
  { key: 'hydration', label: 'Hydration', max: 10, color: 'var(--blue)' },
  { key: 'improvement', label: 'Improvement', max: 10, color: 'var(--yellow)' },
];
export function points(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function displayDate(iso: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso));
}
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}
export function SectionTitle({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Sprout size={26} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      d.close();
      document.body.style.overflow = overflow;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <span className="eyebrow">MAKE IT COUNT</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog">
          <X size={22} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Breakdown({ value }: { value: ScoreBreakdown }) {
  return (
    <div className="breakdown">
      {categories.map((c) => (
        <div className="breakdown-row" key={c.key}>
          <div className="breakdown-label">
            <span>
              <i style={{ background: c.color }} />
              {c.label}
            </span>
            <span>
              <strong>{points(value[c.key])}</strong> / {c.max}
            </span>
          </div>
          <div className="track">
            <div
              style={{
                width: `${Math.min(100, (value[c.key] / c.max) * 100)}%`,
                background: c.color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
export function ScoreRing({ value }: { value: number }) {
  const r = 72,
    c = 2 * Math.PI * r;
  return (
    <div className="score-ring">
      <svg viewBox="0 0 180 180" aria-hidden="true">
        <circle cx="90" cy="90" r={r} fill="none" stroke="var(--line)" strokeWidth="9" />
        <circle
          cx="90"
          cy="90"
          r={r}
          fill="none"
          stroke="var(--lime)"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(value / 100, 1))}
          transform="rotate(-90 90 90)"
        />
      </svg>
      <div>
        <strong>{points(value)}</strong>
        <span>of 100 points</span>
      </div>
    </div>
  );
}
export function LineChart({
  series,
  color = 'var(--lime)',
}: {
  series: TrendSeries;
  color?: string;
}) {
  const id = useId();
  const values = series.points.map((p) => p.value);
  if (values.length < 2)
    return (
      <Empty title="A little more history">Two comparable entries will start this chart.</Empty>
    );
  const min = Math.min(...values),
    max = Math.max(...values),
    span = max - min || Math.max(1, max * 0.1);
  const coords = values.map((v, i) => [
    40 + (i / (values.length - 1)) * 510,
    142 - ((v - min) / span) * 104,
  ]);
  const path = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ');
  return (
    <div className="chart-wrap">
      <svg className="line-chart" viewBox="0 0 570 188" role="img" aria-labelledby={id}>
        <title id={id}>
          {series.label}:{' '}
          {series.points.map((p) => `${displayDate(p.date)} ${p.value} ${series.unit}`).join(', ')}
        </title>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity=".17" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[38, 90, 142].map((y) => (
          <line key={y} x1="40" x2="550" y1={y} y2={y} stroke="var(--line)" strokeDasharray="3 6" />
        ))}
        <path d={`${path} L550,155 L40,155 Z`} fill={`url(#${id}-fill)`} />
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {coords.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="4" fill="var(--panel)" stroke={color} strokeWidth="2" />
        ))}
        <text x="40" y="182">
          {displayDate(series.points[0].date)}
        </text>
        <text x="550" y="182" textAnchor="end">
          {displayDate(series.points.at(-1)!.date)}
        </text>
        <text x="40" y="17">
          {series.unit}
        </text>
      </svg>
    </div>
  );
}
export function StatusPill({ record }: { record: LogRecord }) {
  return (
    <span className={`status-pill ${record.eligibility === 'eligible' ? 'positive' : ''}`}>
      {record.eligibility === 'eligible'
        ? 'On-time entry'
        : record.eligibility === 'draft'
          ? 'Draft · no points'
          : record.eligibility === 'historical'
            ? 'Historical · no points'
            : 'Not scored'}
    </span>
  );
}
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={16} />
    </button>
  );
}
