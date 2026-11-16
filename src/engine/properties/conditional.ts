import fc from 'fast-check';
import type { Comparison, ConditionalRule } from '../../schemas/rule';
import type { Counterexample, Finding, ScenarioJson, Verdict } from '../../types/testing';
import type { CellRefModel } from '../../types/workbook';
import { formatNumber } from '../../utils/format';
import { numberArbitrary } from '../generators/numberArbitrary';
import { relatedFormulaCells } from '../calculation/graph';
import { evaluateExpression, type EvalContext, type NumericOutcome } from '../expression/evaluate';
import { parseExpression, type Expr } from '../expression/parser';
import { buildCells, makeHighlight, readAll, type TrackedCell } from './explain';
import { expressionCells } from './refs';
import {
  FAIL,
  PASS,
  applyInputs,
  bindInput,
  compare,
  inconclusive,
  inconclusiveBecause,
  makeEvalContext,
  pointFromJson,
  restoreInputs,
  sameRef,
  type PropertyContext,
  type PropertyDefinition,
} from './shared';
import type { PointScenario } from './bounds';

interface CompiledComparison {
  source: Comparison;
  left: Expr;
  right: Expr;
}

function compile(c: Comparison): CompiledComparison {
  return { source: c, left: parseExpression(c.left), right: parseExpression(c.right) };
}

type Evaluated = { ok: true; left: number; right: number; holds: boolean } | Extract<NumericOutcome, { ok: false }>;

function evaluateComparison(c: CompiledComparison, ctx: EvalContext, tolerance: number): Evaluated {
  const l = evaluateExpression(c.left, ctx);
  if (!l.ok) return l;
  const r = evaluateExpression(c.right, ctx);
  if (!r.ok) return r;
  return { ok: true, left: l.value, right: r.value, holds: compare(c.source.op, l.value, r.value, tolerance) };
}

function show(c: Comparison): string {
  return `${c.left} ${c.op} ${c.right}`;
}

/** If `when` holds then `then` must hold. Scenarios where `when` is false are inconclusive, not passes. */
export function createConditionalProperty(rule: ConditionalRule, pc: PropertyContext): PropertyDefinition<PointScenario> {
  const { engine, workbook } = pc;
  const bindings = rule.inputs.map((spec) => bindInput(engine, spec));
  const evalCtx = makeEvalContext(engine, rule.sheet);
  const when = compile(rule.when);
  const then = compile(rule.then);

  const arbitrary: fc.Arbitrary<PointScenario> = fc
    .tuple(...bindings.map((b) => numberArbitrary(b.spec, b.baselineValue)))
    .map((values) => ({ values }));

  const evaluate = (s: PointScenario): Verdict => {
    try {
      applyInputs(engine, bindings, s.values);
      const w = evaluateComparison(when, evalCtx, rule.tolerance);
      if (!w.ok) return inconclusive(w);
      if (!w.holds) {
        return inconclusiveBecause('precondition_not_met', `Condition not met: ${show(rule.when)}`);
      }
      const t = evaluateComparison(then, evalCtx, rule.tolerance);
      if (!t.ok) return inconclusive(t);
      return t.holds ? PASS : FAIL;
    } finally {
      restoreInputs(engine, bindings);
    }
  };

  const explain = (s: PointScenario, seed: number): Counterexample => {
    const referenced = [
      ...expressionCells(rule.when.left, rule.sheet),
      ...expressionCells(rule.when.right, rule.sheet),
      ...expressionCells(rule.then.left, rule.sheet),
      ...expressionCells(rule.then.right, rule.sheet),
    ];
    const unique: CellRefModel[] = [];
    for (const r of referenced) {
      if (!unique.some((u) => sameRef(u, r)) && !rule.inputs.some((i) => sameRef(i.cell, r))) unique.push(r);
    }
    const tracked: TrackedCell[] = [
      ...rule.inputs.map((i): TrackedCell => ({ ref: i.cell, role: 'input' })),
      ...unique.map((ref): TrackedCell => ({ ref, role: 'referenced' })),
    ];
    const refs = tracked.map((t) => t.ref);
    let baseline;
    let run;
    let w: Evaluated | null = null;
    let t: Evaluated | null = null;
    try {
      baseline = readAll(engine, refs);
      applyInputs(engine, bindings, s.values);
      run = readAll(engine, refs);
      w = evaluateComparison(when, evalCtx, rule.tolerance);
      t = evaluateComparison(then, evalCtx, rule.tolerance);
    } finally {
      restoreInputs(engine, bindings);
    }
    const thenFailed = t && t.ok ? t : null;
    const findings: Finding[] = [
      {
        level: 'confirmed',
        text:
          w && w.ok && thenFailed
            ? `The condition \`${show(rule.when)}\` holds (${formatNumber(w.left)} ${rule.when.op} ${formatNumber(w.right)}), but the requirement \`${show(rule.then)}\` does not (${formatNumber(thenFailed.left)} ${rule.then.op} ${formatNumber(thenFailed.right)} is false).`
            : 'The condition holds but the requirement does not.',
      },
      {
        level: 'suggested',
        text: 'Check the formulas behind the requirement cell in the table at these input values. The table shows calculated values; it does not by itself identify the faulty formula.',
      },
    ];
    const related = unique.flatMap((c) => relatedFormulaCells(engine, c, 3));
    const thenCells = [
      ...expressionCells(rule.then.left, rule.sheet),
      ...expressionCells(rule.then.right, rule.sheet),
    ];
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      seed,
      runs: ['Failing scenario'],
      cells: buildCells({ workbook, engine, tracked, baseline, runs: [run] }),
      violation: `If ${show(rule.when)} then ${show(rule.then)} must hold, but it does not for these inputs.`,
      expected: `${show(rule.then)} whenever ${show(rule.when)}.`,
      actual: thenFailed
        ? `${formatNumber(thenFailed.left)} ${rule.then.op} ${formatNumber(thenFailed.right)} is false.`
        : 'The requirement does not hold.',
      difference: thenFailed ? thenFailed.left - thenFailed.right : null,
      findings,
      highlight: makeHighlight({
        inputs: rule.inputs.map((i) => i.cell),
        outputs: [],
        failing: thenCells,
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
    trackedCells: () => [
      ...rule.inputs.map((i) => i.cell),
      ...expressionCells(rule.when.left, rule.sheet),
      ...expressionCells(rule.when.right, rule.sheet),
      ...expressionCells(rule.then.left, rule.sheet),
      ...expressionCells(rule.then.right, rule.sheet),
    ],
  };
}
