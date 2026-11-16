import type { CellRefModel, WorkbookModel } from '../../types/workbook';
import { CalcEngine } from '../calculation/CalcEngine';
import { buildPrecedentGraph, refKey } from '../calculation/graph';
import { inferLabel } from '../workbook/labels';
import type { InputDraft } from './types';

/** Rounds up to 1, 2 or 5 × 10^k (540 → 1000, 180 → 200, 35 → 50). */
export function niceCeil(n: number): number {
  if (!(n > 0)) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = 10 ** exp;
  const m = n / base;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return step * base;
}

function decimalsOf(n: number): number {
  const s = String(n);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : Math.min(s.length - dot - 1, 6);
}

export interface SuggestedRange {
  min: number;
  max: number;
  precision: number;
}

/**
 * A starting point for an input's range, based on its current value. This is a guess the user is
 * asked to review: GridFuzz cannot know what values are realistic for a business.
 */
export function suggestRange(value: number | null, label: string | null): SuggestedRange {
  if (value === null) return { min: 0, max: 1000, precision: 0 };
  const rateLike = value >= 0 && value <= 1 && (!Number.isInteger(value) || /rate|percent|%|discount|tax|margin/i.test(label ?? ''));
  if (rateLike) return { min: 0, max: 1, precision: 2 };
  if (Number.isInteger(value)) {
    const max = niceCeil(Math.max(Math.abs(value) * 3, 10));
    return { min: value < 0 ? -max : 0, max, precision: 0 };
  }
  const precision = Math.min(Math.max(decimalsOf(value), 1), 2);
  const max = niceCeil(Math.max(Math.abs(value) * 3, 10));
  return { min: value < 0 ? -max : 0, max, precision };
}

export function inputDraftFor(workbook: WorkbookModel, ref: CellRefModel, value: number | null): InputDraft {
  const label = inferLabel(workbook, ref);
  const range = suggestRange(value, label);
  return {
    sheet: ref.sheet,
    address: ref.address,
    label: label ?? '',
    min: String(range.min),
    max: String(range.max),
    precision: String(range.precision),
    unit: '',
  };
}

/**
 * Numeric literal cells (not formulas) that feed the given target cells, nearest first.
 * These are the natural candidates to vary when a sentence does not name its inputs.
 * Returns an empty list when the dependency graph cannot be built.
 */
export function suggestInputs(
  workbook: WorkbookModel,
  engine: CalcEngine,
  targets: readonly CellRefModel[],
  exclude: readonly CellRefModel[],
  cap = 6,
): InputDraft[] {
  const skip = new Set(exclude.map(refKey));
  const picked: CellRefModel[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    let graph;
    try {
      graph = buildPrecedentGraph(engine, target);
    } catch {
      continue;
    }
    for (const [key, ref] of graph.nodes) {
      if (seen.has(key) || skip.has(key)) continue;
      seen.add(key);
      const cell = workbook.sheets.find((s) => s.name === ref.sheet)?.cells[ref.address];
      if (cell && cell.formula === null && typeof cell.value === 'number') picked.push(ref);
    }
  }
  return picked.slice(0, cap).map((ref) => {
    const cell = workbook.sheets.find((s) => s.name === ref.sheet)?.cells[ref.address];
    return inputDraftFor(workbook, ref, typeof cell?.value === 'number' ? cell.value : null);
  });
}

export function numericValue(engine: CalcEngine, ref: CellRefModel): number | null {
  try {
    const v = engine.getValue(ref.sheet, ref.address);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
