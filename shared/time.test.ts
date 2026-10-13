import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarDays,
  dateKey,
  HOUR_MS,
  nextMonday,
  startOfDate,
  timestampMs,
  weekBounds,
  weekKey,
} from './time.ts';

test('local calendar days and Monday weeks are based on New York, not UTC', () => {
  assert.equal(dateKey('2026-10-12T03:59:59.999Z'), '2026-10-11');
  assert.equal(weekKey('2026-10-12T03:59:59.999Z'), '2026-10-05');
  assert.equal(weekKey('2026-10-12T04:00:00.000Z'), '2026-10-12');
  assert.equal(weekKey('2026-10-12T04:00:00.000Z', 'UTC'), '2026-10-12');
});

test('next Monday is strictly upcoming, including on a Monday', () => {
  assert.equal(nextMonday('2026-10-08T16:00:00.000Z'), '2026-10-12');
  assert.equal(nextMonday('2026-10-12T16:00:00.000Z'), '2026-10-19');
  assert.equal(nextMonday('2026-10-11'), '2026-10-12');
  assert.equal(nextMonday(new Date('2026-12-31T18:00:00Z')), '2027-01-04');
});

test('spring DST week has 167 elapsed hours while retaining seven calendar days', () => {
  const bounds = weekBounds('2026-03-02');
  assert.deepEqual(bounds, { start: '2026-03-02T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' });
  assert.equal((timestampMs(bounds.end) - timestampMs(bounds.start)) / HOUR_MS, 167);
});

test('autumn DST week has 169 elapsed hours; repeated hour stays on one calendar day', () => {
  const bounds = weekBounds('2026-10-26');
  assert.deepEqual(bounds, { start: '2026-10-26T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z' });
  assert.equal((timestampMs(bounds.end) - timestampMs(bounds.start)) / HOUR_MS, 169);
  assert.equal(dateKey('2026-11-01T01:30:00-04:00'), '2026-11-01');
  assert.equal(dateKey('2026-11-01T01:30:00-05:00'), '2026-11-01');
});

test('calendar addition crosses years and leap days without local-device assumptions', () => {
  assert.equal(addCalendarDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
  assert.equal(startOfDate('2026-01-01'), '2026-01-01T05:00:00.000Z');
});

test('ambiguous timestamps, invalid dates, and non-Monday weeks are rejected', () => {
  for (const input of [
    '2026-10-08T12:00',
    '2026-02-30T12:00:00Z',
    '2026-10-08T24:01:00Z',
    'nope',
  ]) {
    assert.throws(() => dateKey(input), RangeError);
  }
  assert.throws(() => weekBounds('2026-10-08'), /Monday/);
  assert.throws(() => startOfDate('2026-02-30'), /Invalid calendar/);
  assert.throws(() => dateKey('2026-10-08T12:00:00Z', 'Mars/Olympus'), RangeError);
});
