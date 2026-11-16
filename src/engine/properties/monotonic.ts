import fc from 'fast-check';
import type { MonotonicRule } from '../../schemas/rule';
import type { Counterexample, Finding, ScenarioJson, Verdict } from '../../types/testing';
import { formatNumber, formatSigned } from '../../utils/format';
import { gridTarget, numberArbitrary } from '../generators/numberArbitrary';
import { dependencyPath, refKey } from '../calculation/graph';
import { readNumeric } from '../expression/evaluate';
import { analyzePath, type PathNode } from './analysis';
import { buildCells, fmt, makeHighlight, nameOf, readAll, stepHint, type TrackedCell } from './explain';
import {
  FAIL,
  PASS,
  applyInputs,
  bindInput,
  inconclusive,
  makeEvalContext,
  restoreInputs,
  sameRef,
  type PropertyContext,
  type PropertyDefinition,
} from './shared';

/** Two evaluations of the same workbook that differ only in the swept input (`low` ≤ `high`). */
export interface PairScenario {
  context: number[];
  low: number;
  high: number;
}

/**
 * Metamorphic property: with every other input fixed, raising the swept input must not push the
 * output in the forbidden direction. Increasing: `output(high) ≥ output(low) − tolerance`.
 * Decreasing: `output(high) ≤ output(low) + tolerance`.
 */
