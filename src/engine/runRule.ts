import { RuleSchema, TestConfigSchema, formatIssues, ruleInputs, type Rule } from '../schemas/rule';
import type {
  Counterexample,
  RuleRunResult,
  RuleStatus,
  ScenarioJson,
  TestConfig,
  Verdict,
} from '../types/testing';
import type { CellRefModel, WorkbookModel } from '../types/workbook';
import { CalcEngine, EngineError } from './calculation/CalcEngine';
import { extractFunctionNames, isFunctionSupported, VOLATILE_FUNCTIONS } from './calculation/formulaAnalysis';
import { buildPrecedentGraph, refKey } from './calculation/graph';
import { FAST_CHECK_VERSION, createRunner, ruleReferences } from './properties';
import { isInsideSheet } from './workbook/model';
import { editsFingerprint } from './workbook/edits';
import type { CellEdit } from '../types/workbook';

export const DEFAULT_TIME_LIMIT_MS = 120_000;

export interface RunRuleOptions {
  timeLimitMs?: number;
  /** Fingerprint of the working copy (see `editsFingerprint`); stored on the result. */
  edits?: readonly CellEdit[];
  onProgress?: (executed: number, requested: number) => void;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

function emptyResult(rule: { id: string; name: string }, config: TestConfig, extra: Partial<RuleRunResult>): RuleRunResult {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    status: 'inconclusive',
    seed: config.seed,
    requestedRuns: config.numRuns,
    executed: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    inconclusiveReasons: {},
    inconclusiveSamples: {},
    failureRate: 0,
    durationMs: 0,
    interrupted: false,
    firstFailureAt: null,
    shrink: null,
    counterexample: null,
    warnings: [],
    errors: [],
    engine: { hyperformula: CalcEngine.hyperFormulaVersion, fastCheck: FAST_CHECK_VERSION },
    ranAt: new Date().toISOString(),
    workingCopy: '',
    ...extra,
  };
}

/** Problems that make the rule impossible to test against this workbook. */
export function checkRuleAgainstWorkbook(rule: Rule, workbook: WorkbookModel): string[] {
  const errors: string[] = [];
  const sheetOf = (name: string) => workbook.sheets.find((s) => s.name === name);
  if (!sheetOf(rule.sheet)) errors.push(`The rule's default sheet "${rule.sheet}" does not exist in this workbook.`);

  const refs = ruleReferencesSafe(rule, errors);
  for (const ref of refs.inputs) {
    const sheet = sheetOf(ref.sheet);
    if (!sheet) errors.push(`Input ${ref.sheet}!${ref.address}: sheet "${ref.sheet}" does not exist.`);
    else if (!isInsideSheet(sheet, ref.address)) {
      errors.push(`Input ${ref.sheet}!${ref.address} is outside the used range of the sheet.`);
    }
  }
  for (const ref of refs.outputs) {
    const sheet = sheetOf(ref.sheet);
    if (!sheet) {
      errors.push(`Output ${ref.sheet}!${ref.address}: sheet "${ref.sheet}" does not exist.`);
    } else if (!sheet.cells[ref.address]) {
      errors.push(`Output ${ref.sheet}!${ref.address} is empty, so there is nothing to test.`);
    }
  }
  for (const ref of refs.referenced) {
    if (!sheetOf(ref.sheet)) errors.push(`The rule refers to ${ref.sheet}!${ref.address}, but sheet "${ref.sheet}" does not exist.`);
  }
  return [...new Set(errors)];
}

function ruleReferencesSafe(rule: Rule, errors: string[]) {
  try {
    return ruleReferences(rule);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'The rule contains an invalid expression.');
    return { inputs: ruleInputs(rule).map((i) => i.cell), outputs: [], referenced: [] };
  }
}

