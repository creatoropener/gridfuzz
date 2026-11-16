import { DetailedCellError, HyperFormula } from 'hyperformula';
import type { SimpleCellAddress } from 'hyperformula';
import type { CellRefModel, WorkbookModel } from '../../types/workbook';
import { expandRange, parseAddress, toAddress } from '../workbook/a1';

export type EngineContent = string | number | boolean | null;

/** A calculation error such as `#DIV/0!`. Plain data so it survives structured cloning and JSON. */
export interface CalcErrorValue {
  error: true;
  /** HyperFormula error type: `DIV_BY_ZERO`, `NAME`, `CYCLE`, `REF`, `VALUE`, `NUM`, `NA`, `ERROR`... */
  type: string;
  display: string;
  message: string;
}

export type CalcValue = number | string | boolean | null | CalcErrorValue;

export function isCalcError(value: CalcValue): value is CalcErrorValue {
  return typeof value === 'object' && value !== null && 'error' in value;
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

function convert(value: unknown): CalcValue {
  if (value instanceof DetailedCellError) {
    return { error: true, type: String(value.type), display: value.value, message: value.message };
  }
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  return String(value);
}

/**
 * A private HyperFormula instance built from a workbook model.
 *
 * Each instance owns its own calculation state. The `WorkbookModel` it was built from is
 * never modified, and nothing here touches the original uploaded file.
 */
export class CalcEngine {
  private readonly hf: HyperFormula;
  private readonly sheetIds = new Map<string, number>();

  private constructor(hf: HyperFormula, sheetNames: readonly string[]) {
    this.hf = hf;
    for (const name of sheetNames) {
      const id = hf.getSheetId(name);
      if (id !== undefined) this.sheetIds.set(name, id);
    }
  }

  static fromWorkbook(workbook: WorkbookModel): CalcEngine {
    const sheets: Record<string, EngineContent[][]> = {};
    for (const sheet of workbook.sheets) {
      const rows = Math.max(sheet.rowCount, 1);
      const cols = Math.max(sheet.colCount, 1);
      const data: EngineContent[][] = Array.from({ length: rows }, () =>
        new Array<EngineContent>(cols).fill(null),
      );
      for (const cell of Object.values(sheet.cells)) {
        const row = data[cell.row];
        if (row) row[cell.col] = cell.formula ?? cell.value;
      }
      sheets[sheet.name] = data;
    }
    try {
      // GPL-3.0 licence key: GridFuzz is GPL-3.0 licensed, which is what HyperFormula's GPLv3 option requires.
      const hf = HyperFormula.buildFromSheets(sheets, { licenseKey: 'gpl-v3' });
      return new CalcEngine(hf, workbook.sheets.map((s) => s.name));
    } catch (error) {
      throw new EngineError(
        `Could not build the calculation engine: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  static get hyperFormulaVersion(): string {
    return HyperFormula.version;
  }

  static registeredFunctionNames(): string[] {
    return HyperFormula.getRegisteredFunctionNames('enGB');
  }

  hasSheet(name: string): boolean {
    return this.sheetIds.has(name);
  }

  private resolve(sheet: string, address: string): SimpleCellAddress {
    const sheetId = this.sheetIds.get(sheet);
    if (sheetId === undefined) throw new EngineError(`Unknown sheet "${sheet}".`);
    const pos = parseAddress(address);
    if (!pos) throw new EngineError(`Invalid cell address "${address}".`);
    return { sheet: sheetId, col: pos.col, row: pos.row };
  }

  getValue(sheet: string, address: string): CalcValue {
    return convert(this.hf.getCellValue(this.resolve(sheet, address)));
  }

  getFormula(sheet: string, address: string): string | null {
    return this.hf.getCellFormula(this.resolve(sheet, address)) ?? null;
  }

  /** The cell's content as the engine stores it: `=formula` text or the literal value. */
  getContent(sheet: string, address: string): EngineContent {
    const content = this.hf.getCellSerialized(this.resolve(sheet, address));
    if (content === undefined || content === null) return null;
    if (typeof content === 'number' || typeof content === 'string' || typeof content === 'boolean') return content;
    return String(content);
  }

  setContent(sheet: string, address: string, content: EngineContent): void {
    this.hf.setCellContents(this.resolve(sheet, address), content);
  }

  /** Sets several cells with a single recalculation. */
  setMany(items: ReadonlyArray<{ sheet: string; address: string; content: EngineContent }>): void {
    if (items.length === 0) return;
    this.hf.batch(() => {
      for (const item of items) this.hf.setCellContents(this.resolve(item.sheet, item.address), item.content);
    });
  }

  /** Calculated values for a whole sheet, as a dense grid. */
  getSheetValues(sheet: string): CalcValue[][] {
    const id = this.sheetIds.get(sheet);
    if (id === undefined) throw new EngineError(`Unknown sheet "${sheet}".`);
    return this.hf.getSheetValues(id).map((row) => row.map(convert));
  }

  /**
   * Direct precedents (cells this cell's formula reads), with ranges expanded to single cells.
   * Expansion stops at `cap` cells per call so a huge range cannot blow up the graph.
   */
  getPrecedents(sheet: string, address: string, cap = 2_000): CellRefModel[] {
    const out: CellRefModel[] = [];
    const seen = new Set<string>();
    const push = (sheetName: string, a: string): void => {
      const key = `${sheetName}!${a}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ sheet: sheetName, address: a });
    };
    for (const item of this.hf.getCellPrecedents(this.resolve(sheet, address))) {
      if ('start' in item) {
        const sheetName = this.hf.getSheetName(item.start.sheet);
        if (sheetName === undefined) continue;
        const addresses = expandRange(
          { from: { col: item.start.col, row: item.start.row }, to: { col: item.end.col, row: item.end.row } },
          Math.max(cap - out.length, 0),
        );
        for (const a of addresses) push(sheetName, a);
      } else {
        const sheetName = this.hf.getSheetName(item.sheet);
        if (sheetName === undefined) continue;
        push(sheetName, toAddress(item.col, item.row));
      }
      if (out.length >= cap) break;
    }
    return out;
  }

  /**
   * Cells whose formulas read the given cell, directly or through a range such as `SUM(B5:B9)`.
   * HyperFormula reports a range read as a range vertex; the cells *inside* that range are not
   * dependents, so such a vertex is resolved to the formulas that read the range instead.
   */
  getDependents(sheet: string, address: string, cap = 2_000): CellRefModel[] {
    const out: CellRefModel[] = [];
    const seen = new Set<string>();
    const queue: Parameters<HyperFormula['getCellDependents']>[0][] = [this.resolve(sheet, address)];
    for (let guard = 0; queue.length > 0 && guard < 10_000 && out.length < cap; guard++) {
      const next = queue.shift()!;
      for (const item of this.hf.getCellDependents(next)) {
        if ('start' in item) {
          const key = `r${item.start.sheet}:${item.start.col},${item.start.row}:${item.end.col},${item.end.row}`;
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push(item);
          continue;
        }
        const sheetName = this.hf.getSheetName(item.sheet);
        if (sheetName === undefined) continue;
        const key = `c${item.sheet}:${item.col},${item.row}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ sheet: sheetName, address: toAddress(item.col, item.row) });
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  destroy(): void {
    this.hf.destroy();
  }
}
