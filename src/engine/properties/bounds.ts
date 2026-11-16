import fc from 'fast-check';
import type { BoundsRule } from '../../schemas/rule';
import type { Counterexample, Finding, ScenarioJson, Verdict } from '../../types/testing';
import { formatNumber } from '../../utils/format';
import { numberArbitrary } from '../generators/numberArbitrary';
import { relatedFormulaCells } from '../calculation/graph';
import { readNumeric } from '../expression/evaluate';
import { buildCells, makeHighlight, nameOf, readAll, type TrackedCell } from './explain';
import {
  FAIL,
  PASS,
  applyInputs,
  bindInput,
  inconclusive,
  makeEvalContext,
  pointFromJson,
  restoreInputs,
  type PropertyContext,
  type PropertyDefinition,
} from './shared';

export interface PointScenario {
  values: number[];
}

/** For every generated combination of inputs, the output stays within [min, max]. */
export function createBoundsProperty(rule: BoundsRule, pc: PropertyContext): PropertyDefinition<PointScenario> {
  const { engine, workbook } = pc;
  const bindings = rule.inputs.map((spec) => bindInput(engine, spec));
  const output = rule.output;
  const evalCtx = makeEvalContext(engine, rule.sheet);

  const arbitrary: fc.Arbitrary<PointScenario> = fc
    .tuple(...bindings.map((b) => numberArbitrary(b.spec, b.baselineValue)))
    .map((values) => ({ values }));

  const violation = (value: number): 'below' | 'above' | null => {
    if (rule.min !== null && value < rule.min - rule.tolerance) return 'below';
    if (rule.max !== null && value > rule.max + rule.tolerance) return 'above';
    return null;
  };

  const evaluate = (s: PointScenario): Verdict => {
    try {
      applyInputs(engine, bindings, s.values);
      const out = readNumeric(evalCtx, output.sheet, output.address);
      if (!out.ok) return inconclusive(out);
      return violation(out.value) === null ? PASS : FAIL;
    } finally {
      restoreInputs(engine, bindings);
    }
  };

  const explain = (s: PointScenario, seed: number): Counterexample => {
    const related = relatedFormulaCells(engine, output);
    const tracked: TrackedCell[] = [
      ...rule.inputs.map((i): TrackedCell => ({ ref: i.cell, role: 'input' })),
      { ref: output, role: 'output' },
      ...related.map((ref): TrackedCell => ({ ref, role: 'path' })),
    ];
    const refs = tracked.map((t) => t.ref);
    let baseline;
    let run;
    try {
      baseline = readAll(engine, refs);
      applyInputs(engine, bindings, s.values);
      run = readAll(engine, refs);
    } finally {
      restoreInputs(engine, bindings);
    }
    const value = run[refs.length - related.length - 1];
    const actualValue = typeof value === 'number' ? value : null;
    const side = actualValue === null ? null : violation(actualValue);
    const outName = nameOf(workbook, output);
    const limitText = [
      rule.min !== null ? `at least ${formatNumber(rule.min)}` : null,
      rule.max !== null ? `at most ${formatNumber(rule.max)}` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    const bound = side === 'below' ? rule.min : side === 'above' ? rule.max : null;
    const findings: Finding[] = [
      {
        level: 'confirmed',
        text:
          actualValue !== null && bound !== null
            ? `With these inputs ${outName} evaluates to ${formatNumber(actualValue)}, which is ${side} the limit of ${formatNumber(bound)} (by ${formatNumber(Math.abs(actualValue - bound))}).`
            : `With these inputs ${outName} falls outside its allowed range.`,
      },
      {
        level: 'suggested',
        text: `Review the formulas that feed ${output.address} (listed in the table) at these input values. The table shows each cell's calculated value; it does not identify the faulty formula by itself.`,
      },
    ];
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      seed,
      runs: ['Failing scenario'],
      cells: buildCells({ workbook, engine, tracked, baseline, runs: [run] }),
      violation:
        actualValue !== null
          ? `${outName} evaluated to ${formatNumber(actualValue)} for generated inputs, outside the allowed range (${limitText}).`
          : `${outName} violated its allowed range (${limitText}).`,
      expected: `${outName} should be ${limitText}.`,
      actual: actualValue !== null ? `${outName} = ${formatNumber(actualValue)}.` : `${outName} was out of range.`,
      difference: actualValue !== null && bound !== null ? actualValue - bound : null,
      findings,
      highlight: makeHighlight({
        inputs: rule.inputs.map((i) => i.cell),
        outputs: [output],
        failing: [output],
        suspects: [],
        related,
      }),
      scenario: toJson(s),
    };
  };

  const toJson = (s: PointScenario): ScenarioJson => ({ kind: 'point', values: s.values });
  const fromJson = (json: ScenarioJson): PointScenario | null => {
    const values = pointFromJson(json, bindings.length);
    return values ? { values } : null;
  };

  return {
    arbitrary,
    evaluate,
    explain,
    toJson,
    fromJson,
    trackedCells: () => [...rule.inputs.map((i) => i.cell), output],
  };
}