/** Honest pre-flight notes: unsupported/volatile functions on the tested path, and vacuous rules. */
function staticWarnings(rule: Rule, workbook: WorkbookModel, engine: CalcEngine): string[] {
  const warnings: string[] = [];
  const refs = ruleReferences(rule);
  const targets: CellRefModel[] = [...refs.outputs, ...refs.referenced];
  const reachable = new Map<string, CellRefModel>();

  for (const target of targets) {
    try {
      const graph = buildPrecedentGraph(engine, target);
      for (const [key, ref] of graph.nodes) reachable.set(key, ref);
      if (graph.truncated) warnings.push(`The dependency graph of ${target.sheet}!${target.address} is very large and was cut off.`);
    } catch {
      warnings.push(`Could not read the dependencies of ${target.sheet}!${target.address}.`);
    }
  }

  const unsupported = new Map<string, string[]>();
  const volatile = new Map<string, string[]>();
  for (const ref of reachable.values()) {
    const cell = workbook.sheets.find((s) => s.name === ref.sheet)?.cells[ref.address];
    if (!cell?.formula) continue;
    for (const fn of extractFunctionNames(cell.formula)) {
      if (!isFunctionSupported(fn)) unsupported.set(fn, [...(unsupported.get(fn) ?? []), `${ref.sheet}!${ref.address}`]);
      if (VOLATILE_FUNCTIONS.has(fn)) volatile.set(fn, [...(volatile.get(fn) ?? []), `${ref.sheet}!${ref.address}`]);
    }
  }
  for (const [fn, cells] of unsupported) {
    warnings.push(
      `${fn}() is not supported by the calculation engine (used in ${cells.slice(0, 4).join(', ')}). Scenarios that reach it are reported as inconclusive, never as passed.`,
    );
  }
  for (const [fn, cells] of volatile) {
    warnings.push(`${fn}() is volatile (used in ${cells.slice(0, 4).join(', ')}); results may not be reproducible.`);
  }

  const inputKeys = refs.inputs.map(refKey);
  if (targets.length > 0 && !inputKeys.some((k) => reachable.has(k))) {
    warnings.push(
      'None of the mapped input cells feeds the cells being checked, so changing the inputs cannot change the result. Every scenario will trivially pass; check the cell mapping.',
    );
  } else if (rule.type === 'monotonic_increasing' || rule.type === 'monotonic_decreasing') {
    if (!reachable.has(refKey(rule.input.cell))) {
      warnings.push(
        `${rule.input.cell.address} does not feed ${rule.output.address}, so raising it cannot change the result. Every scenario will trivially pass; check the cell mapping.`,
      );
    }
  }
  for (const input of ruleInputs(rule)) {
    const cell = workbook.sheets.find((s) => s.name === input.cell.sheet)?.cells[input.cell.address];
    if (cell?.formula) {
      warnings.push(
        `${input.cell.address} contains a formula. During testing GridFuzz overwrites it with generated values and restores it afterwards.`,
      );
    }
  }
  return warnings;
}

function decideStatus(result: { failed: number; passed: number; executed: number }): RuleStatus {
  if (result.failed > 0) return 'failed';
  if (result.passed > 0) return 'passed';
  return 'inconclusive';
}

/**
 * Runs one business rule against a workbook using a private calculation engine.
 *
 * `workbook` must already be the working copy (edits applied). It is never modified: the engine
 * gets its own copy of the data, and every scenario restores the inputs it touched.
 */
