import type { CellRefModel } from './workbook';

export const RULE_TYPES = [
  'monotonic_increasing',
  'monotonic_decreasing',
  'bounds',
  'non_negative',
  'invariant',
  'conditional',
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const INCONCLUSIVE_REASONS = [
  'calc_error',
  'division_by_zero',
  'circular_reference',
  'invalid_reference',
  'unsupported_function',
  'missing_value',
  'non_numeric',
  'non_finite_result',
  'precondition_not_met',
  'engine_error',
] as const;
export type InconclusiveReason = (typeof INCONCLUSIVE_REASONS)[number];

export type ScalarJson = number | string | boolean | null;

/** Exact scenario that produced a failure; enough to replay it on any version of the workbook. */
export type ScenarioJson =
  | { kind: 'pair'; context: number[]; low: number; high: number }
  | { kind: 'point'; values: number[] };

export type Verdict =
  | { kind: 'pass' }
  | { kind: 'fail' }
  | { kind: 'inconclusive'; reason: InconclusiveReason; message: string };

export type CellRole = 'input' | 'context' | 'output' | 'path' | 'referenced';

export type FindingLevel = 'confirmed' | 'suggested';

export interface Finding {
  level: FindingLevel;
  text: string;
}

export interface CounterexampleCell {
  cell: CellRefModel;
  label: string | null;
  role: CellRole;
  formula: string | null;
  /** Value in the working copy before any scenario was applied. */
  original: ScalarJson;
  /** Value in each run, aligned with `Counterexample.runs`. */
  values: ScalarJson[];
  /** Last run minus first run, for numeric values; `null` otherwise. */
  delta: number | null;
  /** True when the analysis flagged the cell as moving against the expected direction. */
  movedAgainstRule: boolean;
}

export interface HighlightSet {
  inputs: CellRefModel[];
  outputs: CellRefModel[];
  failing: CellRefModel[];
  suspects: CellRefModel[];
  related: CellRefModel[];
}

export interface Counterexample {
  ruleId: string;
  ruleType: RuleType;
  seed: number;
  /** Names of the runs that make up the counterexample, e.g. `Lower input`, `Higher input`. */
  runs: string[];
  cells: CounterexampleCell[];
  /** One-sentence description of the violation, built from real calculated values. */
  violation: string;
  expected: string;
  actual: string;
  /** Actual minus expected where that is meaningful, otherwise `null`. */
  difference: number | null;
  findings: Finding[];
  highlight: HighlightSet;
  scenario: ScenarioJson;
}

export interface ShrinkInfo {
  /** Number of successful shrink steps reported by fast-check. */
  steps: number;
  /** Predicate evaluations spent while shrinking. */
  evaluations: number;
  /** 1-based index of the scenario at which the violation was first seen. */
  originalFoundAt: number;
  originalScenario: ScenarioJson;
  /** True when the second, shrinking pass hit the identical first failing scenario. */
  reproducible: boolean;
}

export interface TestConfig {
  numRuns: number;
  seed: number;
}

export type RuleStatus = 'passed' | 'failed' | 'inconclusive';

export interface RuleRunResult {
  ruleId: string;
  ruleName: string;
  status: RuleStatus;
  seed: number;
  requestedRuns: number;
  executed: number;
  passed: number;
  failed: number;
  inconclusive: number;
  inconclusiveReasons: Partial<Record<InconclusiveReason, number>>;
  /** One real example message per inconclusive reason. */
  inconclusiveSamples: Partial<Record<InconclusiveReason, string>>;
  /** `failed / executed`, 0 when nothing ran. */
  failureRate: number;
  durationMs: number;
  /** True when the time limit stopped the run before `requestedRuns` scenarios. */
  interrupted: boolean;
  firstFailureAt: number | null;
  shrink: ShrinkInfo | null;
  counterexample: Counterexample | null;
  /** Static-analysis notes (unsupported functions, volatile functions, ...). */
  warnings: string[];
  /** Problems that prevented the rule from being tested at all. */
  errors: string[];
  engine: { hyperformula: string; fastCheck: string };
  ranAt: string;
  /** Fingerprint of the working copy the rule ran against. */
  workingCopy: string;
}
