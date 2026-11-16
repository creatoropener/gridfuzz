import type { Arbitrary } from 'fast-check';
import type { Counterexample, InconclusiveReason, ScalarJson, ScenarioJson, Verdict } from '../../types/testing';
import type { CellRefModel, WorkbookModel } from '../../types/workbook';
import type { ComparisonOp, InputSpec } from '../../schemas/rule';
import { isCalcError, type CalcEngine, type CalcValue, type EngineContent } from '../calculation/CalcEngine';
import type { EvalContext, NumericOutcome } from '../expression/evaluate';

export interface PropertyContext {
  /** A private engine instance. The property restores its inputs after every scenario. */
  engine: CalcEngine;
  /** The (working-copy) workbook the engine was built from. Used for labels only. */
  workbook: WorkbookModel;
}

/**
 * What a rule type contributes to the runner. `S` is the scenario shape fast-check generates and
 * shrinks. Everything else about running, counting and shrinking is shared (see `runner.ts`).
 */
export interface PropertyDefinition<S> {
  arbitrary: Arbitrary<S>;
  /** Applies the scenario, evaluates the property, then restores every input it touched. */
  evaluate(scenario: S): Verdict;
  /** Re-evaluates a failing scenario and records everything needed to explain it. */
  explain(scenario: S, seed: number): Counterexample;
  toJson(scenario: S): ScenarioJson;
  fromJson(json: ScenarioJson): S | null;
  /** Cells whose values must be identical before and after a run (proves scenarios do not leak). */
  trackedCells(): CellRefModel[];
}

export interface InputBinding {
  spec: InputSpec;
  /** What the cell held before testing: a formula (`=...`) or a literal. Restored after each scenario. */
  baselineContent: EngineContent;
  baselineValue: number | null;
}

export function bindInput(engine: CalcEngine, spec: InputSpec): InputBinding {
  const { sheet, address } = spec.cell;
  const value = engine.getValue(sheet, address);
  return {
    spec,
    baselineContent: engine.getContent(sheet, address),
    baselineValue: typeof value === 'number' && Number.isFinite(value) ? value : null,
  };
}

export function applyInputs(engine: CalcEngine, bindings: readonly InputBinding[], values: readonly number[]): void {
  engine.setMany(
    bindings.map((b, i) => ({
      sheet: b.spec.cell.sheet,
      address: b.spec.cell.address,
      content: values[i] ?? null,
    })),
  );
}

export function restoreInputs(engine: CalcEngine, bindings: readonly InputBinding[]): void {
  engine.setMany(
    bindings.map((b) => ({ sheet: b.spec.cell.sheet, address: b.spec.cell.address, content: b.baselineContent })),
  );
}

export const PASS: Verdict = { kind: 'pass' };
export const FAIL: Verdict = { kind: 'fail' };

export function inconclusive(outcome: Extract<NumericOutcome, { ok: false }>): Verdict {
  return { kind: 'inconclusive', reason: outcome.reason, message: outcome.message };
}

export function inconclusiveBecause(reason: InconclusiveReason, message: string): Verdict {
  return { kind: 'inconclusive', reason, message };
}

export function makeEvalContext(engine: CalcEngine, defaultSheet: string): EvalContext {
  return { defaultSheet, getValue: (sheet, address) => engine.getValue(sheet, address) };
}

export function scalarJson(value: CalcValue): ScalarJson {
  return isCalcError(value) ? value.display : value;
}

export function sameRef(a: CellRefModel, b: CellRefModel): boolean {
  return a.sheet === b.sheet && a.address === b.address;
}

/** Comparison with a tolerance on the inclusive/equality operators; strict operators are exact. */
export function compare(op: ComparisonOp, a: number, b: number, tolerance: number): boolean {
  switch (op) {
    case '>':
      return a > b;
    case '>=':
      return a >= b - tolerance;
    case '<':
      return a < b;
    case '<=':
      return a <= b + tolerance;
    case '==':
      return Math.abs(a - b) <= tolerance;
    case '!=':
      return Math.abs(a - b) > tolerance;
  }
}

export function pointFromJson(json: ScenarioJson, expectedLength: number): number[] | null {
  if (json.kind !== 'point') return null;
  if (json.values.length !== expectedLength || !json.values.every((v) => Number.isFinite(v))) return null;
  return json.values;
}
