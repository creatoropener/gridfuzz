import { describe, expect, it } from 'vitest';
import { replayScenario, runRule } from '../src/engine/runRule';
import { sheetValuesForScenario } from '../src/engine/scenarioView';
import { buildFreightRules, buildFreightWorkbook, SAMPLE_FLAGSHIP_RULE_ID } from '../src/engine/samples/freightQuote';
import { makeWorkbook, input, rule } from './helpers';

const config = { numRuns: 500, seed: 1031 };
const addr = (address: string) => ({ sheet: 'S', address });

describe('property evaluation and shrinking to the exact minimum', () => {
  it('bounds: shrinks the input to the smallest value that breaks the limit', () => {
    const wb = makeWorkbook([['B1', 10], ['B2', '=B1*2']]);
    const r = rule({
      type: 'bounds',
      inputs: [input('B1', 0, 1000)],
      output: addr('B2'),
      min: null,
      max: 100,
    });
    const result = runRule(wb, r, config);
    expect(result.errors).toEqual([]);
    expect(result.status).toBe('failed');
    // 2 × 50 = 100 is allowed, 2 × 51 = 102 is the smallest violation.
    expect(result.counterexample?.scenario).toEqual({ kind: 'point', values: [51] });
    expect(result.counterexample?.difference).toBe(2);
    expect(result.shrink?.reproducible).toBe(true);
  });

  it('bounds: passes when the limit really holds, with honest counts', () => {
    const wb = makeWorkbook([['B1', 10], ['B2', '=B1*2']]);
    const r = rule({ type: 'bounds', inputs: [input('B1', 0, 50)], output: addr('B2'), min: 0, max: 100 });
    const result = runRule(wb, r, config);
    expect(result.status).toBe('passed');
    expect(result.executed).toBe(500);
    expect(result.passed).toBe(500);
    expect(result.failed + result.inconclusive).toBe(0);
    expect(result.counterexample).toBeNull();
    expect(result.shrink).toBeNull();
    expect(result.failureRate).toBe(0);
  });

  it('non-negative: shrinks to an adjacent pair, close to the current values', () => {
    const wb = makeWorkbook([['B1', 50], ['B2', 20], ['B3', '=B1-B2']]);
    const r = rule({
      type: 'non_negative',
      inputs: [input('B1', 0, 100), input('B2', 0, 100)],
      outputs: [addr('B3')],
    });
    const result = runRule(wb, r, config);
    expect(result.status).toBe('failed');
    const scenario = result.counterexample?.scenario;
    expect(scenario?.kind).toBe('point');
    const [b1, b2] = scenario?.kind === 'point' ? scenario.values : [];
    // B1 − B2 < 0 with the smallest possible gap: B2 is exactly one unit above B1.
    expect((b2 as number) - (b1 as number)).toBe(1);
    expect(result.counterexample?.difference).toBe(-1);
  });

  it('non-negative: a confirmed negative output wins over an unevaluable one', () => {
    const wb = makeWorkbook([['B1', 5], ['B2', '=B1-100'], ['B3', '=1/0']]);
    const r = rule({ type: 'non_negative', inputs: [input('B1', 0, 10)], outputs: [addr('B3'), addr('B2')] });
    const result = runRule(wb, r, { numRuns: 50, seed: 1 });
    expect(result.status).toBe('failed');
    expect(result.failed).toBe(50);
  });

  it('monotonic: shrinks a decreasing function to an adjacent pair next to the current value', () => {
    const wb = makeWorkbook([['B1', 5], ['B2', '=100-B1']]);
    const r = rule({ type: 'monotonic_increasing', input: input('B1', 0, 100), context: [], output: addr('B2') });
    const result = runRule(wb, r, config);
    expect(result.status).toBe('failed');
    const scenario = result.counterexample?.scenario;
    expect(scenario?.kind).toBe('pair');
    if (scenario?.kind === 'pair') {
      expect(scenario.high - scenario.low).toBe(1);
      expect(Math.abs(scenario.high - 5)).toBeLessThanOrEqual(1); // the current value of B1 is 5
    }
    expect(result.counterexample?.difference).toBe(-1);
  });

  it('monotonic: increasing and decreasing rules are checked in the right direction', () => {
    const rising = makeWorkbook([['B1', 5], ['B2', '=B1*3+1']]);
    const falling = makeWorkbook([['B1', 5], ['B2', '=100-B1']]);
    const inc = rule({ type: 'monotonic_increasing', input: input('B1', 0, 100), context: [], output: addr('B2') });
    const dec = rule({ type: 'monotonic_decreasing', input: input('B1', 0, 100), context: [], output: addr('B2') });
    expect(runRule(rising, inc, config).status).toBe('passed');
    expect(runRule(falling, dec, config).status).toBe('passed');
    expect(runRule(rising, dec, config).status).toBe('failed');
    expect(runRule(falling, inc, config).status).toBe('failed');
  });

  it('monotonic: a flat output passes (non-strict), within tolerance too', () => {
    const flat = makeWorkbook([['B1', 5], ['B2', '=10']]);
    const r = rule({ type: 'monotonic_increasing', input: input('B1', 0, 100), context: [], output: addr('B2') });
    expect(runRule(flat, r, config).status).toBe('passed');
    const jitter = makeWorkbook([['B1', 5], ['B2', '=100-B1/1000']]);
    const loose = rule({ type: 'monotonic_increasing', input: input('B1', 0, 100), context: [], output: addr('B2'), tolerance: 0.2 });
    expect(runRule(jitter, loose, config).status).toBe('passed');
  });

  it('invariant: detects a wrong claim and accepts a true one', () => {
    const wb = makeWorkbook([['B1', 3], ['B2', 4], ['B3', '=B1*B2']]);
    const wrong = rule({ type: 'invariant', inputs: [input('B1', 0, 20), input('B2', 0, 20)], left: 'B3', relation: '==', right: 'B1 + B2' });
    const right = rule({ type: 'invariant', inputs: [input('B1', 0, 20), input('B2', 0, 20)], left: 'B3', relation: '==', right: 'B1 * B2' });
    const bound = rule({ type: 'invariant', inputs: [input('B1', 0, 20), input('B2', 0, 20)], left: 'B3', relation: '<=', right: 'B1 * B2 + 0.5' });
    expect(runRule(wb, wrong, config).status).toBe('failed');
    expect(runRule(wb, right, config).status).toBe('passed');
    expect(runRule(wb, bound, config).status).toBe('passed');
    const ce = runRule(wb, wrong, config).counterexample;
    expect(ce?.expected).toBe('B3 = B1 + B2');
    expect(ce?.findings[0]?.level).toBe('confirmed');
  });

  it('invariant: relative tolerance absorbs rounding differences', () => {
    const wb = makeWorkbook([['B1', 3], ['B2', '=ROUND(B1/3, 2)']]);
    const strict = rule({ type: 'invariant', inputs: [input('B1', 1, 1000)], left: 'B2', relation: '==', right: 'B1 / 3' });
    const relaxed = rule({ type: 'invariant', inputs: [input('B1', 1, 1000)], left: 'B2', relation: '==', right: 'B1 / 3', tolerance: 0.005 });
    expect(runRule(wb, strict, config).status).toBe('failed');
    expect(runRule(wb, relaxed, config).status).toBe('passed');
  });

  it('conditional: shrinks to the boundary and reports skipped scenarios as inconclusive, not passed', () => {
    const wb = makeWorkbook([['B1', 5], ['B2', '=B1*B1']]);
    const r = rule({
      type: 'conditional',
      inputs: [input('B1', 0, 100)],
      when: { left: 'B1', op: '>', right: '10' },
      then: { left: 'B2', op: '<=', right: '100' },
    });
    const result = runRule(wb, r, config);
    expect(result.status).toBe('failed');
    expect(result.counterexample?.scenario).toEqual({ kind: 'point', values: [11] });
    expect(result.inconclusiveReasons.precondition_not_met).toBeGreaterThan(0);
    expect(result.passed + result.failed + result.inconclusive).toBe(result.executed);
  });

  it('conditional: if the condition never occurs, the rule is inconclusive, never passed', () => {
    const wb = makeWorkbook([['B1', 5], ['B2', '=B1']]);
    const r = rule({
      type: 'conditional',
      inputs: [input('B1', 0, 10)],
      when: { left: 'B1', op: '>', right: '1000' },
      then: { left: 'B2', op: '>', right: '0' },
    });
    const result = runRule(wb, r, config);
    expect(result.status).toBe('inconclusive');
    expect(result.passed).toBe(0);
    expect(result.inconclusive).toBe(result.executed);
  });
});

