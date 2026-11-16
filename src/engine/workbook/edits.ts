import type { CellEdit, CellModel, CellScalar, SheetModel, WorkbookModel } from '../../types/workbook';
import { hashString } from '../../utils/hash';
import { parseAddress } from './a1';
import { cellContent, findSheet } from './model';

export interface ParsedCellInput {
  formula: string | null;
  value: CellScalar;
}

const NUMBER_PATTERN = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?$/i;

/** Interprets what a user typed into a cell: formula, number, percentage, boolean, text or empty. */
export function parseCellInput(raw: string): ParsedCellInput {
  const text = raw.trim();
  if (text === '') return { formula: null, value: null };
  if (text.startsWith('=')) {
    return text.length > 1 ? { formula: text, value: null } : { formula: null, value: text };
  }
  const percent = /^([-+]?\d+(?:\.\d+)?)\s*%$/.exec(text);
  if (percent) return { formula: null, value: Number(percent[1]) / 100 };
  if (NUMBER_PATTERN.test(text) && /\d/.test(text)) {
    return { formula: null, value: Number(text.replace(/,/g, '')) };
  }
  if (/^true$/i.test(text)) return { formula: null, value: true };
  if (/^false$/i.test(text)) return { formula: null, value: false };
  return { formula: null, value: raw };
}

/** The text a cell should show in an editor: the formula, or the literal as typed. */
export function editableText(cell: CellModel | undefined): string {
  const content = cellContent(cell);
  if (content === null || content === undefined) return '';
  if (typeof content === 'boolean') return content ? 'TRUE' : 'FALSE';
  return String(content);
}

/**
 * Returns a new workbook with the edits applied. The input workbook is never mutated:
 * the original upload stays exactly as it was parsed.
 */
export function applyEdits(workbook: WorkbookModel, edits: readonly CellEdit[]): WorkbookModel {
  if (edits.length === 0) return workbook;
  const bySheet = new Map<string, CellEdit[]>();
  for (const edit of edits) {
    const list = bySheet.get(edit.sheet) ?? [];
    list.push(edit);
    bySheet.set(edit.sheet, list);
  }

  const sheets: SheetModel[] = workbook.sheets.map((sheet) => {
    const sheetEdits = bySheet.get(sheet.name);
    if (!sheetEdits) return sheet;
    const cells: Record<string, CellModel> = { ...sheet.cells };
    let rowCount = sheet.rowCount;
    let colCount = sheet.colCount;
    for (const edit of sheetEdits) {
      const pos = parseAddress(edit.address);
      if (!pos) continue;
      const parsed = parseCellInput(edit.content);
      const address = edit.address.toUpperCase();
      if (parsed.formula === null && parsed.value === null) {
        delete cells[address];
      } else {
        cells[address] = { address, row: pos.row, col: pos.col, value: parsed.value, formula: parsed.formula };
      }
      rowCount = Math.max(rowCount, pos.row + 1);
      colCount = Math.max(colCount, pos.col + 1);
    }
    return { ...sheet, cells, rowCount, colCount };
  });

  return { ...workbook, sheets };
}

/**
 * Adds, replaces or removes an edit. An edit that restores the original content is dropped,
 * so "edited" always means "different from the uploaded file".
 */
export function upsertEdit(
  workbook: WorkbookModel,
  edits: readonly CellEdit[],
  sheet: string,
  address: string,
  content: string,
): CellEdit[] {
  const rest = edits.filter((e) => !(e.sheet === sheet && e.address === address));
  const original = findSheet(workbook, sheet)?.cells[address];
  if (content.trim() === editableText(original).trim()) return rest;
  return [...rest, { sheet, address, content }];
}

/** Stable fingerprint of a set of edits; changes whenever the working copy changes. */
export function editsFingerprint(edits: readonly CellEdit[]): string {
  const sorted = [...edits].sort((a, b) =>
    a.sheet === b.sheet ? a.address.localeCompare(b.address) : a.sheet.localeCompare(b.sheet),
  );
  return hashString(JSON.stringify(sorted));
}
