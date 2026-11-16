import { z } from 'zod';
import { ADDRESS_PATTERN } from '../engine/workbook/a1';
import { parseExpression } from '../engine/expression/parser';

/** The structured, validated form of a business rule. Every rule GridFuzz runs has passed this schema. */

export const CellRefSchema = z.object({
  sheet: z.string().min(1, 'Choose a sheet'),
  address: z.string().regex(ADDRESS_PATTERN, 'Use an A1-style address such as B5'),
});
export type CellRef = z.infer<typeof CellRefSchema>;

/** The scaled integer range GridFuzz samples from for a given precision. */
export function scaledBounds(min: number, max: number, precision: number): { lo: number; hi: number; scale: number } {
  const scale = 10 ** precision;
  // `+ 0` turns a negative zero (Math.ceil(-1e-9) is -0) into 0, so it can never leak into generated values.
  return { lo: Math.ceil(min * scale - 1e-9) + 0, hi: Math.floor(max * scale + 1e-9) + 0, scale };
}

export const InputSpecSchema = z
  .object({
    cell: CellRefSchema,
    label: z.string().max(120).optional(),
    min: z.number().min(-1e9, 'Minimum must be at least −1,000,000,000').max(1e9),
    max: z.number().min(-1e9).max(1e9, 'Maximum must be at most 1,000,000,000'),
    /** Decimal places generated values keep (0 = whole numbers). */
    precision: z.number().int('Precision must be a whole number').min(0).max(6, 'Precision is limited to 6 decimals'),
    unit: z.string().max(24).optional(),
  })
  .superRefine((spec, ctx) => {
    if (!(spec.min < spec.max)) {
      ctx.addIssue({ code: 'custom', message: 'Minimum must be less than maximum', path: ['max'] });
      return;
    }
    const { lo, hi } = scaledBounds(spec.min, spec.max, spec.precision);
    if (!(lo < hi)) {
      ctx.addIssue({
        code: 'custom',
        message: 'The range is too narrow for the chosen precision (fewer than two distinct values)',
        path: ['max'],
      });
    }
  });
export type InputSpec = z.infer<typeof InputSpecSchema>;

export const ExpressionSchema = z
  .string()
  .trim()
  .min(1, 'Enter an expression')
  .max(300, 'Expressions are limited to 300 characters')
  .superRefine((value, ctx) => {
    try {
      parseExpression(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid expression' });
    }
  });

export const COMPARISON_OPS = ['>', '>=', '<', '<=', '==', '!='] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];

export const ComparisonSchema = z.object({
  left: ExpressionSchema,
  op: z.enum(COMPARISON_OPS),
  right: ExpressionSchema,
});
export type Comparison = z.infer<typeof ComparisonSchema>;

const baseShape = {
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore'),
  name: z.string().trim().min(1, 'Give the rule a name').max(120),
  /** The rule as the user wrote it, in plain English. */
  description: z.string().trim().max(500),
  /** Sheet used for expression references written without a sheet prefix. */
  sheet: z.string().min(1, 'Choose a sheet'),
  /** Absolute tolerance used when comparing calculated numbers. */
  tolerance: z.number().min(0, 'Tolerance cannot be negative').max(1_000_000),
  source: z.enum(['sample', 'compiler', 'manual']),
};

