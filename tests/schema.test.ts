import { describe, expect, it } from 'vitest';
import {
  RuleSchema,
  TestConfigSchema,
  formatIssues,
  scaledBounds,
  InputSpecSchema,
} from '../src/schemas/rule';
import { draftToRule, emptyDraft, parseNumberField } from '../src/engine/rule-compiler/draft';
import { input } from './helpers';

const base = {
  id: 'r1',
  name: 'Rule',
  description: 'desc',
  sheet: 'S',
  tolerance: 0,
  source: 'manual',
};
const monotonic = {
  ...base,
  type: 'monotonic_increasing',
  input: input('B1', 0, 100),
  context: [input('B2', 0, 10)],
  output: { sheet: 'S', address: 'B3' },
};

function issues(candidate: unknown): string[] {
  const parsed = RuleSchema.safeParse(candidate);
  return parsed.success ? [] : formatIssues(parsed.error);
}

describe('rule schema validation', () => {
  it('accepts a valid rule of every type', () => {
    expect(issues(monotonic)).toEqual([]);
    expect(issues({ ...base, type: 'bounds', inputs: [input('B1', 0, 10)], output: { sheet: 'S', address: 'B2' }, min: 0, max: 5 })).toEqual([]);
    expect(issues({ ...base, type: 'non_negative', inputs: [input('B1', 0, 10)], outputs: [{ sheet: 'S', address: 'B2' }] })).toEqual([]);
    expect(issues({ ...base, relativeTolerance: 0, type: 'invariant', inputs: [input('B1', 0, 10)], left: 'B2', relation: '==', right: 'B1 * 2' })).toEqual([]);
    expect(
      issues({ ...base, type: 'conditional', inputs: [input('B1', 0, 10)], when: { left: 'B1', op: '>', right: '5' }, then: { left: 'B2', op: '<=', right: '100' } }),
    ).toEqual([]);
  });

  it('rejects invalid ranges and precision', () => {
    expect(issues({ ...monotonic, input: input('B1', 10, 10) }).join()).toMatch(/Minimum must be less than maximum/);
    expect(issues({ ...monotonic, input: input('B1', 10, 5) }).join()).toMatch(/Minimum must be less than maximum/);
    expect(issues({ ...monotonic, input: input('B1', 0, 100, 7) }).join()).toMatch(/limited to 6 decimals/);
    expect(issues({ ...monotonic, input: input('B1', 0, 100, 1.5) }).join()).toMatch(/whole number/);
    expect(issues({ ...monotonic, input: input('B1', 0, 1e12) }).join()).toMatch(/at most 1,000,000,000/);
    // A range with fewer than two distinct values at the chosen precision cannot be explored.
    expect(issues({ ...monotonic, input: input('B1', 0.1, 0.4, 0) }).join()).toMatch(/too narrow/);
  });

  it('rejects bad cell addresses and duplicate mappings', () => {
    for (const address of ['', 'B', '5', 'B0', 'b1', 'AAAA1', 'B1:B2', '$B$1', 'B 1']) {
      expect(issues({ ...monotonic, output: { sheet: 'S', address } }).length, address).toBeGreaterThan(0);
    }
    expect(issues({ ...monotonic, output: { sheet: 'S', address: 'B1' } }).join()).toMatch(/mapped more than once/);
    expect(issues({ ...monotonic, context: [input('B1', 0, 10)] }).join()).toMatch(/mapped more than once/);
  });

  it('rejects bounds without limits and inverted limits', () => {
    const bounds = { ...base, type: 'bounds', inputs: [input('B1', 0, 10)], output: { sheet: 'S', address: 'B2' } };
    expect(issues({ ...bounds, min: null, max: null }).join()).toMatch(/Set a minimum, a maximum, or both/);
    expect(issues({ ...bounds, min: 10, max: 5 }).join()).toMatch(/Minimum cannot be greater than maximum/);
  });

  it('rejects invalid expressions with the parser message', () => {
    const inv = { ...base, relativeTolerance: 0, type: 'invariant', inputs: [input('B1', 0, 10)], relation: '==' };
    expect(issues({ ...inv, left: 'B2', right: 'FOO(B1)' }).join()).toMatch(/FOO\(\) is not supported/);
    expect(issues({ ...inv, left: '', right: 'B1' }).join()).toMatch(/Enter an expression/);
    expect(issues({ ...inv, left: 'B2 +', right: 'B1' }).length).toBeGreaterThan(0);
  });

  it('rejects structural problems', () => {
    expect(issues({ ...monotonic, type: 'made_up' }).length).toBeGreaterThan(0);
    expect(issues({ ...monotonic, id: 'has space' }).join()).toMatch(/letters, digits/);
    expect(issues({ ...monotonic, name: '   ' }).join()).toMatch(/Give the rule a name/);
    expect(issues({ ...monotonic, tolerance: -1 }).join()).toMatch(/cannot be negative/);
    expect(issues({ ...monotonic, context: Array.from({ length: 13 }, (_, i) => input(`C${i + 1}`, 0, 5)) }).join()).toMatch(/At most 12/);
    expect(issues({ ...base, type: 'non_negative', inputs: [], outputs: [] }).join()).toMatch(/at least one/);
    expect(issues(null).length).toBeGreaterThan(0);
  });

  it('validates the test configuration', () => {
    expect(TestConfigSchema.safeParse({ numRuns: 1000, seed: 42 }).success).toBe(true);
    expect(TestConfigSchema.safeParse({ numRuns: 5, seed: 42 }).success).toBe(false);
    expect(TestConfigSchema.safeParse({ numRuns: 100_000, seed: 42 }).success).toBe(false);
    expect(TestConfigSchema.safeParse({ numRuns: 100.5, seed: 42 }).success).toBe(false);
    expect(TestConfigSchema.safeParse({ numRuns: 100, seed: -1 }).success).toBe(false);
  });

  it('computes the integer grid a range is sampled on', () => {
    expect(scaledBounds(0, 100, 0)).toEqual({ lo: 0, hi: 100, scale: 1 });
    expect(scaledBounds(0, 1, 2)).toEqual({ lo: 0, hi: 100, scale: 100 });
    expect(scaledBounds(0.005, 0.995, 2)).toEqual({ lo: 1, hi: 99, scale: 100 });
    expect(InputSpecSchema.safeParse(input('B1', 0, 1, 2)).success).toBe(true);
  });
});

describe('draft → rule conversion', () => {
  it('parses typed numbers', () => {
    expect(parseNumberField('1,250.5')).toEqual({ ok: true, value: 1250.5 });
    expect(parseNumberField(' 30% ')).toEqual({ ok: true, value: 0.3 });
    expect(parseNumberField('-3')).toEqual({ ok: true, value: -3 });
    expect(parseNumberField('1e3')).toEqual({ ok: true, value: 1000 });
    for (const bad of ['', '-', '1.2.3', 'abc', '12abc', '%']) expect(parseNumberField(bad).ok, bad).toBe(false);
  });

  it('reports typing mistakes in plain words and never throws', () => {
    const draft = emptyDraft('monotonic_increasing', 'S');
    const result = draftToRule({ ...draft, inputs: [{ ...draft.inputs[0]!, address: 'B1', min: 'abc', max: '10' }], outputs: [{ sheet: 'S', address: 'B2' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join()).toMatch(/B1 minimum: enter a number \(got “abc”\)/);
  });
});
