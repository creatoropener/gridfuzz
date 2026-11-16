import fc from 'fast-check';
import type { Rule } from '../../schemas/rule';
import type { PropertyRunner } from './runner';
import { makeRunner } from './runner';
import type { PropertyContext } from './shared';
import { createBoundsProperty } from './bounds';
import { createConditionalProperty } from './conditional';
import { createInvariantProperty } from './invariant';
import { createMonotonicProperty } from './monotonic';
import { createNonNegativeProperty } from './nonNegative';

export { ruleReferences } from './refs';
export type { PropertyRunner } from './runner';

export const FAST_CHECK_VERSION: string = (fc as unknown as { __version?: string }).__version ?? 'unknown';

/** Builds the runnable property for a validated rule. */
export function createRunner(rule: Rule, pc: PropertyContext): PropertyRunner {
  switch (rule.type) {
    case 'monotonic_increasing':
    case 'monotonic_decreasing':
      return makeRunner(createMonotonicProperty(rule, pc), pc.engine);
    case 'bounds':
      return makeRunner(createBoundsProperty(rule, pc), pc.engine);
    case 'non_negative':
      return makeRunner(createNonNegativeProperty(rule, pc), pc.engine);
    case 'invariant':
      return makeRunner(createInvariantProperty(rule, pc), pc.engine);
    case 'conditional':
      return makeRunner(createConditionalProperty(rule, pc), pc.engine);
  }
}