describe('inconclusive results are never counted as passes', () => {
  it('division by zero in part of the range: counted separately, rule still passes on the rest', () => {
    const wb = makeWorkbook([['B1', 5], ['B2', '=1/B1']]);
    const r = rule({ type: 'non_negative', inputs: [input('B1', 0, 10)], outputs: [addr('B2')] });
    const result = runRule(wb, r, config);
    expect(result.status).toBe('passed');
    expect(result.inconclusiveReasons.division_by_zero).toBeGreaterThan(0);
    expect(result.passed + result.inconclusive).toBe(result.executed);
    expect(result.inconclusiveSamples.division_by_zero).toMatch(/#DIV\/0!/);
  });

  it('unsupported function: every scenario inconclusive, with an explicit warning', () => {
    const wb = makeWorkbook([['B1', 5], ['B2', '=FOOBAR(B1)']]);
    const r = rule({ type: 'non_negative', inputs: [input('B1', 0, 10)], outputs: [addr('B2')] });
    const result = runRule(wb, r, config);
    expect(result.status).toBe('inconclusive');
    expect(result.passed).toBe(0);
    expect(result.inconclusiveReasons.unsupported_function).toBe(result.executed);
    expect(result.warnings.join(' ')).toMatch(/FOOBAR\(\) is not supported/);
  });

  it('circular references and non-numeric results are inconclusive', () => {
    const cyc = makeWorkbook([['B1', 1], ['B2', '=B3+1'], ['B3', '=B2+1']]);
    const r1 = rule({ type: 'non_negative', inputs: [input('B1', 0, 10)], outputs: [addr('B2')] });
    const a = runRule(cyc, r1, { numRuns: 100, seed: 1 });
    expect(a.status).toBe('inconclusive');
    expect(a.inconclusiveReasons.circular_reference).toBe(100);

    const text = makeWorkbook([['B1', 1], ['B2', '="abc"&B1']]);
    const b = runRule(text, rule({ type: 'non_negative', inputs: [input('B1', 0, 10)], outputs: [addr('B2')] }), { numRuns: 100, seed: 1 });
    expect(b.status).toBe('inconclusive');
    expect(b.inconclusiveReasons.non_numeric).toBe(100);
  });

  it('warns when no mapped input can influence the output (a vacuous pass)', () => {
    const wb = makeWorkbook([['B1', 5], ['B2', 7], ['B3', '=B2*2']]);
    const r = rule({ type: 'monotonic_increasing', input: input('B1', 0, 10), context: [], output: addr('B3') });
    const result = runRule(wb, r, { numRuns: 50, seed: 1 });
    expect(result.status).toBe('passed');
    expect(result.warnings.join(' ')).toMatch(/None of the mapped input cells feeds the cells being checked/);
  });

  it('warns when the raised input specifically cannot influence the output', () => {
    const wb = makeWorkbook([['B1', 5], ['B2', 7], ['B3', '=B2*2']]);
    const r = rule({
      type: 'monotonic_increasing',
      input: input('B1', 0, 10),
      context: [input('B2', 0, 10)], // this one does feed B3, so the general warning does not apply
      output: addr('B3'),
    });
    const result = runRule(wb, r, { numRuns: 50, seed: 1 });
    expect(result.warnings.join(' ')).toMatch(/B1 does not feed B3/);
  });

  it('notes when an input cell contains a formula that will be overwritten', () => {
    const wb = makeWorkbook([['B1', '=2+3'], ['B2', '=B1*2']]);
    const r = rule({ type: 'bounds', inputs: [input('B1', 0, 10)], output: addr('B2'), min: 0, max: 100 });
    expect(runRule(wb, r, { numRuns: 20, seed: 1 }).warnings.join(' ')).toMatch(/B1 contains a formula/);
  });
});

describe('isolation, reproducibility and limits', () => {
  it('never mutates the workbook and never leaks state between scenarios or runs', () => {
    const wb = buildFreightWorkbook();
    const before = JSON.stringify(wb);
    for (const r of buildFreightRules()) {
      const first = runRule(wb, r, { numRuns: 300, seed: 5 });
      const second = runRule(wb, r, { numRuns: 300, seed: 5 });
      expect(first.errors, r.id).toEqual([]); // includes the engine's own leak check
      expect(second.passed, r.id).toBe(first.passed);
      expect(second.failed, r.id).toBe(first.failed);
      expect(second.counterexample?.scenario, r.id).toEqual(first.counterexample?.scenario);
    }
    expect(JSON.stringify(wb)).toBe(before);
  });

  it('different seeds explore different scenarios; the same seed repeats exactly', () => {
    const wb = buildFreightWorkbook();
    const flagship = buildFreightRules().find((x) => x.id === SAMPLE_FLAGSHIP_RULE_ID)!;
    const at = [1, 2, 3, 4].map((seed) => runRule(wb, flagship, { numRuns: 1000, seed }).firstFailureAt);
    expect(new Set(at).size).toBeGreaterThan(1);
    expect(runRule(wb, flagship, { numRuns: 1000, seed: 3 }).firstFailureAt).toBe(at[2]);
  });

  it('reports the number of scenarios actually executed when the time limit stops a run', () => {
    const wb = buildFreightWorkbook();
    const flagship = buildFreightRules().find((x) => x.id === SAMPLE_FLAGSHIP_RULE_ID)!;
    const result = runRule(wb, flagship, { numRuns: 50_000, seed: 1 }, { timeLimitMs: 1 });
    expect(result.interrupted).toBe(true);
    expect(result.requestedRuns).toBe(50_000);
    expect(result.executed).toBeGreaterThan(0);
    expect(result.executed).toBeLessThan(50_000);
    expect(result.passed + result.failed + result.inconclusive).toBe(result.executed);
    expect(result.warnings.join(' ')).toMatch(/time limit stopped the run after/);
  });

  it('refuses to run an impossible or invalid test and says why', () => {
    const wb = makeWorkbook([['B1', 1], ['B2', '=B1']]);
    const ok = { type: 'bounds', inputs: [input('B1', 0, 10)], output: addr('B2'), min: 0, max: 5 };

    const emptyOutput = runRule(wb, rule({ ...ok, output: addr('B9') }), config);
    expect(emptyOutput.errors.join()).toMatch(/B9 is empty/);

    const outside = runRule(wb, rule({ ...ok, inputs: [input('Z50', 0, 10)] }), config);
    expect(outside.errors.join()).toMatch(/outside the used range/);

    const noSheet = runRule(wb, rule({ ...ok, inputs: [input('B1', 0, 10, 0, 'Nope')] }), config);
    expect(noSheet.errors.join()).toMatch(/sheet "Nope" does not exist/);

    const invalidRule = runRule(wb, { type: 'bounds' }, config);
    expect(invalidRule.errors.length).toBeGreaterThan(0);

    const badConfig = runRule(wb, rule(ok), { numRuns: 3, seed: 1 });
    expect(badConfig.errors.join()).toMatch(/At least 10 scenarios/);

    for (const r of [emptyOutput, outside, noSheet, invalidRule, badConfig]) {
      expect(r.status).toBe('inconclusive');
      expect(r.executed).toBe(0);
      expect(r.passed).toBe(0);
    }
  });
});

describe('replaying counterexamples', () => {
  const wb = buildFreightWorkbook();
  const flagship = buildFreightRules().find((x) => x.id === SAMPLE_FLAGSHIP_RULE_ID)!;

  it('replays a saved scenario and refuses a scenario of the wrong shape', () => {
    const ce = runRule(wb, flagship, { numRuns: 1000, seed: 1031 }).counterexample!;
    expect(replayScenario(wb, flagship, ce.scenario).verdict?.kind).toBe('fail');
    expect(replayScenario(wb, flagship, { kind: 'point', values: [1, 2] }).verdict).toBeNull();
    expect(replayScenario(wb, flagship, { kind: 'pair', context: [1], low: 1, high: 2 }).verdict).toBeNull();
  });

  it('shows the grid as the scenario computed it, without touching the workbook', () => {
    const snapshot = JSON.stringify(wb);
    const ce = runRule(wb, flagship, { numRuns: 1000, seed: 1031 }).counterexample!;
    const out = ce.cells.find((c) => c.role === 'output')!;
    const lower = sheetValuesForScenario(wb, flagship, ce.scenario, 0, 'Quote');
    const higher = sheetValuesForScenario(wb, flagship, ce.scenario, 1, 'Quote');
    expect(lower?.[13]?.[1]).toBe(out.values[0]); // B14 in the lower run
    expect(higher?.[13]?.[1]).toBe(out.values[1]); // B14 in the higher run
    expect(higher?.[13]?.[1] as number).toBeLessThan(lower?.[13]?.[1] as number);
    expect(JSON.stringify(wb)).toBe(snapshot);
    expect(sheetValuesForScenario(wb, flagship, { kind: 'point', values: [1] }, 0, 'Quote')).toBeNull();
  });
});