export function createMonotonicProperty(rule: MonotonicRule, pc: PropertyContext): PropertyDefinition<PairScenario> {
  const { engine, workbook } = pc;
  const direction: 1 | -1 = rule.type === 'monotonic_increasing' ? 1 : -1;
  const swept = bindInput(engine, rule.input);
  const context = rule.context.map((spec) => bindInput(engine, spec));
  const all = [swept, ...context];
  const output = rule.output;
  const evalCtx = makeEvalContext(engine, rule.sheet);

  const sweptArb = numberArbitrary(rule.input, swept.baselineValue);

  // Two kinds of before/after pairs:
  //  - wide pairs: two independent values anywhere in the range;
  //  - neighbouring pairs: `low` sits a small gap below `high`. Cliffs, thresholds and tier changes
  //    only produce a visible reversal when the gap is small compared with the jump, so wide
  //    pairs alone would rarely expose them. Parameterised as (high, gap) so that shrinking can
  //    move `high` down to the exact value where the behaviour flips and the gap down to one unit
  //    of precision, which lands on the boundary itself.
  const { lo, hi, scale, target } = gridTarget(rule.input, swept.baselineValue);
  const maxGap = Math.max(1, Math.ceil((hi - lo) * 0.05));
  const widePair = fc.tuple(sweptArb, sweptArb).filter(([a, b]) => a !== b);
  // `high` is an offset from the current value (so shrinking heads towards the user's real data);
  // it is at least lo + 1 so that a lower neighbour always exists.
  const neighbourPair = fc
    .tuple(fc.integer({ min: lo + 1 - target, max: hi - target }), fc.integer({ min: 1, max: maxGap }))
    .map(([offset, gap]): [number, number] => {
      const high = target + offset;
      return [Math.max(lo, high - gap) / scale + 0, high / scale + 0];
    });

  const arbitrary: fc.Arbitrary<PairScenario> = fc
    .record({
      context: fc.tuple(...context.map((b) => numberArbitrary(b.spec, b.baselineValue))),
      pair: fc.oneof(widePair, neighbourPair),
    })
    .map(({ context: values, pair }) => ({
      context: values,
      low: Math.min(pair[0], pair[1]),
      high: Math.max(pair[0], pair[1]),
    }));

  const evaluate = (s: PairScenario): Verdict => {
    try {
      applyInputs(engine, all, [s.low, ...s.context]);
      const lo = readNumeric(evalCtx, output.sheet, output.address);
      if (!lo.ok) return inconclusive(lo);
      applyInputs(engine, [swept], [s.high]);
      const hi = readNumeric(evalCtx, output.sheet, output.address);
      if (!hi.ok) return inconclusive(hi);
      const holds =
        direction === 1 ? hi.value >= lo.value - rule.tolerance : hi.value <= lo.value + rule.tolerance;
      return holds ? PASS : FAIL;
    } finally {
      restoreInputs(engine, all);
    }
  };

  const explain = (s: PairScenario, seed: number): Counterexample => {
    const inputRef = rule.input.cell;
    const path = dependencyPath(engine, inputRef, output);
    const pathRefs = path.cells.some((c) => sameRef(c, output)) ? path.cells : [...path.cells, output];

    const tracked: TrackedCell[] = [
      { ref: inputRef, role: 'input' },
      ...rule.context.map((c): TrackedCell => ({ ref: c.cell, role: 'context' })),
      ...pathRefs.map((ref): TrackedCell => ({ ref, role: sameRef(ref, output) ? 'output' : 'path' })),
    ];
    const refs = tracked.map((t) => t.ref);

    let baseline;
    let runs;
    try {
      baseline = readAll(engine, refs);
      applyInputs(engine, all, [s.low, ...s.context]);
      const lowRun = readAll(engine, refs);
      applyInputs(engine, [swept], [s.high]);
      const highRun = readAll(engine, refs);
      runs = [lowRun, highRun];
    } finally {
      restoreInputs(engine, all);
    }

    const numeric = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const nodes: PathNode[] = pathRefs.map((ref) => {
      const idx = refs.findIndex((r) => sameRef(r, ref));
      return {
        ref,
        formula: engine.getFormula(ref.sheet, ref.address),
        low: numeric(runs[0]?.[idx]),
        high: numeric(runs[1]?.[idx]),
        precedents: path.inPathPrecedents.get(refKey(ref)) ?? [],
      };
    });
    const analysis = analyzePath(nodes, direction, rule.tolerance);

    const cells = buildCells({ workbook, engine, tracked, baseline, runs, flagged: analysis.flagged });
    const outIdx = refs.findIndex((r) => sameRef(r, output));
    const outLow = numeric(runs[0]?.[outIdx]);
    const outHigh = numeric(runs[1]?.[outIdx]);
    const inName = nameOf(workbook, inputRef);
    const outName = nameOf(workbook, output);
    const diff = outLow !== null && outHigh !== null ? outHigh - outLow : null;

    const verb = direction === 1 ? 'lowered' : 'raised';
    const violation =
      outLow !== null && outHigh !== null
        ? `Raising ${inName} from ${formatNumber(s.low)} to ${formatNumber(s.high)} ${verb} ${outName} from ${formatNumber(outLow)} to ${formatNumber(outHigh)} (${formatSigned(outHigh - outLow)}).`
        : `Raising ${inName} from ${formatNumber(s.low)} to ${formatNumber(s.high)} violated the rule.`;

    const findings: Finding[] = [
      {
        level: 'confirmed',
        text: `Same workbook, same other inputs: only ${inName} changed (${formatNumber(s.low)} → ${formatNumber(s.high)}), and ${outName} moved ${outLow !== null && outHigh !== null ? `${formatNumber(outLow)} → ${formatNumber(outHigh)}` : 'in the forbidden direction'}.`,
      },
    ];
    for (const node of analysis.earliest) {
      findings.push({
        level: 'confirmed',
        text: `${nameOf(workbook, node.ref)}${node.formula ? ` (${node.formula})` : ''} is the first cell on the dependency path from ${inputRef.address} to ${output.address} whose value moved against the rule: ${fmt(node.low)} → ${fmt(node.high)}.`,
      });
    }
    for (const suspect of analysis.suspects.filter((x) => x.level === 'suggested')) {
      const node = nodes.find((n) => sameRef(n.ref, suspect.ref));
      // Which cell to look at first is a heuristic, so this is a suggestion even though the numbers in it are real.
      findings.push({
        level: 'suggested',
        text: `${nameOf(workbook, suspect.ref)}${node?.formula ? ` (${node.formula})` : ''}: ${suspect.reason}`,
      });
      const hint = stepHint(workbook, engine, suspect.ref);
      if (hint) findings.push(hint);
    }
    for (const node of analysis.earliest) {
      if (analysis.suspects.some((x) => x.level === 'suggested')) break;
      const hint = stepHint(workbook, engine, node.ref);
      if (hint) findings.push(hint);
    }
    if (analysis.earliest.length === 0) {
      findings.push({
        level: 'suggested',
        text: 'No individual cell on the dependency path moved against the rule beyond the tolerance; compare the formulas listed in the table to see how the change accumulates.',
      });
    }
    if (path.truncated) {
      findings.push({ level: 'suggested', text: 'The dependency graph was large and was cut off; the path shown may be incomplete.' });
    }

    const flaggedRefs = nodes.filter((n) => analysis.flagged.has(refKey(n.ref))).map((n) => n.ref);
    const suspectRefs = analysis.suspects.map((x) => x.ref);
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      seed,
      runs: ['Lower input', 'Higher input'],
      cells,
      violation,
      expected:
        direction === 1
          ? `${outName} should not decrease when ${inName} increases.`
          : `${outName} should not increase when ${inName} increases.`,
      actual:
        outLow !== null && outHigh !== null
          ? `${outName} went from ${formatNumber(outLow)} to ${formatNumber(outHigh)}.`
          : `${outName} moved in the forbidden direction.`,
      difference: diff,
      findings,
      highlight: makeHighlight({
        inputs: [inputRef, ...rule.context.map((c) => c.cell)],
        outputs: [output],
        failing: [output, ...flaggedRefs],
        suspects: suspectRefs,
        related: pathRefs,
      }),
      scenario: toJson(s),
    };
  };

  const toJson = (s: PairScenario): ScenarioJson => ({ kind: 'pair', context: s.context, low: s.low, high: s.high });
  const fromJson = (json: ScenarioJson): PairScenario | null => {
    if (json.kind !== 'pair' || json.context.length !== context.length) return null;
    if (![json.low, json.high, ...json.context].every((v) => Number.isFinite(v))) return null;
    return { context: json.context, low: json.low, high: json.high };
  };

  return {
    arbitrary,
    evaluate,
    explain,
    toJson,
    fromJson,
    trackedCells: () => [rule.input.cell, ...rule.context.map((c) => c.cell), output],
  };
}
