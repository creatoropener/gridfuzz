import type { ComparisonOp, InvariantRelation } from '../../schemas/rule';
import type { RuleType } from '../../types/testing';
import type { CellRefModel, WorkbookModel } from '../../types/workbook';

/**
 * Editable, string-based form of a rule. The rule form binds to this, the compiler produces it,
 * and `draftToRule` validates it into a real `Rule`. Numbers are strings so half-typed input
 * (an empty field, `-`, `0.`) never has to be coerced while the user is typing.
 */
export interface InputDraft {
  sheet: string;
  address: string;
  label: string;
  min: string;
  max: string;
  precision: string;
  unit: string;
}

export interface ComparisonDraft {
  left: string;
  op: ComparisonOp;
  right: string;
}

export interface RuleDraft {
  id: string;
  name: string;
  description: string;
  type: RuleType;
  sheet: string;
  tolerance: string;
  relativeTolerance: string;
  source: 'sample' | 'compiler' | 'manual';
  /** Monotonic rules: the first entry is the input that is raised, the rest are context inputs. */
  inputs: InputDraft[];
  /** Monotonic and bounds rules use the first entry; non-negative rules use all of them. */
  outputs: Array<{ sheet: string; address: string }>;
  min: string;
  max: string;
  left: string;
  relation: InvariantRelation;
  right: string;
  when: ComparisonDraft;
  then: ComparisonDraft;
}

export interface CompileContext {
  /** The working copy (edits applied). Never modified by compilers. */
  workbook: WorkbookModel;
  /** The sheet the user is looking at; used to break ties and as the rule's default sheet. */
  activeSheet: string;
}

export interface Resolution {
  /** The words from the sentence. */
  phrase: string;
  ref: CellRefModel;
  /** How it was matched, in plain words (shown to the user). */
  via: string;
}

export type PatternId =
  | 'monotonic_increasing'
  | 'monotonic_decreasing'
  | 'non_negative'
  | 'bounds_max'
  | 'bounds_min'
  | 'bounds_between'
  | 'equals_sum'
  | 'equals_expression'
  | 'relation_expression'
  | 'conditional';

export type CompileResult =
  | {
      status: 'compiled';
      pattern: PatternId;
      draft: RuleDraft;
      resolutions: Resolution[];
      /** Assumptions and guesses the user should check (suggested ranges, percent scale, ...). */
      notes: string[];
    }
  | {
      status: 'needs_mapping';
      pattern: PatternId;
      /** Best-effort draft; unresolved cells are left blank for the user to map. */
      draft: RuleDraft;
      resolutions: Resolution[];
      reason: string;
      questions: string[];
      notes: string[];
    }
  | {
      status: 'unsupported';
      reason: string;
      suggestions: string[];
    };

/**
 * Turns a plain-English sentence into a structured rule draft.
 *
 * Implementations must be pure with respect to the workbook (never modify it) and must never
 * execute generated code. An AI-backed implementation can be added behind this interface; it
 * must return a `RuleDraft`, which is then validated by the same Zod schema as every other rule.
 */
export interface RuleCompiler {
  readonly id: string;
  readonly label: string;
  compile(text: string, context: CompileContext): CompileResult | Promise<CompileResult>;
}

export interface PatternDoc {
  id: PatternId;
  title: string;
  ruleType: RuleType;
  examples: string[];
}
