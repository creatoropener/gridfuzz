import sample from './freight-quote.json';
import { RuleSchema, DEFAULT_RUNS, DEFAULT_SEED, type Rule } from '../../schemas/rule';
import type { CellModel, SheetModel, WorkbookModel } from '../../types/workbook';
import { parseAddress } from '../workbook/a1';

interface SampleCell {
  a: string;
  v?: string | number;
  f?: string;
}

export const SAMPLE_SHEET = sample.sheet;
export const SAMPLE_FAULTY_CELL = sample.faultyCell;
export const SAMPLE_FAULTY_FORMULA = sample.faultyFormula;
export const SAMPLE_FIXED_FORMULA = sample.fixedFormula;
export const SAMPLE_EXPLANATION = sample.explanation;
export const SAMPLE_FLAGSHIP_RULE_ID = 'fuel-surcharge-monotonic';
export const SAMPLE_WORKBOOK_ID = 'sample:freight-quote';

/** The built-in freight workbook. Built from the same JSON the downloadable .xlsx is generated from. */
export function buildFreightWorkbook(): WorkbookModel {
  const cells: Record<string, CellModel> = {};
  let rowCount = 0;
  let colCount = 0;
  for (const item of sample.cells as SampleCell[]) {
    const pos = parseAddress(item.a);
    if (!pos) throw new Error(`Invalid sample address ${item.a}`);
    cells[item.a] = {
      address: item.a,
      row: pos.row,
      col: pos.col,
      value: item.f ? null : (item.v ?? null),
      formula: item.f ?? null,
    };
    rowCount = Math.max(rowCount, pos.row + 1);
    colCount = Math.max(colCount, pos.col + 1);
  }
  const sheet: SheetModel = { name: sample.sheet, rowCount, colCount, cells };
  return {
    id: SAMPLE_WORKBOOK_ID,
    name: sample.name,
    sizeBytes: 0,
    source: 'sample',
    sheets: [sheet],
    warnings: [],
  };
}

const money = (address: string, label: string, min: number, max: number) => ({
  cell: { sheet: SAMPLE_SHEET, address },
  label,
  min,
  max,
  precision: 0,
  unit: 'USD',
});

/** Sample rules. Each passes the same `RuleSchema` as a rule a user builds. */
export function buildFreightRules(): Rule[] {
  const rules: unknown[] = [
    {
      id: SAMPLE_FLAGSHIP_RULE_ID,
      name: 'Raising fuel surcharge must never reduce final freight cost',
      description: 'Increasing fuel surcharge must never reduce final freight cost.',
      type: 'monotonic_increasing',
      sheet: SAMPLE_SHEET,
      tolerance: 0.005,
      source: 'sample',
      input: money('B6', 'Fuel surcharge', 0, 2000),
      context: [
        money('B5', 'Base ocean freight', 1000, 4000),
        money('B7', 'Drayage', 0, 800),
        money('B8', 'Handling charges', 0, 400),
        money('B9', 'Other charges', 0, 300),
      ],
      output: { sheet: SAMPLE_SHEET, address: 'B14' },
    },
    {
      id: 'final-cost-non-negative',
      name: 'Final freight cost must never be negative',
      description: 'Final freight cost must never be negative.',
      type: 'non_negative',
      sheet: SAMPLE_SHEET,
      tolerance: 0,
      source: 'sample',
      inputs: [
        money('B5', 'Base ocean freight', 0, 4000),
        money('B6', 'Fuel surcharge', 0, 2000),
        money('B7', 'Drayage', 0, 800),
      ],
      outputs: [{ sheet: SAMPLE_SHEET, address: 'B14' }],
    },
    {
      id: 'final-cost-reconciles',
      name: 'Final cost must equal subtotal − rebate + tax',
      description: 'Final freight cost must equal the subtotal minus the volume rebate plus tax.',
      type: 'invariant',
      sheet: SAMPLE_SHEET,
      tolerance: 0.005,
      relativeTolerance: 0,
      source: 'sample',
      inputs: [
        money('B5', 'Base ocean freight', 1000, 4000),
        money('B6', 'Fuel surcharge', 0, 2000),
        money('B7', 'Drayage', 0, 800),
      ],
      left: 'B14',
      relation: '==',
      right: 'B10 - B11 + B13',
    },
    {
      id: 'rebate-capped',
      name: 'Volume rebate must not exceed 10% of subtotal',
      description: 'The volume rebate must never be more than 10% of the subtotal.',
      type: 'invariant',
      sheet: SAMPLE_SHEET,
      tolerance: 0.005,
      relativeTolerance: 0,
      source: 'sample',
      inputs: [
        money('B5', 'Base ocean freight', 1000, 4000),
        money('B6', 'Fuel surcharge', 0, 2000),
      ],
      left: 'B11',
      relation: '<=',
      right: 'B10 * 10%',
    },
  ];
  return rules.map((r) => RuleSchema.parse(r));
}

export { DEFAULT_RUNS, DEFAULT_SEED };
