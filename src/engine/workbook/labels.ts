import type { CellRefModel, WorkbookModel } from '../../types/workbook';
import { parseAddress, toAddress } from './a1';
import { findSheet } from './model';

/**
 * Best-effort human label for a cell: the nearest text cell to its left on the same row,
 * otherwise the nearest text cell above it in the same column. Returns `null` when none exists.
 * Labels are display aids only; nothing in the testing engine depends on them.
 */
export function inferLabel(workbook: WorkbookModel, ref: CellRefModel): string | null {
  const sheet = findSheet(workbook, ref.sheet);
  const pos = parseAddress(ref.address);
  if (!sheet || !pos) return null;

  for (let col = pos.col - 1; col >= 0; col--) {
    const cell = sheet.cells[toAddress(col, pos.row)];
    if (cell && cell.formula === null && typeof cell.value === 'string' && cell.value.trim() !== '') {
      return cell.value.trim();
    }
  }
  for (let row = pos.row - 1; row >= 0; row--) {
    const cell = sheet.cells[toAddress(pos.col, row)];
    if (cell && cell.formula === null && typeof cell.value === 'string' && cell.value.trim() !== '') {
      return cell.value.trim();
    }
  }
  return null;
}

/** `Fuel surcharge (USD) · B5`, or just the address when no label exists. */
export function describeCell(workbook: WorkbookModel, ref: CellRefModel): string {
  const label = inferLabel(workbook, ref);
  return label ? `${label} (${ref.address})` : ref.address;
}
