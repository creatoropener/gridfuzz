/**
 * The only module that talks to SheetJS. Everything else works with the plain
 * `WorkbookModel`, so the SheetJS build can be swapped (for example for the newer
 * releases that SheetJS publishes outside npm) without touching the rest of the app.
 *
 * SheetJS parses files and formulas. It does NOT calculate formulas; HyperFormula does.
 */
import type { CellModel, CellScalar, Diagnostic, SheetModel } from '../../types/workbook';
import { toAddress } from './a1';

export interface ParsedWorkbook {
  sheets: SheetModel[];
  warnings: Diagnostic[];
}

export type SpreadsheetKind = 'xlsx' | 'csv';

const XLFN_PREFIX = /_xl(?:fn|ws)\./gi;

function normalizeFormula(raw: string): string {
  return `=${raw.replace(XLFN_PREFIX, '')}`;
}

export async function parseSpreadsheet(data: ArrayBuffer, kind: SpreadsheetKind): Promise<ParsedWorkbook> {
  // Loaded lazily: SheetJS is only needed once a file is opened or downloaded.
  const XLSX = await import('xlsx');
  const warnings: Diagnostic[] = [];

  const workbook =
    kind === 'csv'
      ? XLSX.read(new TextDecoder('utf-8').decode(data).replace(/^﻿/, ''), {
          type: 'string',
          cellFormula: true,
        })
      : XLSX.read(data, {
          type: 'array',
          cellFormula: true,
          cellDates: false,
          cellNF: false,
          cellText: false,
          bookVBA: false,
          // Required, not cosmetic: SheetJS 0.18.5 silently drops a formula cell that has no cached
          // value (files written by openpyxl, pandas and many generators) unless stubs are kept.
          // Empty stubs are skipped below.
          sheetStubs: true,
        });

  const sheets: SheetModel[] = [];
  for (const name of workbook.SheetNames) {
    const ws = workbook.Sheets[name];
    if (!ws) continue;
    const ref = ws['!ref'];
    const range = ref ? XLSX.utils.decode_range(ref) : null;
    const cells: Record<string, CellModel> = {};
    let rowCount = range ? range.e.r + 1 : 0;
    let colCount = range ? range.e.c + 1 : 0;

    for (const key of Object.keys(ws)) {
      if (key.startsWith('!')) continue;
      const raw = ws[key] as import('xlsx').CellObject | undefined;
      if (!raw) continue;
      const pos = XLSX.utils.decode_cell(key);
      const address = toAddress(pos.c, pos.r);
      const formula = typeof raw.f === 'string' && raw.f.length > 0 ? normalizeFormula(raw.f) : null;

      if (formula && raw.F) {
        warnings.push({
          level: 'warning',
          code: 'array_formula',
          sheet: name,
          address,
          message: `${name}!${address} is part of an array formula; it is calculated as an ordinary formula and may differ from Excel.`,
        });
      }
      if (formula && /\[\d+\]/.test(formula)) {
        warnings.push({
          level: 'warning',
          code: 'external_reference',
          sheet: name,
          address,
          message: `${name}!${address} refers to another workbook, which GridFuzz cannot read.`,
        });
      }

      const scalar = toScalar(raw);
      const cell: CellModel = {
        address,
        row: pos.r,
        col: pos.c,
        value: formula ? null : scalar,
        formula,
      };
      if (formula && scalar !== null) cell.cachedValue = scalar;
      if (cell.formula === null && cell.value === null) continue;
      cells[address] = cell;
      rowCount = Math.max(rowCount, pos.r + 1);
      colCount = Math.max(colCount, pos.c + 1);
    }

    sheets.push({ name, rowCount, colCount, cells });
  }

  if (kind === 'csv' && sheets.some((s) => Object.values(s.cells).some((c) => c.formula))) {
    warnings.push({
      level: 'info',
      code: 'csv_formulas',
      message: 'Cells starting with "=" in the CSV were treated as formulas.',
    });
  }

  return { sheets, warnings };
}

function toScalar(cell: import('xlsx').CellObject): CellScalar {
  switch (cell.t) {
    case 'n':
      return typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : null;
    case 's':
      return typeof cell.v === 'string' ? cell.v : cell.v === undefined ? null : String(cell.v);
    case 'b':
      return typeof cell.v === 'boolean' ? cell.v : null;
    case 'e':
      return typeof cell.w === 'string' ? cell.w : '#ERROR!';
    case 'd':
      return cell.v instanceof Date ? cell.v.toISOString() : null;
    default:
      return null;
  }
}

/**
 * Builds an .xlsx file from the in-memory model. `computed` supplies calculated values so the
 * file also reads correctly in viewers that do not recalculate; Excel recalculates on open.
 */
export async function buildXlsx(
  sheets: readonly SheetModel[],
  computed?: (sheet: string, address: string) => CellScalar | undefined,
): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws: import('xlsx').WorkSheet = {};
    for (const cell of Object.values(sheet.cells)) {
      const value = cell.formula ? computed?.(sheet.name, cell.address) ?? null : cell.value;
      const out: import('xlsx').CellObject = { t: 'z' };
      if (typeof value === 'number') {
        out.t = 'n';
        out.v = value;
      } else if (typeof value === 'boolean') {
        out.t = 'b';
        out.v = value;
      } else if (typeof value === 'string') {
        out.t = 's';
        out.v = value;
      } else if (cell.formula) {
        out.t = 'n';
      }
      if (cell.formula) out.f = cell.formula.slice(1);
      ws[cell.address] = out;
    }
    const lastRow = Math.max(sheet.rowCount, 1) - 1;
    const lastCol = Math.max(sheet.colCount, 1) - 1;
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } });
    XLSX.utils.book_append_sheet(book, ws, sheet.name.slice(0, 31));
  }
  const out = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(out);
}
