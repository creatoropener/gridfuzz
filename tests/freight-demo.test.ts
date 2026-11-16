import { describe, expect, it } from 'vitest';
import { applyEdits } from '../src/engine/workbook/edits';
import { runRule, replayScenario } from '../src/engine/runRule';
import {
  SAMPLE_FAULTY_CELL,
  SAMPLE_FIXED_FORMULA,
  SAMPLE_FLAGSHIP_RULE_ID,
  SAMPLE_SHEET,
  buildFreightRules,
  buildFreightWorkbook,
} from '../src/engine/samples/freightQuote';
import { DEFAULT_SEED } from '../src/schemas/rule';
import { CalcEngine } from '../src/engine/calculation/CalcEngine';

const config = { numRuns: 1000, seed: DEFAULT_SEED };
const rules = buildFreightRules();
const flagship = rules.find((r) => r.id === SAMPLE_FLAGSHIP_RULE_ID);
if (!flagship) throw new Error('flagship rule missing');

describe('freight quote demonstration (real engine, no canned results)', () => {
  it('calculates the sample workbook with HyperFormula', () => {
    const engine = CalcEngine.fromWorkbook(buildFreightWorkbook());
    // 2400 + 180 + 350 + 125 + 60 = 3115 (below the 3,500 rebate threshold)
    expect(engine.getValue(SAMPLE_SHEET, 'B10')).toBe(3115);
    expect(engine.getValue(SAMPLE_SHEET, 'B11')).toBe(0);
    expect(engine.getValue(SAMPLE_SHEET, 'B13')).toBeCloseTo(280.35, 2);
    expect(engine.getValue(SAMPLE_SHEET, 'B14')).toBeCloseTo(3395.35, 2);
    engine.destroy();
  });

  it('finds a genuine violation, shrinks it, and the counterexample replays', () => {
    const workbook = buildFreightWorkbook();
    const result = runRule(workbook, flagship, config);

    expect(result.errors).toEqual([]);
    expect(result.status).toBe('failed');
    expect(result.executed).toBe(1000);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.passed + result.failed + result.inconclusive).toBe(result.executed);
    expect(result.shrink).not.toBeNull();
    expect(result.shrink?.reproducible).toBe(true);

    const ce = result.counterexample;
    expect(ce).not.toBeNull();
    if (!ce) return;
    const output = ce.cells.find((c) => c.role === 'output');
    expect(output?.cell.address).toBe('B14');
    const [lowOut, highOut] = output?.values ?? [];
    // The reported violation is real: the output actually went DOWN when the input went UP.
    expect(typeof lowOut).toBe('number');
    expect(typeof highOut).toBe('number');
    expect(highOut as number).toBeLessThan(lowOut as number);
    expect(ce.scenario.kind).toBe('pair');

    // Shrinking really shrank: the gap between the two inputs is no larger than in the first failure.
    const [lowIn, highIn] = ce.cells.find((c) => c.role === 'input')?.values ?? [];
    const original = result.shrink?.originalScenario;
    expect(original?.kind).toBe('pair');
    if (original?.kind === 'pair') {
      expect((highIn as number) - (lowIn as number)).toBeLessThanOrEqual(original.high - original.low);
    }

    // The counterexample is the genuine bug: the subtotal straddles the 3,500 rebate threshold.
    const subtotal = ce.cells.find((c) => c.cell.address === 'B10')?.values ?? [];
    expect(subtotal[0] as number).toBeLessThanOrEqual(3500);
    expect(subtotal[1] as number).toBeGreaterThan(3500);

    // Evidence, with confirmed facts kept apart from suggestions:
    //  - Taxable amount (B12) is the first cell whose value moved against the rule (confirmed).
    //  - The faulty Volume rebate (B11) is offered as a suspect, never as a confirmed root cause.
    expect(ce.highlight.failing.some((c) => c.address === 'B12')).toBe(true);
    expect(ce.highlight.suspects.some((c) => c.address === SAMPLE_FAULTY_CELL)).toBe(true);
    expect(ce.findings.some((f) => f.level === 'confirmed' && f.text.includes('B12'))).toBe(true);
    expect(ce.findings.some((f) => f.level === 'suggested' && f.text.includes(SAMPLE_FAULTY_CELL))).toBe(true);
    // (B11 may appear inside another cell's formula text, so check the finding's subject, not a substring.)
    expect(ce.findings.some((f) => f.level === 'confirmed' && f.text.startsWith('Volume rebate (B11)'))).toBe(false);

    // Replaying the saved scenario on the unchanged workbook fails again.
    const replay = replayScenario(workbook, flagship, ce.scenario);
    expect(replay.verdict?.kind).toBe('fail');
  });

  it('is deterministic: the same seed gives identical results', () => {
    const a = runRule(buildFreightWorkbook(), flagship, config);
    const b = runRule(buildFreightWorkbook(), flagship, config);
    expect(b.failed).toBe(a.failed);
    expect(b.firstFailureAt).toBe(a.firstFailureAt);
    expect(b.counterexample?.scenario).toEqual(a.counterexample?.scenario);
  });

  it('passes the exact same test after the formula is corrected', () => {
    const original = buildFreightWorkbook();
    const before = runRule(original, flagship, config);
    expect(before.status).toBe('failed');

    const edits = [{ sheet: SAMPLE_SHEET, address: SAMPLE_FAULTY_CELL, content: SAMPLE_FIXED_FORMULA }];
    const fixed = applyEdits(original, edits);
    const after = runRule(fixed, flagship, config, { edits });

    expect(after.errors).toEqual([]);
    expect(after.status).toBe('passed');
    expect(after.failed).toBe(0);
    expect(after.executed).toBe(1000);
    expect(after.seed).toBe(before.seed);
    expect(after.workingCopy).not.toBe(before.workingCopy);

    // The previous counterexample no longer fails on the fixed workbook.
    if (!before.counterexample) throw new Error('expected a counterexample');
    const replay = replayScenario(fixed, flagship, before.counterexample.scenario);
    expect(replay.verdict?.kind).toBe('pass');
  });

  it('does not mutate the original workbook when edits are applied', () => {
    const original = buildFreightWorkbook();
    const snapshot = JSON.stringify(original);
    applyEdits(original, [{ sheet: SAMPLE_SHEET, address: SAMPLE_FAULTY_CELL, content: SAMPLE_FIXED_FORMULA }]);
    runRule(original, flagship, { numRuns: 50, seed: 7 });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('the other sample rules run and pass on the faulty workbook', () => {
    for (const rule of rules.filter((r) => r.id !== SAMPLE_FLAGSHIP_RULE_ID)) {
      const result = runRule(buildFreightWorkbook(), rule, { numRuns: 300, seed: DEFAULT_SEED });
      expect(result.errors, rule.id).toEqual([]);
      expect(result.status, rule.id).toBe('passed');
      expect(result.executed, rule.id).toBe(300);
    }
  });
});
