import fc from 'fast-check';
import type { NonNegativeRule } from '../../schemas/rule';
import type { CellRefModel } from '../../types/workbook';
import type { Counterexample, Finding, ScenarioJson, Verdict } from '../../types/testing';
import { formatNumber } from '../../utils/format';
import { numberArbitrary } from '../generators/numberArbitrary';
import { relatedFormulaCells } from '../calculation/graph';
import { readNumeric, type NumericOutcome } from '../expression/evaluate';
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
  sameRef,
  type PropertyContext,
  type PropertyDefinition,
} from './shared';
import type { PointScenario } from './bounds';

/** Every checked output is ≥ 0 (within tolerance) for every generated combination of inputs. */
export function createNonNegativeProperty(rule: NonNegativeRule, pc: PropertyContext): PropertyDefinition<PointScenario> {
  const { engine, workbook } = pc;
  const bindings = rule.inputs.map((spec) => bindInput(engine, spec));
  const evalCtx = makeEvalContext(engine, rule.sheet);

  const arbitrary: fc.Arbitrary<PointScenario> = fc
    .tuple(...bindings.map((b) => numberArbitrary(b.spec, b.baselineValue)))
    .map((values) => ({ values }));

  const readOutputs = (): Array<{ ref: CellRefModel; outcome: NumericOutcome }> =>
    rule.outputs.map((ref) => ({ ref, outcome: readNumeric(evalCtx, ref.sheet, ref.address) }));

  const evaluate = (s: PointScenario): Verdict => {
    try {
      applyInputs(engine, bindings, s.values);
      const outs = readOutputs();
      // A confirmed negative value is a failure even if another output could not be evaluated.
      if (outs.some((o) => o.outcome.ok && o.outcome.value < -rule.tolerance)) return FAIL;
      const bad = outs.find((o) => !o.outcome.ok);
      if (bad && !bad.outcome.ok) return inconclusive(bad.outcome);
      return PASS;
    } finally {
      restoreInputs(engine, bindings);
    }
  };

  const explain = (s: PointScenario, seed: number): Counterexample => {
    const related = rule.outputs.flatMap((o) => relatedFormulaCells(engine, o, 8));
    const tracked: TrackedCell[] = [
      ...rule.inputs.map((i): TrackedCell => ({ ref: i.cell, role: 'input' })),
      ...rule.outputs.map((ref): TrackedCell => ({ ref, role: 'output' })),
      ...related
        .filter((r) => !rule.outputs.some((o) => sameRef(o, r)))
        .map((ref): TrackedCell => ({ ref, role: 'path' })),
    ];
    const refs = tracked.map((t) => t.ref);
    let baseline;
    let run;
    let negative: { ref: CellRefModel; value: number } | null = null;
    try {
      baseline = readAll(engine, refs);
      applyInputs(engine, bindings, s.values);
      run = readAll(engine, refs);
      for (const o of readOutputs()) {
        if (o.outcome.ok && o.outcome.value < -rule.tolerance) {
          negative = { ref: o.ref, value: o.outcome.value };
          break;
        }
      }
    } finally {
      restoreInputs(engine, bindings);
    }
    const target = negative?.ref ?? rule.outputs[0];
    const name = target ? nameOf(workbook, target) : 'The output';
    const findings: Finding[] = [
      {
        level: 'confirmed',
        text: negative
          ? `With these inputs ${name} evaluates to ${formatNumber(negative.value)}, below zero.`
          : `${name} evaluates below zero with these inputs.`,
      },
      {
        level: 'suggested',
        text: `Review the formulas that feed ${target?.address ?? 'the output'} (listed in the table) at these input values. The table shows calculated values; it does not identify the faulty formula by itself.`,
      },
    ];
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      seed,
      runs: ['Failing scenario'],
      cells: buildCells({ workbook, engine, tracked, baseline, runs: [run] }),
      violation: negative
        ? `${name} evaluated to ${formatNumber(negative.value)} for generated inputs.`
        : `${name} went negative for generated inputs.`,
      expected: `${name} should never be negative.`,
      actual: negative ? `${name} = ${formatNumber(negative.value)}.` : `${name} was negative.`,
      difference: negative ? negative.value : null,
      findings,
      highlight: makeHighlight({
        inputs: rule.inputs.map((i) => i.cell),
        outputs: rule.outputs,
        failing: target ? [target] : [],
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
    trackedCells: () => [...rule.inputs.map((i) => i.cell), ...rule.outputs],
  };
}
