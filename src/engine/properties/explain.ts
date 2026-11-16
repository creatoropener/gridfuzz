import type {
  CellRole,
  CounterexampleCell,
  Finding,
  HighlightSet,
  ScalarJson,
} from '../../types/testing';
import type { CellRefModel, WorkbookModel } from '../../types/workbook';
import { formatNumber } from '../../utils/format';
import type { CalcEngine, CalcValue } from '../calculation/CalcEngine';
import { STEP_LIKE_FUNCTIONS, extractFunctionNames } from '../calculation/formulaAnalysis';
import { refKey } from '../calculation/graph';
import { inferLabel } from '../workbook/labels';
import { scalarJson } from './shared';

export interface TrackedCell {
  ref: CellRefModel;
  role: CellRole;
}

export function readAll(engine: CalcEngine, refs: readonly CellRefModel[]): CalcValue[] {
  return refs.map((r) => engine.getValue(r.sheet, r.address));
}

export function nameOf(workbook: WorkbookModel, ref: CellRefModel): string {
  const label = inferLabel(workbook, ref);
  return label ? `${label} (${ref.address})` : ref.address;
}

/**
 * Turns raw snapshots into counterexample rows. `baseline` is the state before the scenario;
 * `runs[r][i]` is the value of tracked cell `i` in run `r`.
 */
export function buildCells(args: {
  workbook: WorkbookModel;
  engine: CalcEngine;
  tracked: readonly TrackedCell[];
  baseline: readonly CalcValue[];
  runs: ReadonlyArray<readonly CalcValue[]>;
  flagged?: ReadonlySet<string>;
}): CounterexampleCell[] {
  const { workbook, engine, tracked, baseline, runs, flagged } = args;
  return tracked.map((t, i) => {
    const values: ScalarJson[] = runs.map((run) => scalarJson(run[i] ?? null));
    const first = values[0];
    const last = values[values.length - 1];
    const delta = typeof first === 'number' && typeof last === 'number' && values.length > 1 ? last - first : null;
    return {
      cell: t.ref,
      label: inferLabel(workbook, t.ref),
      role: t.role,
      formula: engine.getFormula(t.ref.sheet, t.ref.address),
      original: scalarJson(baseline[i] ?? null),
      values,
      delta,
      movedAgainstRule: flagged?.has(refKey(t.ref)) ?? false,
    };
  });
}

function dedupe(refs: readonly CellRefModel[]): CellRefModel[] {
  const seen = new Set<string>();
  const out: CellRefModel[] = [];
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export function makeHighlight(parts: {
  inputs: readonly CellRefModel[];
  outputs: readonly CellRefModel[];
  failing: readonly CellRefModel[];
  suspects: readonly CellRefModel[];
  related: readonly CellRefModel[];
}): HighlightSet {
  const taken = new Set<string>();
  const unique = (refs: readonly CellRefModel[]): CellRefModel[] =>
    dedupe(refs).filter((r) => {
      const k = refKey(r);
      if (taken.has(k)) return false;
      taken.add(k);
      return true;
    });
  // Priority order decides which colour a cell gets when it plays several roles.
  const failing = unique(parts.failing);
  const suspects = unique(parts.suspects);
  const inputs = unique(parts.inputs);
  const outputs = unique(parts.outputs);
  const related = unique(parts.related);
  return { inputs, outputs, failing, suspects, related };
}

/** A "suggested" hint about a suspect formula, based only on what the formula text contains. */
export function stepHint(workbook: WorkbookModel, engine: CalcEngine, ref: CellRefModel): Finding | null {
  const formula = engine.getFormula(ref.sheet, ref.address);
  if (!formula) return null;
  const found = extractFunctionNames(formula).filter((fn) => STEP_LIKE_FUNCTIONS.has(fn));
  if (found.length === 0) return null;
  return {
    level: 'suggested',
    text: `${nameOf(workbook, ref)} uses ${found.map((f) => `${f}()`).join(', ')} (${formula}). Functions like this can make a result jump when a condition flips or a threshold is crossed; check how ${ref.address} behaves around that point. This is a pointer, not a confirmed root cause.`,
  };
}

export function fmt(value: ScalarJson): string {
  if (typeof value === 'number') return formatNumber(value);
  if (value === null) return '(empty)';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return value;
}
