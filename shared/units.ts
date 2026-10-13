import type { DistanceUnit, MassUnit, WaterUnit } from './contracts.ts';

function quantity(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('Quantity must be a finite, nonnegative number.');
  return value;
}

export function waterToMl(value: number, unit: WaterUnit): number {
  const factors: Record<WaterUnit, number> = { ml: 1, L: 1_000, 'fl oz': 29.5735295625 };
  if (!(unit in factors)) throw new RangeError('Unsupported water unit.');
  return quantity(value) * factors[unit];
}

export function massToKg(value: number, unit: MassUnit): number {
  const factors: Record<MassUnit, number> = { kg: 1, lb: 0.45359237 };
  if (!(unit in factors)) throw new RangeError('Unsupported mass unit.');
  return quantity(value) * factors[unit];
}

export function distanceToKm(value: number, unit: DistanceUnit): number {
  const factors: Record<DistanceUnit, number> = { km: 1, mi: 1.609344 };
  if (!(unit in factors)) throw new RangeError('Unsupported distance unit.');
  return quantity(value) * factors[unit];
}
