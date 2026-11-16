import { RuleSchema, ruleInputs, type Rule } from '../schemas/rule';
import type { ScenarioJson } from '../types/testing';
import type { CellRefModel, WorkbookModel } from '../types/workbook';
import { CalcEngine, type CalcValue } from './calculation/CalcEngine';

export interface Assignment {
  ref: CellRefModel;
  value: number;
}

/**
 * The input values of one run of a scenario. For a before/after pair, run 0 is the lower value of
 * the swept input and run 1 the higher one; other scenarios have a single run.
 */
export function scenarioAssignments(rule: Rule, scenario: ScenarioJson, run: number): Assignment[] | null {
  const specs = ruleInputs(rule);
  if (scenario.kind === 'pair') {
    if (scenario.context.length !== specs.length - 1) return null;
    const values = [run === 0 ? scenario.low : scenario.high, ...scenario.context];
    return specs.map((spec, i) => ({ ref: spec.cell, value: values[i] ?? 0 }));
  }
  if (scenario.values.length !== specs.length) return null;
  return specs.map((spec, i) => ({ ref: spec.cell, value: scenario.values[i] ?? 0 }));
}

/**
 * Calculated values of one sheet with a scenario's inputs applied, using a throw-away engine.
 * This is what "View Counterexample" shows in the grid; the working copy itself is untouched.
 */
export function sheetValuesForScenario(
  workbook: WorkbookModel,
  ruleInput: unknown,
  scenario: ScenarioJson,
  run: number,
  sheet: string,
): CalcValue[][] | null {
  const parsed = RuleSchema.safeParse(ruleInput);
  if (!parsed.success) return null;
  const assignments = scenarioAssignments(parsed.data, scenario, run);
  if (!assignments) return null;
  const engine = CalcEngine.fromWorkbook(workbook);
  try {
    engine.setMany(assignments.map((a) => ({ sheet: a.ref.sheet, address: a.ref.address, content: a.value })));
    return engine.getSheetValues(sheet);
  } finally {
    engine.destroy();
  }
}