export function runRule(
  workbook: WorkbookModel,
  ruleInput: unknown,
  configInput: unknown,
  options: RunRuleOptions = {},
): RuleRunResult {
  const now = options.now ?? Date.now;
  const started = now();
  const workingCopy = editsFingerprint(options.edits ?? []);

  const configParsed = TestConfigSchema.safeParse(configInput);
  const fallbackConfig: TestConfig = { numRuns: 0, seed: 0 };
  const ruleParsed = RuleSchema.safeParse(ruleInput);
  const looseRule = (ruleInput ?? {}) as { id?: unknown; name?: unknown };
  const label = {
    id: typeof looseRule.id === 'string' ? looseRule.id : 'unknown',
    name: typeof looseRule.name === 'string' ? looseRule.name : 'Unnamed rule',
  };

  if (!configParsed.success || !ruleParsed.success) {
    const errors = [
      ...(ruleParsed.success ? [] : formatIssues(ruleParsed.error)),
      ...(configParsed.success ? [] : formatIssues(configParsed.error)),
    ];
    return emptyResult(label, configParsed.success ? configParsed.data : fallbackConfig, {
      errors,
      workingCopy,
      durationMs: now() - started,
    });
  }

  const rule = ruleParsed.data;
  const config = configParsed.data;
  const base = (extra: Partial<RuleRunResult>): RuleRunResult =>
    emptyResult(rule, config, { workingCopy, ...extra });

  const preflight = checkRuleAgainstWorkbook(rule, workbook);
  if (preflight.length > 0) return base({ errors: preflight, durationMs: now() - started });

  let engine: CalcEngine;
  try {
    engine = CalcEngine.fromWorkbook(workbook);
  } catch (error) {
    const message = error instanceof EngineError ? error.message : 'The calculation engine failed to start.';
    return base({ errors: [message], durationMs: now() - started });
  }

  try {
    const warnings = staticWarnings(rule, workbook, engine);
    const runner = createRunner(rule, { engine, workbook });
    const before = runner.signature();

    const census = runner.census(config, {
      timeLimitMs: options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
      onProgress: (executed) => options.onProgress?.(executed, config.numRuns),
    });

    const errors: string[] = [];
    if (runner.signature() !== before) {
      errors.push(
        'Internal consistency check failed: the calculation state changed during testing. Results may be unreliable; please report this.',
      );
    }
    if (census.interrupted) {
      warnings.push(
        `The time limit stopped the run after ${census.executed.toLocaleString('en-US')} of ${config.numRuns.toLocaleString('en-US')} scenarios. Only executed scenarios are counted.`,
      );
    }

    let counterexample: Counterexample | null = null;
    let shrink: RuleRunResult['shrink'] = null;
    if (census.failed > 0) {
      const outcome = runner.shrink(config);
      if (outcome) {
        counterexample = outcome.counterexample;
        shrink = {
          steps: outcome.steps,
          evaluations: outcome.evaluations,
          originalFoundAt: outcome.originalFoundAt,
          originalScenario: outcome.originalScenario,
          reproducible: outcome.reproducible,
        };
      } else {
        counterexample = runner.explainFirstFailure(config.seed);
        warnings.push('Shrinking could not reproduce the failure, so the first failing scenario is shown unshrunk.');
      }
    }

    const durationMs = now() - started;
    return base({
      status: decideStatus(census),
      executed: census.executed,
      passed: census.passed,
      failed: census.failed,
      inconclusive: census.inconclusive,
      inconclusiveReasons: census.reasons,
      inconclusiveSamples: census.samples,
      failureRate: census.executed > 0 ? census.failed / census.executed : 0,
      durationMs,
      interrupted: census.interrupted,
      firstFailureAt: census.firstFailureAt,
      shrink,
      counterexample,
      warnings,
      errors,
    });
  } catch (error) {
    return base({
      errors: [`The test run failed: ${error instanceof Error ? error.message : String(error)}`],
      durationMs: now() - started,
    });
  } finally {
    engine.destroy();
  }
}

/**
 * Re-checks one saved scenario (for example the counterexample from before a fix) against a
 * workbook state, without generating anything new.
 */
export function replayScenario(
  workbook: WorkbookModel,
  ruleInput: unknown,
  scenario: ScenarioJson,
): { verdict: Verdict | null; counterexample: Counterexample | null; errors: string[] } {
  const parsed = RuleSchema.safeParse(ruleInput);
  if (!parsed.success) return { verdict: null, counterexample: null, errors: formatIssues(parsed.error) };
  const rule = parsed.data;
  const errors = checkRuleAgainstWorkbook(rule, workbook);
  if (errors.length > 0) return { verdict: null, counterexample: null, errors };

  const engine = CalcEngine.fromWorkbook(workbook);
  try {
    const runner = createRunner(rule, { engine, workbook });
    const verdict = runner.replay(scenario);
    const counterexample = verdict?.kind === 'fail' ? runner.explainScenario(scenario, 0) : null;
    return { verdict, counterexample, errors: [] };
  } catch (error) {
    return { verdict: null, counterexample: null, errors: [error instanceof Error ? error.message : String(error)] };
  } finally {
    engine.destroy();
  }
}
