/** A literal spreadsheet value. Errors are never stored as literals; they only exist as calculation results. */
export type CellScalar = number | string | boolean | null;

export interface CellRefModel {
  sheet: string;
  /** A1-style address of a single cell, upper-case, no `$` markers (e.g. `B5`). */
  address: string;
}

export interface CellModel {
  address: string;
  /** 0-based row index. */
  row: number;
  /** 0-based column index. */
  col: number;
  /** Literal value. `null` for formula cells and empty cells. */
  value: CellScalar;
  /** Formula text including the leading `=`, or `null` for literal cells. */
  formula: string | null;
  /**
   * The value stored in the file next to a formula. Informational only:
   * GridFuzz never uses it for calculation or testing.
   */
  cachedValue?: CellScalar;
}

export interface SheetModel {
  name: string;
  rowCount: number;
  colCount: number;
  /** Sparse map keyed by A1 address. */
  cells: Record<string, CellModel>;
}

export type DiagnosticLevel = 'error' | 'warning' | 'info';

export type DiagnosticCode =
  | 'unsupported_function'
  | 'volatile_function'
  | 'calc_error'
  | 'array_formula'
  | 'external_reference'
  | 'csv_formulas'
  | 'multiple_sheets_ignored';

export interface Diagnostic {
  level: DiagnosticLevel;
  code: DiagnosticCode;
  message: string;
  sheet?: string;
  address?: string;
}

export interface WorkbookModel {
  /** Stable identity used for persistence: `<source>:<name>:<size>`. */
  id: string;
  name: string;
  sizeBytes: number;
  source: 'upload' | 'sample';
  sheets: SheetModel[];
  /** Problems found while importing the file. */
  warnings: Diagnostic[];
}

/** A user edit to the working copy. `content` is exactly what the user typed (`=...` for formulas). */
export interface CellEdit {
  sheet: string;
  address: string;
  content: string;
}
