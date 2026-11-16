import fc from 'fast-check';
import type { InvariantRule } from '../../schemas/rule';
import type { Counterexample, Finding, ScenarioJson, Verdict } from '../../types/testing';
import type { CellRefModel } from '../../types/workbook';
import { formatNumber, formatSigned } from '../../utils/format';
import { numberArbitrary } from '../generators/numberArbitrary';
import { relatedFormulaCells } from '../calculation/graph';
import { evaluateExpression } from '../expression/evaluate';
import { parseExpression } from '../expression/parser';
import { buildCells, makeHighlight, readAll, type TrackedCell } from './explain';
import { expressionCells } from './refs';
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

/** `left <relation> right` holds (within tolerance) for every generated combination of inputs. */
export function createInvariantProperty(rule: InvariantRule, pc: PropertyContext): PropertyDefinition<PointScenario> {
  const { engine, workbook } = pc;
  const bindings = rule.inputs.map((spec) => bindInput(engine, spec));
  const evalCtx = makeEvalContext(engine, rule.sheet);
  const left = parseExpression(rule.left);
  const right = parseExpression(rule.right);

  const arbitrary: fc.Arbitrary<PointScenario> = fc
    .tuple(...bindings.map((b) => numberArbitrary(b.spec, b.baselineValue)))
    .map((values) => ({ values }));

  const holds = (l: number, r: number): boolean => {
    const tol = rule.tolerance + rule.relativeTolerance * Math.max(Math.abs(l), Math.abs(r));
    switch (rule.relation) {
      case '==':
        return Math.abs(l - r) <= tol;
      case '<=':
        return l <= r + tol;
      case '>=':
        return l >= r - tol;
    }
  };

  const evaluate = (s: PointScenario): Verdict => {
    try {
      applyInputs(engine, bindings, s.values);
      const l = evaluateExpression(left, evalCtx);
      if (!l.ok) return inconclusive(l);
      const r = evaluateExpression(right, evalCtx);
      if (!r.ok) return inconclusive(r);
      return holds(l.value, r.value) ? PASS : FAIL;
    } finally {
      restoreInputs(engine, bindings);
    }
  };

  const explain = (s: PointScenario, seed: number): Counterexample => {
    const referenced = [...expressionCells(rule.left, rule.sheet), ...expressionCells(rule.right, rule.sheet)];
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
    let l: number | null = null;
    let r: number | null = null;
    try {
      baseline = readAll(engine, refs);
      applyInputs(engine, bindings, s.values);
      run = readAll(engine, refs);
      const lo = evaluateExpression(left, evalCtx);
      const ro = evaluateExpression(right, evalCtx);
      l = lo.ok ? lo.value : null;
      r = ro.ok ? ro.value : null;
    } finally {
      restoreInputs(engine, bindings);
    }
    const sym = rule.relation === '==' ? '=' : rule.relation;
    const gap = l !== null && r !== null ? l - r : null;
    const findings: Finding[] = [
      {
        level: 'confirmed',
        text:
          l !== null && r !== null
            ? `With these inputs, the left side \`${rule.left}\` evaluates to ${formatNumber(l)} and the right side \`${rule.right}\` to ${formatNumber(r)} (difference ${formatSigned(l - r)}).`
            : 'The two sides of the rule disagree for these inputs.',
      },
      {
        level: 'suggested',
        text: 'Compare the calculated values of the referenced cells in the table with the formulas that produce them. The table shows evidence; it does not by itself identify which formula is wrong.',
      },
    ];
    const formulaCells = unique.flatMap((c) => relatedFormulaCells(engine, c, 3));
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      seed,
      runs: ['Failing scenario'],
      cells: buildCells({ workbook, engine, tracked, baseline, runs: [run] }),
      violation:
        l !== null && r !== null
          ? `${rule.left} = ${formatNumber(l)} but ${rule.right} = ${formatNumber(r)}; the rule requires ${rule.left} ${sym} ${rule.right}.`
          : `${rule.left} ${sym} ${rule.right} does not hold.`,
      expected: `${rule.left} ${sym} ${rule.right}`,
      actual: l !== null && r !== null ? `${formatNumber(l)} vs ${formatNumber(r)}` : 'The relation does not hold.',
      difference: gap,
      findings,
      highlight: makeHighlight({
        inputs: rule.inputs.map((i) => i.cell),
        outputs: [],
        failing: unique,
        suspects: [],
        related: formulaCells,
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
      ...expressionCells(rule.left, rule.sheet),
      ...expressionCells(rule.right, rule.sheet),
    ],
  };
}
