import type { Rule } from '../src/schemas/rule';
import { RuleSchema } from '../src/schemas/rule';
import { parseAddress } from '../src/engine/workbook/a1';
import type { CellModel, WorkbookModel } from '../src/types/workbook';

/** Builds a one-sheet workbook model from `[address, content]` pairs; `=...` strings are formulas. */
export function makeWorkbook(cells: Array<[string, string | number | boolean]>, sheet = 'S'): WorkbookModel {
  const map: Record<string, CellModel> = {};
  let rows = 0;
  let cols = 0;
  for (const [address, content] of cells) {
    const pos = parseAddress(address);
    if (!pos) throw new Error(`bad address ${address}`);
    const formula = typeof content === 'string' && content.startsWith('=') ? content : null;
    map[address] = { address, row: pos.row, col: pos.col, value: formula ? null : content, formula };
    rows = Math.max(rows, pos.row + 1);
    cols = Math.max(cols, pos.col + 1);
  }
  return {
    id: `test:${sheet}`,
    name: 'test.xlsx',
    sizeBytes: 0,
    source: 'upload',
    sheets: [{ name: sheet, rowCount: rows, colCount: cols, cells: map }],
    warnings: [],
  };
}

export function input(address: string, min: number, max: number, precision = 0, sheet = 'S') {
  return { cell: { sheet, address }, min, max, precision };
}

/** Validates a loosely-typed rule through the real schema (so tests can never build an invalid rule by accident). */
export function rule(candidate: Record<string, unknown>): Rule {
  return RuleSchema.parse({
    id: 'test-rule',
    name: 'Test rule',
    description: 'test',
    sheet: 'S',
    tolerance: 0,
    relativeTolerance: 0,
    source: 'manual',
    ...candidate,
  });
}