function distinctCells(
  cells: ReadonlyArray<{ path: Array<string | number>; cell: CellRef }>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Map<string, true>();
  for (const { path, cell } of cells) {
    const key = `${cell.sheet}!${cell.address}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', message: `${cell.address} is mapped more than once`, path });
    }
    seen.set(key, true);
  }
}

function monotonicSchema<T extends 'monotonic_increasing' | 'monotonic_decreasing'>(type: T) {
  return z
    .object({
      ...baseShape,
      type: z.literal(type),
      /** The input that is raised. */
      input: InputSpecSchema,
      /** Other inputs explored alongside it (held equal within each before/after pair). */
      context: z.array(InputSpecSchema).max(12, 'At most 12 context inputs'),
      output: CellRefSchema,
    })
    .superRefine((rule, ctx) => {
      distinctCells(
        [
          { path: ['input', 'cell'], cell: rule.input.cell },
          ...rule.context.map((c, i) => ({ path: ['context', i, 'cell'], cell: c.cell })),
          { path: ['output'], cell: rule.output },
        ],
        ctx,
      );
    });
}

export const MonotonicIncreasingRuleSchema = monotonicSchema('monotonic_increasing');
export const MonotonicDecreasingRuleSchema = monotonicSchema('monotonic_decreasing');

export const BoundsRuleSchema = z
  .object({
    ...baseShape,
    type: z.literal('bounds'),
    inputs: z.array(InputSpecSchema).min(1, 'Add at least one input to vary').max(12),
    output: CellRefSchema,
    min: z.number().nullable(),
    max: z.number().nullable(),
  })
  .superRefine((rule, ctx) => {
    if (rule.min === null && rule.max === null) {
      ctx.addIssue({ code: 'custom', message: 'Set a minimum, a maximum, or both', path: ['min'] });
    }
    if (rule.min !== null && rule.max !== null && rule.min > rule.max) {
      ctx.addIssue({ code: 'custom', message: 'Minimum cannot be greater than maximum', path: ['min'] });
    }
    distinctCells(rule.inputs.map((c, i) => ({ path: ['inputs', i, 'cell'], cell: c.cell })), ctx);
  });

export const NonNegativeRuleSchema = z
  .object({
    ...baseShape,
    type: z.literal('non_negative'),
    inputs: z.array(InputSpecSchema).min(1, 'Add at least one input to vary').max(12),
    outputs: z.array(CellRefSchema).min(1, 'Choose at least one output cell').max(10),
  })
  .superRefine((rule, ctx) => {
    distinctCells(rule.inputs.map((c, i) => ({ path: ['inputs', i, 'cell'], cell: c.cell })), ctx);
  });

export const INVARIANT_RELATIONS = ['==', '<=', '>='] as const;
export type InvariantRelation = (typeof INVARIANT_RELATIONS)[number];

export const InvariantRuleSchema = z
  .object({
    ...baseShape,
    type: z.literal('invariant'),
    inputs: z.array(InputSpecSchema).min(1, 'Add at least one input to vary').max(12),
    left: ExpressionSchema,
    relation: z.enum(INVARIANT_RELATIONS),
    right: ExpressionSchema,
    /** Relative tolerance (fraction of the larger side) added to the absolute tolerance. */
    relativeTolerance: z.number().min(0).max(1),
  })
  .superRefine((rule, ctx) => {
    distinctCells(rule.inputs.map((c, i) => ({ path: ['inputs', i, 'cell'], cell: c.cell })), ctx);
  });

export const ConditionalRuleSchema = z
  .object({
    ...baseShape,
    type: z.literal('conditional'),
    inputs: z.array(InputSpecSchema).min(1, 'Add at least one input to vary').max(12),
    when: ComparisonSchema,
    then: ComparisonSchema,
  })
  .superRefine((rule, ctx) => {
    distinctCells(rule.inputs.map((c, i) => ({ path: ['inputs', i, 'cell'], cell: c.cell })), ctx);
  });

export const RuleSchema = z.discriminatedUnion('type', [
  MonotonicIncreasingRuleSchema,
  MonotonicDecreasingRuleSchema,
  BoundsRuleSchema,
  NonNegativeRuleSchema,
  InvariantRuleSchema,
  ConditionalRuleSchema,
]);

export type Rule = z.infer<typeof RuleSchema>;
export type MonotonicRule = z.infer<typeof MonotonicIncreasingRuleSchema> | z.infer<typeof MonotonicDecreasingRuleSchema>;
export type BoundsRule = z.infer<typeof BoundsRuleSchema>;
export type NonNegativeRule = z.infer<typeof NonNegativeRuleSchema>;
export type InvariantRule = z.infer<typeof InvariantRuleSchema>;
export type ConditionalRule = z.infer<typeof ConditionalRuleSchema>;

export const MAX_RUNS = 50_000;
export const MIN_RUNS = 10;

export const TestConfigSchema = z.object({
  numRuns: z.number().int('Use a whole number').min(MIN_RUNS, `At least ${MIN_RUNS} scenarios`).max(MAX_RUNS, `At most ${MAX_RUNS.toLocaleString('en-US')} scenarios`),
  seed: z.number().int('The seed must be a whole number').min(0).max(2_147_483_647),
});

export const DEFAULT_SEED = 1031;
export const DEFAULT_RUNS = 1000;

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    return `${where}${issue.message}`;
  });
}

/** All input specs a rule varies, in a stable order (used for generators, highlighting and reports). */
export function ruleInputs(rule: Rule): InputSpec[] {
  switch (rule.type) {
    case 'monotonic_increasing':
    case 'monotonic_decreasing':
      return [rule.input, ...rule.context];
    default:
      return rule.inputs;
  }
}

/** The cells a rule checks. */
export function ruleOutputs(rule: Rule): CellRef[] {
  switch (rule.type) {
    case 'monotonic_increasing':
    case 'monotonic_decreasing':
    case 'bounds':
      return [rule.output];
    case 'non_negative':
      return rule.outputs;
    default:
      return [];
  }
}
