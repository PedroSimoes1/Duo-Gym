/** Calendar boundaries use the competition timezone; elapsed windows use UTC milliseconds. */
export const DEFAULT_TIMEZONE = 'America/New_York';
export const HOUR_MS = 60 * 60 * 1_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, value);
  }
  return value;
}

/** Require an offset on timestamps so device timezone never changes the meaning. */
export function timestampMs(value: string | Date): number {
  if (typeof value === 'string') {
    const match =
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(
        value,
      );
    if (!match) throw new RangeError('Timestamp must include Z or an explicit UTC offset.');
    calendarDate(match[1]);
    if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) {
      throw new RangeError('Invalid timestamp clock time.');
    }
    const offset = match[6];
    if (
      offset.toUpperCase() !== 'Z' &&
      (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)
    ) {
      throw new RangeError('Invalid UTC offset.');
    }
  }
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) throw new RangeError('Invalid timestamp.');
  return time;
}

function parts(value: string | Date, timezone: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(timestampMs(value))) {
    if (part.type !== 'literal') result[part.type] = Number(part.value);
  }
  return result;
}

function calendarDate(key: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new RangeError('Expected YYYY-MM-DD.');
  const value = new Date(`${key}T00:00:00.000Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== key) {
    throw new RangeError('Invalid calendar date.');
  }
  return value;
}

export function addCalendarDays(key: string, count: number): string {
  if (!Number.isInteger(count)) throw new RangeError('Calendar-day count must be an integer.');
  const value = calendarDate(key);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

export function dateKey(iso: string | Date, timezone = DEFAULT_TIMEZONE): string {
  const value = parts(iso, timezone);
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

export function weekKey(iso: string | Date, timezone = DEFAULT_TIMEZONE): string {
  const key = dateKey(iso, timezone);
  const weekday = calendarDate(key).getUTCDay();
  return addCalendarDays(key, -((weekday + 6) % 7));
}

/** Strictly the next Monday, including when today already is Monday. */
export function nextMonday(value: string | Date = new Date(), timezone = DEFAULT_TIMEZONE): string {
  const key =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value
      : dateKey(value, timezone);
  const weekday = calendarDate(key).getUTCDay();
  return addCalendarDays(key, (8 - weekday) % 7 || 7);
}

/** Resolve a local date's midnight to UTC, without assuming every day is 24 hours. */
export function startOfDate(key: string, timezone = DEFAULT_TIMEZONE): string {
  const desired = calendarDate(key).getTime();
  let candidate = desired;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const local = parts(new Date(candidate), timezone);
    const observed = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const difference = desired - observed;
    if (difference === 0) return new Date(candidate).toISOString();
    candidate += difference;
  }
  throw new RangeError('This timezone has no unambiguous midnight for the requested date.');
}

export function weekBounds(
  week: string,
  timezone = DEFAULT_TIMEZONE,
): { start: string; end: string } {
  if (calendarDate(week).getUTCDay() !== 1) throw new RangeError('Week must begin on Monday.');
  return {
    start: startOfDate(week, timezone),
    end: startOfDate(addCalendarDays(week, 7), timezone),
  };
}
