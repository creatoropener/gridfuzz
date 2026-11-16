import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidForSpec, numberArbitrary, roundToPrecision } from '../src/engine/generators/numberArbitrary';
import { InputSpecSchema } from '../src/schemas/rule';
import { input } from './helpers';

const spec = (min: number, max: number, precision: number) => InputSpecSchema.parse(input('B1', min, max, precision));

describe('input generators', () => {
  it('only ever produce values inside the range, on the precision grid', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: 1, max: 400 }),
        fc.integer({ min: 0, max: 3 }),
        fc.option(fc.integer({ min: -600, max: 1000 }), { nil: null }),
        (min, width, precision, baseline) => {
          const s = spec(min, min + width, precision);
          const values = fc.sample(numberArbitrary(s, baseline), { numRuns: 60, seed: 7 });
          return values.every((v) => isValidForSpec(s, v) && v >= s.min - 1e-9 && v <= s.max + 1e-9);
        },
      ),
      { numRuns: 80, seed: 11 },
    );
  });

  it('is reproducible for a given seed and differs across seeds', () => {
    const s = spec(0, 10_000, 2);
    const a = fc.sample(numberArbitrary(s, 180), { numRuns: 50, seed: 1 });
    const b = fc.sample(numberArbitrary(s, 180), { numRuns: 50, seed: 1 });
    const c = fc.sample(numberArbitrary(s, 180), { numRuns: 50, seed: 2 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('hits the range edges and the current value, not just uniform values', () => {
    const s = spec(0, 100_000, 0);
    const values = fc.sample(numberArbitrary(s, 4242), { numRuns: 2000, seed: 3 });
    expect(values).toContain(0);
    expect(values).toContain(100_000);
    expect(values).toContain(4242);
  });

  it('shrinks to the failure boundary nearest the current value, valid at every step', () => {
    const s = spec(0, 1000, 0);
    const visited: number[] = [];
    const details = fc.check(
      fc.property(numberArbitrary(s, 100), (v) => {
        visited.push(v);
        return v < 250; // fails for v >= 250; the current value (100) passes
      }),
      { numRuns: 200, seed: 5 },
    );
    expect(details.failed).toBe(true);
    expect(details.counterexample?.[0]).toBe(250); // the smallest change from 100 that breaks it
    expect(visited.every((v) => isValidForSpec(s, v))).toBe(true);
  });

  it('shrinks towards the current value from either side', () => {
    const s = spec(0, 1000, 0);
    const above = fc.check(fc.property(numberArbitrary(s, 777), (v) => v > 700), { numRuns: 300, seed: 9 });
    expect(above.counterexample?.[0]).toBe(700); // fails for v <= 700; nearest to 777 from below
    // If the current value itself already fails, that is the smallest counterexample.
    const already = fc.check(fc.property(numberArbitrary(s, 900), (v) => v < 250), { numRuns: 200, seed: 5 });
    expect(already.counterexample?.[0]).toBe(900);
  });

  it('clamps an out-of-range current value into the range', () => {
    const s = spec(10, 20, 0);
    const details = fc.check(fc.property(numberArbitrary(s, 5_000), (v) => v < 0), { numRuns: 50, seed: 1 });
    expect(details.counterexample?.[0]).toBe(20); // the clamped target is the upper bound
    const none = fc.check(fc.property(numberArbitrary(s, null), (v) => v > 100), { numRuns: 50, seed: 1 });
    expect(none.counterexample?.[0]).toBe(10); // no current value: nearest allowed value to zero
  });

  it('respects fractional precision when shrinking', () => {
    const s = spec(0, 1, 2);
    const details = fc.check(
      fc.property(numberArbitrary(s, 0.09), (v) => v < 0.37),
      { numRuns: 300, seed: 21 },
    );
    expect(details.failed).toBe(true);
    expect(details.counterexample?.[0]).toBeCloseTo(0.37, 10);
    expect(isValidForSpec(s, details.counterexample?.[0] ?? -1)).toBe(true);
  });

  it('rounds without floating-point noise', () => {
    expect(roundToPrecision(0.1 + 0.2, 2)).toBe(0.3);
    expect(roundToPrecision(1.005, 2)).toBe(1);
    expect(roundToPrecision(-2.675, 1)).toBe(-2.7);
    expect(isValidForSpec(spec(0, 10, 1), 0.15)).toBe(false);
    expect(isValidForSpec(spec(0, 10, 1), 10.1)).toBe(false);
  });
});
