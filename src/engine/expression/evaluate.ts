import type { InconclusiveReason } from '../../types/testing';
import { isCalcError, type CalcValue } from '../calculation/CalcEngine';
import { expandRange, parseRange } from '../workbook/a1';
import type { Expr } from './parser';

export type NumericOutcome =
  | { ok: true; value: number }
  | { ok: false; reason: InconclusiveReason; message: string };

export interface EvalContext {
  /** Sheet used for references written without a sheet prefix. */
  defaultSheet: string;
  getValue(sheet: string, address: string): CalcValue;
}

/** Maps a HyperFormula error type to the reason a scenario is reported as inconclusive. */
export function reasonForErrorType(type: string): InconclusiveReason {
  switch (type) {
    case 'DIV_BY_ZERO':
      return 'division_by_zero';
    case 'CYCLE':
      return 'circular_reference';
    case 'REF':
      return 'invalid_reference';
    case 'NAME':
      return 'unsupported_function';
    default:
      return 'calc_error';
  }
}

class Inconclusive extends Error {
  readonly reason: InconclusiveReason;
  constructor(reason: InconclusiveReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Reads a cell as a number, or explains precisely why it cannot be used. */
export function readNumeric(ctx: EvalContext, sheet: string, address: string): NumericOutcome {
  const value = ctx.getValue(sheet, address);
  if (isCalcError(value)) {
    const detail = value.type === 'NAME' && value.message ? ` — ${value.message}` : '';
    return {
      ok: false,
      reason: reasonForErrorType(value.type),
      message: `${sheet}!${address} evaluates to ${value.display}${detail}`,
    };
  }
  if (value === null) {
    return { ok: false, reason: 'missing_value', message: `${sheet}!${address} is empty` };
  }
  if (typeof value !== 'number') {
    return {
      ok: false,
      reason: 'non_numeric',
      message: `${sheet}!${address} holds ${typeof value === 'boolean' ? 'a boolean' : 'text'}, not a number`,
    };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'non_finite_result', message: `${sheet}!${address} is not a finite number` };
  }
  return { ok: true, value };
}

function scalar(ctx: EvalContext, sheet: string | null, address: string): number {
  const outcome = readNumeric(ctx, sheet ?? ctx.defaultSheet, address);
  if (!outcome.ok) throw new Inconclusive(outcome.reason, outcome.message);
  return outcome.value;
}

/** Numbers inside a range. Empty and text cells are skipped (as in a spreadsheet); errors are not. */
function rangeNumbers(ctx: EvalContext, sheet: string | null, from: string, to: string): number[] {
  const range = parseRange(`${from}:${to}`);
  if (!range) throw new Inconclusive('invalid_reference', `${from}:${to} is not a valid range`);
  const sheetName = sheet ?? ctx.defaultSheet;
  const numbers: number[] = [];
  for (const address of expandRange(range, 50_000)) {
    const value = ctx.getValue(sheetName, address);
    if (isCalcError(value)) {
      throw new Inconclusive(reasonForErrorType(value.type), `${sheetName}!${address} evaluates to ${value.display}`);
    }
    if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}

function evaluate(expr: Expr, ctx: EvalContext): number {
  switch (expr.t) {
    case 'num':
      return expr.v;
    case 'ref':
      return scalar(ctx, expr.sheet, expr.address);
    case 'neg':
      return -evaluate(expr.e, ctx);
    case 'bin': {
      const l = evaluate(expr.l, ctx);
      const r = evaluate(expr.r, ctx);
      switch (expr.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          if (r === 0) throw new Inconclusive('division_by_zero', 'The rule expression divides by zero');
          return l / r;
        case '^':
          return l ** r;
      }
      break;
    }
    case 'range':
      throw new Inconclusive('invalid_reference', 'A range cannot be used as a single value');
    case 'call': {
      const values: number[] = [];
      for (const arg of expr.args) {
        if (arg.t === 'range') values.push(...rangeNumbers(ctx, arg.sheet, arg.from, arg.to));
        else values.push(evaluate(arg, ctx));
      }
      switch (expr.fn) {
        case 'SUM':
          return values.reduce((a, b) => a + b, 0);
        case 'MIN':
          return values.length ? Math.min(...values) : 0;
        case 'MAX':
          return values.length ? Math.max(...values) : 0;
        case 'AVERAGE':
          if (values.length === 0) throw new Inconclusive('division_by_zero', 'AVERAGE() of no numbers');
          return values.reduce((a, b) => a + b, 0) / values.length;
        case 'ABS':
          return Math.abs(values[0] ?? 0);
        case 'ROUND': {
          const digits = Math.trunc(values[1] ?? 0);
          const factor = 10 ** digits;
          return Math.round((values[0] ?? 0) * factor) / factor;
        }
      }
      break;
    }
  }
  throw new Inconclusive('engine_error', 'Unsupported expression node');
}

/** Evaluates an expression against the engine's current state. Never throws for spreadsheet problems. */
export function evaluateExpression(expr: Expr, ctx: EvalContext): NumericOutcome {
  try {
    const value = evaluate(expr, ctx);
    if (!Number.isFinite(value)) {
      return { ok: false, reason: 'non_finite_result', message: 'The rule expression produced a non-finite number' };
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Inconclusive) return { ok: false, reason: error.reason, message: error.message };
    throw error;
  }
}
