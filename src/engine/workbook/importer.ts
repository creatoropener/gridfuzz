import type { WorkbookModel } from '../../types/workbook';
import { countCells } from './model';
import { parseSpreadsheet, type SpreadsheetKind } from './sheetjsAdapter';

/** Upload limits. Workbooks are processed in the browser, so they must stay small enough to be responsive. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_CELLS = 200_000;
/** Upper bound on rows × columns across all sheets (the calculation engine allocates a dense grid). */
export const MAX_GRID_AREA = 2_000_000;
export const SUPPORTED_EXTENSIONS = ['.xlsx', '.csv'] as const;

export type ImportErrorCode =
  | 'unsupported_type'
  | 'too_large'
  | 'empty'
  | 'corrupt'
  | 'too_many_cells';

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export function detectKind(fileName: string): SpreadsheetKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}

/**
 * Cheap checks before any parsing: extension, size and file signature.
 * `head` is the first bytes of the file (at least 4 are used).
 */
export function validateUpload(name: string, size: number, head: Uint8Array): SpreadsheetKind {
  const kind = detectKind(name);
  if (!kind) {
    throw new ImportError(
      'unsupported_type',
      `“${name}” is not supported. GridFuzz opens .xlsx and .csv files.`,
    );
  }
  if (size === 0) throw new ImportError('empty', `“${name}” is empty.`);
  if (size > MAX_UPLOAD_BYTES) {
    throw new ImportError(
      'too_large',
      `“${name}” is ${(size / (1024 * 1024)).toFixed(1)} MB. The limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`,
    );
  }
  if (kind === 'xlsx') {
    // .xlsx is a ZIP container: it must start with "PK\x03\x04".
    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    if (!isZip) {
      throw new ImportError(
        'corrupt',
        `“${name}” does not look like a real .xlsx file (it is not a valid ZIP container).`,
      );
    }
  } else {
    const sample = head.subarray(0, Math.min(head.length, 4096));
    if (sample.includes(0)) {
      throw new ImportError('corrupt', `“${name}” contains binary data and cannot be read as CSV.`);
    }
  }
  return kind;
}

export async function importWorkbook(name: string, data: ArrayBuffer): Promise<WorkbookModel> {
  const kind = validateUpload(name, data.byteLength, new Uint8Array(data.slice(0, 4096)));
  let parsed;
  try {
    parsed = await parseSpreadsheet(data, kind);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new ImportError('corrupt', `“${name}” could not be read: ${reason}`);
  }
  if (parsed.sheets.length === 0) {
    throw new ImportError('empty', `“${name}” does not contain any sheets.`);
  }

  const workbook: WorkbookModel = {
    id: `upload:${name}:${data.byteLength}`,
    name,
    sizeBytes: data.byteLength,
    source: 'upload',
    sheets: parsed.sheets,
    warnings: parsed.warnings,
  };

  const area = workbook.sheets.reduce((sum, s) => sum + s.rowCount * s.colCount, 0);
  if (countCells(workbook) > MAX_CELLS || area > MAX_GRID_AREA) {
    throw new ImportError(
      'too_many_cells',
      `“${name}” is too large to test in the browser (limit: ${MAX_CELLS.toLocaleString('en-US')} filled cells).`,
    );
  }
  return workbook;
}
