import fc from 'fast-check';
import type {
  Counterexample,
  InconclusiveReason,
  ScenarioJson,
  TestConfig,
  Verdict,
} from '../../types/testing';
import { isCalcError, type CalcEngine } from '../calculation/CalcEngine';
import type { PropertyDefinition } from './shared';

export interface CensusHooks {
  timeLimitMs: number;
  onProgress?: (executed: number) => void;
}

export interface CensusOutcome {
  executed: number;
  passed: number;
  failed: number;
  inconclusive: number;
  reasons: Partial<Record<InconclusiveReason, number>>;
  samples: Partial<Record<InconclusiveReason, string>>;
  /** 1-based index of the first failing scenario. */
  firstFailureAt: number | null;
  interrupted: boolean;
}

export interface ShrinkOutcome {
  counterexample: Counterexample;
  originalScenario: ScenarioJson;
  originalFoundAt: number;
  steps: number;
  evaluations: number;
  reproducible: boolean;
}

/** A property with its scenario type erased, ready to be run by `runRule`. */
export interface PropertyRunner {
  /** Evaluates every one of `config.numRuns` seeded scenarios (never stops at the first failure). */
  census(config: TestConfig, hooks: CensusHooks): CensusOutcome;
  /** Replays the same seeded generation and lets fast-check shrink the first failure it finds. */
  shrink(config: TestConfig): ShrinkOutcome | null;
  /** Fallback when shrinking could not reproduce a failure: explain the first failure unshrunk. */
  explainFirstFailure(seed: number): Counterexample | null;
  /** Re-evaluates a saved scenario on this workbook state. */
  replay(scenario: ScenarioJson): Verdict | null;
  /** Re-explains a saved scenario on this workbook state. */
  explainScenario(scenario: ScenarioJson, seed: number): Counterexample | null;
  /** Signature of every tracked cell's current value; equal before/after proves no state leaked. */
  signature(): string;
}

const PROGRESS_EVERY = 100;

function safeEvaluate<S>(definition: PropertyDefinition<S>, scenario: S): Verdict {
  try {
    return definition.evaluate(scenario);
  } catch (error) {
    return {
      kind: 'inconclusive',
      reason: 'engine_error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function makeRunner<S>(definition: PropertyDefinition<S>, engine: CalcEngine): PropertyRunner {
  let firstFailure: S | null = null;
  let firstFailureJson: string | null = null;
  let firstFailureAt: number | null = null;

  return {
    census(config, hooks) {
      const outcome: CensusOutcome = {
        executed: 0,
        passed: 0,
        failed: 0,
        inconclusive: 0,
        reasons: {},
        samples: {},
        firstFailureAt: null,
        interrupted: false,
      };
      firstFailure = null;
      firstFailureJson = null;
      firstFailureAt = null;

      // The predicate always returns true: fast-check keeps generating, so every scenario is
      // counted. Failures are recorded here and shrunk in a second, seeded pass (see `shrink`).
      const property = fc.property(definition.arbitrary, (scenario) => {
        const verdict = safeEvaluate(definition, scenario);
        outcome.executed++;
        if (verdict.kind === 'pass') {
          outcome.passed++;
        } else if (verdict.kind === 'fail') {
          outcome.failed++;
          if (firstFailure === null) {
            firstFailure = scenario;
            firstFailureJson = JSON.stringify(definition.toJson(scenario));
            firstFailureAt = outcome.executed;
            outcome.firstFailureAt = outcome.executed;
          }
        } else {
          outcome.inconclusive++;
          outcome.reasons[verdict.reason] = (outcome.reasons[verdict.reason] ?? 0) + 1;
          if (outcome.samples[verdict.reason] === undefined) outcome.samples[verdict.reason] = verdict.message;
        }
        if (outcome.executed % PROGRESS_EVERY === 0) hooks.onProgress?.(outcome.executed);
        return true;
      });

      const details = fc.check(property, {
        numRuns: config.numRuns,
        seed: config.seed,
        interruptAfterTimeLimit: hooks.timeLimitMs,
        markInterruptAsFailure: false,
      });
      if (details.failed) {
        throw new Error(
          `Scenario generation failed: ${details.errorInstance instanceof Error ? details.errorInstance.message : 'unknown error'}`,
        );
      }
      outcome.interrupted = details.interrupted;
      hooks.onProgress?.(outcome.executed);
      return outcome;
    },

    shrink(config) {
      if (firstFailure === null || firstFailureAt === null) return null;
      let original: S | null = null;
      let evaluations = 0;

      const property = fc.property(definition.arbitrary, (scenario) => {
        // Everything evaluated after the first failure is a shrink candidate.
        if (original !== null) evaluations++;
        const verdict = safeEvaluate(definition, scenario);
        if (verdict.kind === 'fail') {
          if (original === null) original = scenario;
          return false;
        }
        return true;
      });

      const details = fc.check(property, { numRuns: config.numRuns, seed: config.seed });
      if (!details.failed || !details.counterexample || original === null) return null;
      const shrunk = details.counterexample[0];
      const originalJson = definition.toJson(original);
      return {
        counterexample: definition.explain(shrunk, config.seed),
        originalScenario: originalJson,
        originalFoundAt: firstFailureAt,
        steps: details.numShrinks,
        evaluations,
        reproducible: JSON.stringify(originalJson) === firstFailureJson,
      };
    },

    explainFirstFailure(seed) {
      return firstFailure === null ? null : definition.explain(firstFailure, seed);
    },

    replay(scenario) {
      const parsed = definition.fromJson(scenario);
      return parsed === null ? null : safeEvaluate(definition, parsed);
    },

    explainScenario(scenario, seed) {
      const parsed = definition.fromJson(scenario);
      return parsed === null ? null : definition.explain(parsed, seed);
    },

    signature() {
      return JSON.stringify(
        definition.trackedCells().map((ref) => {
          const v = engine.getValue(ref.sheet, ref.address);
          return isCalcError(v) ? v.display : v;
        }),
      );
    },
  };
}
