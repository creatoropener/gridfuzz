import {
  DEFAULT_SEED,
  RuleSchema,
  formatIssues,
  type Rule,
} from '../../schemas/rule';
import type { RuleType } from '../../types/testing';
import { hashString } from '../../utils/hash';
import type { ComparisonDraft, InputDraft, RuleDraft } from './types';

export const DEFAULT_TOLERANCE = '0.005';

export function emptyInput(sheet: string): InputDraft {
  return { sheet, address: '', label: '', min: '0', max: '1000', precision: '0', unit: '' };
}

const emptyComparison = (): ComparisonDraft => ({ left: '', op: '>', right: '' });

export function emptyDraft(type: RuleType, sheet: string): RuleDraft {
  return {
    id: '',
    name: '',
    description: '',
    type,
    sheet,
    tolerance: DEFAULT_TOLERANCE,
    relativeTolerance: '0',
    source: 'manual',
    inputs: [emptyInput(sheet)],
    outputs: [{ sheet, address: '' }],
    min: '',
    max: '',
    left: '',
    relation: '==',
    right: '',
    when: emptyComparison(),
    then: emptyComparison(),
  };
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'rule';
}

/** A stable id derived from the rule text, so recompiling the same sentence gives the same id. */
export function makeRuleId(name: string, description: string): string {
  return `${slugify(name)}-${hashString(`${name}|${description}`).slice(0, 6)}`;
}

type NumberParse = { ok: true; value: number } | { ok: false };

/** Parses a typed number: `1,250`, `-3.5`, `30%` (→ 0.3). Empty or malformed input is `ok: false`. */
export function parseNumberField(raw: string): NumberParse {
  const text = raw.trim().replace(/,/g, '');
  if (text === '') return { ok: false };
  const percent = /^([-+]?\d+(?:\.\d+)?)\s*%$/.exec(text);
  if (percent) return { ok: true, value: Number(percent[1]) / 100 };
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(text)) return { ok: false };
  const value = Number(text);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false };
}

export type DraftResult = { ok: true; rule: Rule } | { ok: false; issues: string[] };

/** Validates a draft into a rule. Every rule that reaches the engine has passed `RuleSchema`. */
export function draftToRule(draft: RuleDraft): DraftResult {
  const issues: string[] = [];
  const num = (raw: string, what: string): number => {
    const parsed = parseNumberField(raw);
    if (!parsed.ok) {
      issues.push(`${what}: enter a number${raw.trim() === '' ? '' : ` (got “${raw}”)`}`);
      return Number.NaN;
    }
    return parsed.value;
  };
  const optionalNum = (raw: string, what: string): number | null => {
    if (raw.trim() === '') return null;
    const value = num(raw, what);
    return Number.isNaN(value) ? null : value;
  };

  const inputOf = (input: InputDraft, index: number) => {
    const where = input.address.trim() ? input.address.trim().toUpperCase() : `input ${index + 1}`;
    const spec: Record<string, unknown> = {
      cell: { sheet: input.sheet, address: input.address.trim().toUpperCase() },
      min: num(input.min, `${where} minimum`),
      max: num(input.max, `${where} maximum`),
      precision: num(input.precision, `${where} precision`),
    };
    if (input.label.trim()) spec.label = input.label.trim();
    if (input.unit.trim()) spec.unit = input.unit.trim();
    return spec;
  };
  const refOf = (o: { sheet: string; address: string }) => ({ sheet: o.sheet, address: o.address.trim().toUpperCase() });
  const compOf = (c: ComparisonDraft) => ({ left: c.left, op: c.op, right: c.right });

  const name = draft.name.trim() || draft.description.trim().slice(0, 120);
  const base: Record<string, unknown> = {
    id: draft.id.trim() || makeRuleId(name || draft.type, draft.description),
    name,
    description: draft.description.trim(),
    type: draft.type,
    sheet: draft.sheet,
    tolerance: num(draft.tolerance, 'Tolerance'),
    source: draft.source,
  };

  let candidate: Record<string, unknown>;
  switch (draft.type) {
    case 'monotonic_increasing':
    case 'monotonic_decreasing': {
      const [first, ...rest] = draft.inputs;
      if (!first) issues.push('Choose the input cell that is raised.');
      candidate = {
        ...base,
        input: first ? inputOf(first, 0) : undefined,
        context: rest.map((c, i) => inputOf(c, i + 1)),
        output: draft.outputs[0] ? refOf(draft.outputs[0]) : undefined,
      };
      break;
    }
    case 'bounds':
      candidate = {
        ...base,
        inputs: draft.inputs.map(inputOf),
        output: draft.outputs[0] ? refOf(draft.outputs[0]) : undefined,
        min: optionalNum(draft.min, 'Minimum'),
        max: optionalNum(draft.max, 'Maximum'),
      };
      break;
    case 'non_negative':
      candidate = { ...base, inputs: draft.inputs.map(inputOf), outputs: draft.outputs.map(refOf) };
      break;
    case 'invariant':
      candidate = {
        ...base,
        inputs: draft.inputs.map(inputOf),
        left: draft.left,
        relation: draft.relation,
        right: draft.right,
        relativeTolerance: num(draft.relativeTolerance, 'Relative tolerance'),
      };
      break;
    case 'conditional':
      candidate = { ...base, inputs: draft.inputs.map(inputOf), when: compOf(draft.when), then: compOf(draft.then) };
      break;
  }

  // Number problems are reported in the user's words; schema issues for NaN fields would only repeat them.
  if (issues.length > 0) return { ok: false, issues };
  const parsed = RuleSchema.safeParse(candidate);
  return parsed.success ? { ok: true, rule: parsed.data } : { ok: false, issues: formatIssues(parsed.error) };
}

const text = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12))));

/** Inverse of `draftToRule`: lets an existing rule be edited in the rule form. */
export function ruleToDraft(rule: Rule): RuleDraft {
  const draft = emptyDraft(rule.type, rule.sheet);
  const inputDraft = (i: {
    cell: { sheet: string; address: string };
    label?: string | undefined;
    min: number;
    max: number;
    precision: number;
    unit?: string | undefined;
  }): InputDraft => ({
    sheet: i.cell.sheet,
    address: i.cell.address,
    label: i.label ?? '',
    min: text(i.min),
    max: text(i.max),
    precision: String(i.precision),
    unit: i.unit ?? '',
  });
  const common = {
    ...draft,
    id: rule.id,
    name: rule.name,
    description: rule.description,
    tolerance: text(rule.tolerance),
    source: rule.source,
  };
  switch (rule.type) {
    case 'monotonic_increasing':
    case 'monotonic_decreasing':
      return { ...common, inputs: [inputDraft(rule.input), ...rule.context.map(inputDraft)], outputs: [{ ...rule.output }] };
    case 'bounds':
      return {
        ...common,
        inputs: rule.inputs.map(inputDraft),
        outputs: [{ ...rule.output }],
        min: rule.min === null ? '' : text(rule.min),
        max: rule.max === null ? '' : text(rule.max),
      };
    case 'non_negative':
      return { ...common, inputs: rule.inputs.map(inputDraft), outputs: rule.outputs.map((o) => ({ ...o })) };
    case 'invariant':
      return {
        ...common,
        inputs: rule.inputs.map(inputDraft),
        left: rule.left,
        relation: rule.relation,
        right: rule.right,
        relativeTolerance: text(rule.relativeTolerance),
      };
    case 'conditional':
      return { ...common, inputs: rule.inputs.map(inputDraft), when: { ...rule.when }, then: { ...rule.then } };
  }
}

export { DEFAULT_SEED };
