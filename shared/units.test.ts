import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceToKm, massToKg, waterToMl } from './units.ts';

test('uses exact standard unit conversion factors without display rounding', () => {
  assert.equal(massToKg(100, 'lb'), 45.359237);
  assert.equal(massToKg(20, 'kg'), 20);
  assert.equal(distanceToKm(1, 'mi'), 1.609344);
  assert.equal(distanceToKm(5, 'km'), 5);
  assert.equal(waterToMl(2.5, 'L'), 2_500);
  assert.equal(waterToMl(8, 'fl oz'), 236.5882365);
  assert.equal(waterToMl(0, 'ml'), 0);
});

test('invalid numeric input cannot propagate into scores', () => {
  for (const value of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => waterToMl(value, 'ml'), RangeError);
    assert.throws(() => massToKg(value, 'kg'), RangeError);
    assert.throws(() => distanceToKm(value, 'km'), RangeError);
  }
  assert.throws(() => waterToMl(1, 'gallon' as never), /Unsupported/);
});
