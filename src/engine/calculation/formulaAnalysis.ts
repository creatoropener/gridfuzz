import type { Diagnostic, WorkbookModel } from '../../types/workbook';
import { CalcEngine, isCalcError } from './CalcEngine';

let registered: Set<string> | null = null;

function registeredFunctions(): Set<string> {
  if (!registered) registered = new Set(CalcEngine.registeredFunctionNames());
  return registered;
}

/** Functions whose result can change between evaluations; tests on them are not reproducible. */
export const VOLATILE_FUNCTIONS: ReadonlySet<string> = new Set([
  'RAND',
  'RANDBETWEEN',
  'NOW',
  'TODAY',
  'OFFSET',
  'INDIRECT',
]);

/** Functions that can make a result jump when a condition flips; used for "suggested cause" hints. */
export const STEP_LIKE_FUNCTIONS: ReadonlySet<string> = new Set([
  'IF',
  'IFS',
  'SWITCH',
  'CHOOSE',
  'VLOOKUP',
  'HLOOKUP',
  'LOOKUP',
  'XLOOKUP',
  'MATCH',
  'INDEX',
  'MIN',
  'MAX',
  'ROUND',
  'ROUNDUP',
  'ROUNDDOWN',
  'CEILING',
  'FLOOR',
  'INT',
  'MOD',
]);

const QUOTED_SHEET = /'(?:[^']|'')*'/g;
const STRING_LITERAL = /"(?:[^"]|"")*"/g;
const FUNCTION_CALL = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g;

/** Upper-case names of every function called in a formula (string literals and sheet names ignored). */
export function extractFunctionNames(formula: string): string[] {
  const stripped = formula.replace(QUOTED_SHEET, "''").replace(STRING_LITERAL, '""');
  const names = new Set<string>();
  for (const match of stripped.matchAll(FUNCTION_CALL)) {
    const raw = match[1] ?? '';
    names.add(raw.toUpperCase().replace(/^_XL(?:FN|WS)\./, ''));
  }
  return [...names];
}

export function isFunctionSupported(name: string): boolean {
  return registeredFunctions().has(name.toUpperCase());
}

const MAX_LISTED = 6;

function listCells(cells: string[]): string {
  const shown = cells.slice(0, MAX_LISTED).join(', ');
  return cells.length > MAX_LISTED ? `${shown} and ${cells.length - MAX_LISTED} more` : shown;
}

/**
 * Static and baseline checks, reported honestly:
 *  - functions the calculation engine does not implement,
 *  - volatile functions (non-reproducible),
 *  - formula cells that evaluate to an error in the working copy as it stands.
 * Calculated values come from the engine; cached values stored in the file are never used.
 */
export function analyzeWorkbook(workbook: WorkbookModel, engine: CalcEngine): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const unsupported = new Map<string, string[]>();
  const volatile = new Map<string, string[]>();
  const errors: Array<{ sheet: string; address: string; display: string; message: string }> = [];

  for (const sheet of workbook.sheets) {
    for (const cell of Object.values(sheet.cells)) {
      if (!cell.formula) continue;
      const where = `${sheet.name}!${cell.address}`;
      for (const fn of extractFunctionNames(cell.formula)) {
        if (VOLATILE_FUNCTIONS.has(fn)) volatile.set(fn, [...(volatile.get(fn) ?? []), where]);
        if (!isFunctionSupported(fn)) unsupported.set(fn, [...(unsupported.get(fn) ?? []), where]);
      }
      const value = engine.getValue(sheet.name, cell.address);
      if (isCalcError(value)) {
        errors.push({ sheet: sheet.name, address: cell.address, display: value.display, message: value.message });
      }
    }
  }

  for (const [fn, cells] of unsupported) {
    diagnostics.push({
      level: 'warning',
      code: 'unsupported_function',
      message: `${fn}() is not supported by the calculation engine (used in ${listCells(cells)}). Those cells evaluate to #NAME?, and rules that depend on them are reported as inconclusive, never as passed.`,
    });
  }
  for (const [fn, cells] of volatile) {
    diagnostics.push({
      level: 'warning',
      code: 'volatile_function',
      message: `${fn}() is volatile (used in ${listCells(cells)}); its result can change between evaluations, so tests that depend on it may not be reproducible.`,
    });
  }
  const namedUnsupported = new Set([...unsupported.values()].flat());
  const shown = errors.filter((e) => !namedUnsupported.has(`${e.sheet}!${e.address}`));
  for (const e of shown.slice(0, 20)) {
    diagnostics.push({
      level: 'error',
      code: 'calc_error',
      sheet: e.sheet,
      address: e.address,
      message: `${e.sheet}!${e.address} evaluates to ${e.display}${e.message ? ` (${e.message})` : ''} in the current working copy.`,
    });
  }
  if (shown.length > 20) {
    diagnostics.push({
      level: 'error',
      code: 'calc_error',
      message: `${shown.length - 20} more cells evaluate to errors.`,
    });
  }
  return diagnostics;
}
