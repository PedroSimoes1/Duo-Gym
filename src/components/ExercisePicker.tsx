import { useId, useRef, useState } from 'react';
import { Dumbbell, Pencil, Plus, Search, X } from 'lucide-react';
import { commonExercises } from '../data/exercises';
import type { CommonExercise } from '../data/exercises';

const groups = ['All', 'Upper body', 'Lower body', 'Core'] as const;
type EntryMode = 'common' | 'custom';

export default function ExercisePicker({
  onSelect,
  defaultMode = 'common',
  disabled = false,
}: {
  onSelect: (exercise: CommonExercise) => void;
  defaultMode?: EntryMode;
  disabled?: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState<EntryMode>(defaultMode);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<(typeof groups)[number]>('All');
  const commonTab = useRef<HTMLButtonElement>(null);
  const customTab = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const results = commonExercises.filter((item) => {
    const text =
      `${item.exercise} ${item.equipment} ${item.group} ${item.aliases || ''}`.toLowerCase();
    return (group === 'All' || item.group === group) && words.every((word) => text.includes(word));
  });
  function switchWithKeyboard(event: React.KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 'common'
        : event.key === 'End'
          ? 'custom'
          : mode === 'common'
            ? 'custom'
            : 'common';
    setMode(next);
    (next === 'common' ? commonTab : customTab).current?.focus();
  }
  return (
    <section className="exercise-picker" aria-label="Quick exercise selection">
      <div
        className="exercise-entry-tabs"
        role="tablist"
        aria-label="Exercise entry method"
        onKeyDown={switchWithKeyboard}
      >
        <button
          ref={commonTab}
          type="button"
          role="tab"
          id={`${id}-common-tab`}
          aria-selected={mode === 'common'}
          aria-controls={`${id}-common-panel`}
          tabIndex={mode === 'common' ? 0 : -1}
          onClick={() => setMode('common')}
        >
          <Dumbbell size={16} aria-hidden="true" />
          Common exercises
        </button>
        <button
          ref={customTab}
          type="button"
          role="tab"
          id={`${id}-custom-tab`}
          aria-selected={mode === 'custom'}
          aria-controls={`${id}-custom-panel`}
          tabIndex={mode === 'custom' ? 0 : -1}
          onClick={() => setMode('custom')}
        >
          <Pencil size={15} aria-hidden="true" />
          Custom entry
        </button>
      </div>
      {mode === 'common' ? (
        <div role="tabpanel" id={`${id}-common-panel`} aria-labelledby={`${id}-common-tab`}>
          <p className="exercise-picker-hint">
            Tap an exercise to add its name and equipment. Reps and weight stay yours to enter.
          </p>
          <div className="exercise-search">
            <Search size={17} aria-hidden="true" />
            <input
              ref={searchInput}
              type="search"
              aria-label="Search common exercises"
              placeholder="Search exercises or equipment"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                className="icon-button"
                aria-label="Clear exercise search"
                onClick={() => {
                  setQuery('');
                  searchInput.current?.focus();
                }}
              >
                <X size={16} />
              </button>
            )}
          </div>
          <div className="exercise-filters" role="group" aria-label="Exercise category">
            {groups.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={group === item}
                onClick={() => setGroup(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="exercise-result-heading">
            <span role="status">
              {results.length} {results.length === 1 ? 'exercise' : 'exercises'}
            </span>
            <span>CHOOSE YOUR VARIATION</span>
          </div>
          {results.length ? (
            <div
              className="exercise-results"
              role="region"
              aria-label="Common exercise results"
              tabIndex={0}
            >
              {results.map((item) => (
                <button
                  type="button"
                  className="exercise-choice"
                  disabled={disabled}
                  key={item.id}
                  onClick={() => onSelect(item)}
                >
                  <span>
                    <strong>{item.exercise}</strong>
                    <small>{item.equipment}</small>
                  </span>
                  <Plus size={17} aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : (
            <div className="exercise-no-results">
              <p>No matching exercises.</p>
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setMode('custom');
                  customTab.current?.focus();
                }}
              >
                Enter your own exercise
                <Pencil size={14} />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div
          role="tabpanel"
          id={`${id}-custom-panel`}
          aria-labelledby={`${id}-custom-tab`}
          className="exercise-custom-hint"
        >
          Type any exercise and its equipment in the sets below. You can switch back to common
          exercises at any time.
        </div>
      )}
    </section>
  );
}
