import type { CellModel, CellRefModel, CellScalar, SheetModel, WorkbookModel } from '../../types/workbook';
import { parseAddress } from './a1';

export function findSheet(workbook: WorkbookModel, name: string): SheetModel | undefined {
  return workbook.sheets.find((sheet) => sheet.name === name);
}

export function getCell(workbook: WorkbookModel, ref: CellRefModel): CellModel | undefined {
  return findSheet(workbook, ref.sheet)?.cells[ref.address];
}

/** What a cell holds as engine content: the formula when there is one, otherwise the literal. */
export function cellContent(cell: CellModel | undefined): string | number | boolean | null {
  if (!cell) return null;
  return cell.formula ?? cell.value;
}

export function isNumber(value: CellScalar): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True when the address lies inside the sheet's used range. */
export function isInsideSheet(sheet: SheetModel, address: string): boolean {
  const pos = parseAddress(address);
  return pos !== null && pos.row < sheet.rowCount && pos.col < sheet.colCount;
}

export function countCells(workbook: WorkbookModel): number {
  return workbook.sheets.reduce((sum, sheet) => sum + Object.keys(sheet.cells).length, 0);
}

export function countFormulas(workbook: WorkbookModel): number {
  let n = 0;
  for (const sheet of workbook.sheets) {
    for (const cell of Object.values(sheet.cells)) if (cell.formula) n++;
  }
  return n;
}
