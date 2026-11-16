import fc from 'fast-check';
import { scaledBounds, type InputSpec } from '../../schemas/rule';

/** Rounds to `precision` decimals without leaving floating-point noise (`0.1 + 0.2` → `0.3`). */
export function roundToPrecision(value: number, precision: number): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale + 0; // `+ 0` normalises -0
}

export interface GridTarget {
  /** Smallest and largest allowed value, as integers on the precision grid. */
  lo: number;
  hi: number;
  /** `10 ** precision`: grid integer ÷ scale = cell value. */
  scale: number;
  /** The cell's current value on the grid, clamped into [lo, hi]. Shrinking moves towards it. */
  target: number;
}

export function gridTarget(spec: InputSpec, baseline: number | null): GridTarget {
  const { lo, hi, scale } = scaledBounds(spec.min, spec.max, spec.precision);
  if (!(lo <= hi)) throw new Error(`The range ${spec.min}..${spec.max} has no values at ${spec.precision} decimals`);
  const wanted = baseline === null ? 0 : Math.round(baseline * scale);
  return { lo, hi, scale, target: Math.min(hi, Math.max(lo, wanted)) };
}

/**
 * Generates values for one input cell.
 *
 * Values are integers on the precision grid, expressed as an offset from the cell's current
 * value ("target"), then divided back down. Three properties follow from that:
 *
 *  - Constraints hold by construction: every generated and every shrunk value lies inside
 *    [min, max] and on the precision grid, because shrinking happens on the integer offset.
 *  - Shrinking moves towards the workbook's current value, so a counterexample is the smallest
 *    *change to the user's real data* that breaks the rule, not an arbitrary small number.
 *  - fast-check's built-in bias applies to the offset: it favours the range edges and values
 *    close to the current value, which is where business logic most often changes behaviour.
 *
 * (An earlier design injected the current value and the edges through constant branches of
 * `fc.oneof`. Those branches cannot shrink, so counterexamples could get stuck on them.)
 */
export function numberArbitrary(spec: InputSpec, baseline: number | null): fc.Arbitrary<number> {
  const { lo, hi, scale, target } = gridTarget(spec, baseline);
  return fc.integer({ min: lo - target, max: hi - target }).map(
    (offset) => (target + offset) / scale + 0,
    (value: unknown) => {
      if (typeof value !== 'number') throw new Error('not a number');
      const k = Math.round(value * scale);
      if (Math.abs(k / scale - value) > 1e-9) throw new Error('value is not on the precision grid');
      return k - target;
    },
  );
}

/** True when `value` is a legal generated value for `spec`. Used by tests and by replay validation. */
export function isValidForSpec(spec: InputSpec, value: number): boolean {
  const { lo, hi, scale } = scaledBounds(spec.min, spec.max, spec.precision);
  const k = Math.round(value * scale);
  return Math.abs(k / scale - value) < 1e-9 && k >= lo && k <= hi;
}
