/**
 * The built-in rule compiler: a documented set of sentence patterns, resolved against the
 * workbook's own labels. No network, no model, no code execution.
 *
 * It recognises a sentence by its shape, finds the cells the phrases refer to, and returns a
 * `RuleDraft` for the user to review. Anything it does not recognise is reported as unsupported,
 * and anything it cannot resolve unambiguously is reported as needing a cell mapping. It never
 * silently guesses between candidates.
 */
import type { ComparisonOp } from '../../schemas/rule';
import type { CellRefModel } from '../../types/workbook';
import { CalcEngine } from '../calculation/CalcEngine';
import { parseExpression } from '../expression/parser';
import { expressionCells } from '../properties/refs';
import { parseRange } from '../workbook/a1';
import { parseCellPhrase, refForExpression, resolveLabel } from './cellResolver';
import { DEFAULT_TOLERANCE, makeRuleId } from './draft';
import { inputDraftFor, numericValue, suggestInputs } from './suggest';
import type {
  CompileContext,
  CompileResult,
  PatternDoc,
  PatternId,
  Resolution,
  RuleCompiler,
  RuleDraft,
  InputDraft,
} from './types';

/** Documented patterns; shown in the UI and in the README, and covered by tests. */
export const PATTERN_DOCS: PatternDoc[] = [
  {
    id: 'monotonic_increasing',
    title: 'Raising one value must not lower another',
    ruleType: 'monotonic_increasing',
    examples: [
      'Increasing fuel surcharge must never reduce final freight cost.',
      'Total price must not decrease when quantity increases, if unit price is constant.',
      'A higher quantity must not result in a lower total price.',
    ],
  },
  {
    id: 'monotonic_decreasing',
    title: 'Raising one value must not raise another',
    ruleType: 'monotonic_decreasing',
    examples: ['Increasing discount must never increase the final price.', 'Net price must not increase when discount increases.'],
  },
  {
    id: 'non_negative',
    title: 'Never negative',
    ruleType: 'non_negative',
    examples: ['Final invoice amount must never be negative.', 'Tax and total cost must not be below zero.'],
  },
  {
    id: 'bounds_max',
    title: 'Upper limit',
    ruleType: 'bounds',
    examples: ['Discount percentage must not exceed 30%.', 'Handling charges must be at most 500.'],
  },
  {
    id: 'bounds_min',
    title: 'Lower limit',
    ruleType: 'bounds',
    examples: ['Margin must be at least 5%.', 'Subtotal must not fall below 100.'],
  },
  {
    id: 'bounds_between',
    title: 'Range',
    ruleType: 'bounds',
    examples: ['Tax rate must be between 0% and 25%.'],
  },
  {
    id: 'equals_sum',
    title: 'Equals a sum',
    ruleType: 'invariant',
    examples: ['Subtotal must equal the sum of B5:B9.', 'Total must equal the sum of B5, B6 and B7.'],
  },
  {
    id: 'equals_expression',
    title: 'Equals a calculation',
    ruleType: 'invariant',
    examples: ['Tax must equal taxable amount times tax rate.', 'B14 must equal B10 - B11 + B13.'],
  },
  {
    id: 'relation_expression',
    title: 'Compared with a calculation',
    ruleType: 'invariant',
    examples: ['Volume rebate must not exceed B10 * 10%.'],
  },
  {
    id: 'conditional',
    title: 'If … then …',
    ruleType: 'conditional',
    examples: ['If subtotal is greater than 3500 then volume rebate must be greater than 0.'],
  },
];

// ---------------------------------------------------------------------------------------------
// Sentence patterns
// ---------------------------------------------------------------------------------------------

const NEG = String.raw`(?:(?:must|should|shall|can|may|will) (?:never|not)|cannot|can't|mustn't|shouldn't|never)`;
const COND = String.raw`(?:,? (?:and )?(?:when|while|if|with|provided that|as long as|given that|assuming|holding) (.+))?`;
const RISES = String.raw`(?:increases|rises|goes up|grows|is increased|is raised|gets higher|goes higher)`;

interface MonotonicMatch {
  kind: 'monotonic';
  direction: 'increasing' | 'decreasing';
  x: string;
  y: string;
  condition: string | null;
}

function monotonicPatterns(direction: 'increasing' | 'decreasing'): RegExp[] {
  const worsens = direction === 'increasing'; // an increasing rule forbids the output from falling
  const verbs = worsens ? 'reduce|decrease|lower|drop|cut|diminish|decline' : 'increase|raise|grow|boost|inflate';
  const moves = worsens ? 'decrease|go down|drop|fall|reduce|decline|shrink' : 'increase|go up|rise|grow';
  const adj = worsens ? 'lower|smaller|reduced|decreased|lesser' : 'higher|larger|bigger|increased|greater';
  return [
    // Increasing X must never <reduce> Y
    new RegExp(`^(?:increasing|raising|an increase in|increases in|a higher|higher) (.+?) ${NEG} (?:${verbs})(?: in)? (.+?)${COND}$`),
    // A higher X must not result in a <lower> Y
    new RegExp(`^(?:a |an )?(?:higher|larger|bigger|greater|increased) (.+?) ${NEG} (?:result in|lead to|cause|produce|give|yield) (?:a |an )?(?:${adj}) (.+?)${COND}$`),
    // Y must not <decrease> when X increases
    new RegExp(`^(.+?) ${NEG} (?:${moves})(?: in value)? (?:when|if|as|whenever|while) (.+?) ${RISES}${COND}$`),
    // If X increases, Y must not <decrease>
    new RegExp(`^(?:if|when|whenever|as) (.+?) ${RISES},?(?: then)? (.+?) ${NEG} (?:${moves})${COND}$`),
  ];
}

const MONOTONIC_REGEXES: Record<'increasing' | 'decreasing', RegExp[]> = {
  increasing: monotonicPatterns('increasing'),
  decreasing: monotonicPatterns('decreasing'),
};

/** Index of the shape that reads "(Y) must not … when (X) increases": its slots arrive as (y, x). */
const Y_FIRST_SHAPE = 2;

function matchMonotonic(s: string): MonotonicMatch | null {
  for (const direction of ['increasing', 'decreasing'] as const) {
    const regexes = MONOTONIC_REGEXES[direction];
    for (let i = 0; i < regexes.length; i++) {
      const m = regexes[i]?.exec(s);
      if (!m) continue;
      const first = m[1] ?? '';
      const second = m[2] ?? '';
      const yFirst = i === Y_FIRST_SHAPE;
      return {
        kind: 'monotonic',
        direction,
        x: yFirst ? second : first,
        y: yFirst ? first : second,
        condition: m[3] ?? null,
      };
    }
  }
  return null;
}

interface NonNegativeMatch {
  kind: 'non_negative';
  subject: string;
  strict: boolean;
}

const NON_NEGATIVE_REGEXES: Array<{ re: RegExp; strict: boolean }> = [
  {
    re: new RegExp(
      `^(.+?) ${NEG} (?:be|go|become|fall|turn|drop)(?: to| below| into)? (?:negative|below zero|less than zero|below 0|less than 0|under zero|under 0)$`,
    ),
    strict: false,
  },
  {
    re: /^(.+?) (?:must|should|shall) (?:always )?be (?:non-?negative|positive or zero|zero or (?:more|positive|greater)|at least (?:zero|0)|(?:greater than or equal to|>=) (?:zero|0))$/,
    strict: false,
  },
  {
    re: /^(.+?) (?:must|should|shall) (?:always )?be (?:positive|greater than (?:zero|0)|above (?:zero|0)|more than (?:zero|0)|> ?0)$/,
    strict: true,
  },
];

function matchNonNegative(s: string): NonNegativeMatch | null {
  for (const { re, strict } of NON_NEGATIVE_REGEXES) {
    const m = re.exec(s);
    if (m) return { kind: 'non_negative', subject: m[1] ?? '', strict };
  }
  return null;
}

interface BoundMatch {
  kind: 'bound';
  side: 'max' | 'min';
  subject: string;
  limit: string;
  strict: boolean;
}
interface BetweenMatch {
  kind: 'between';
  subject: string;
  low: string;
  high: string;
}

const MAX_REGEXES: Array<{ re: RegExp; strict: boolean }> = [
  { re: new RegExp(`^(.+?) ${NEG} (?:exceed|go above|go over|surpass|be (?:more|greater|higher|larger|bigger) than|be above|be over)(?: than)? (.+)$`), strict: false },
  { re: /^(.+?) (?:must|should|shall) (?:always )?be (?:at most|no more than|no greater than|no higher than|no larger than|less than or equal to|<=|capped at|limited to|up to) (.+)$/, strict: false },
  { re: /^(.+?) (?:must|should|shall) (?:always )?be (?:less than|lower than|smaller than|under|below|<) (.+)$/, strict: true },
];
const MIN_REGEXES: Array<{ re: RegExp; strict: boolean }> = [
  { re: new RegExp(`^(.+?) ${NEG} (?:fall below|go below|drop below|be (?:less|lower|smaller) than|be below|be under|go under|fall under)(?: than)? (.+)$`), strict: false },
  { re: /^(.+?) (?:must|should|shall) (?:always )?be (?:at least|no less than|no lower than|no smaller than|greater than or equal to|>=|a minimum of|a minimum) (.+)$/, strict: false },
  { re: /^(.+?) (?:must|should|shall) (?:always )?be (?:greater than|more than|higher than|larger than|above|over|>) (.+)$/, strict: true },
];
const BETWEEN_REGEXES: RegExp[] = [
  /^(.+?) (?:must|should|shall) (?:always )?(?:be|stay|remain) (?:between|within) (.+?) and (.+)$/,
  /^(.+?) (?:must|should|shall) (?:always )?(?:be|stay|remain) from (.+?) to (.+)$/,
];

function matchBounds(s: string): BoundMatch | BetweenMatch | null {
  for (const re of BETWEEN_REGEXES) {
    const m = re.exec(s);
    if (m) return { kind: 'between', subject: m[1] ?? '', low: m[2] ?? '', high: m[3] ?? '' };
  }
  for (const { re, strict } of MAX_REGEXES) {
    const m = re.exec(s);
    if (m) return { kind: 'bound', side: 'max', subject: m[1] ?? '', limit: m[2] ?? '', strict };
  }
  for (const { re, strict } of MIN_REGEXES) {
    const m = re.exec(s);
    if (m) return { kind: 'bound', side: 'min', subject: m[1] ?? '', limit: m[2] ?? '', strict };
  }
  return null;
}

interface EqualsMatch {
  kind: 'equals';
  subject: string;
  rhs: string;
  isSum: boolean;
}

const SUM_REGEX = /^(.+?) (?:must|should|shall) (?:always )?(?:equal|be equal to|match|be) (?:the )?sum of (?:the )?(.+)$/;
const EQUALS_REGEX = /^(.+?) (?:must|should|shall) (?:always )?(?:equal|be equal to|match|reconcile (?:to|with)|add up to) (.+)$/;

function matchEquals(s: string): EqualsMatch | null {
  const sum = SUM_REGEX.exec(s);
  if (sum) return { kind: 'equals', subject: sum[1] ?? '', rhs: sum[2] ?? '', isSum: true };
  const eq = EQUALS_REGEX.exec(s);
  if (eq) return { kind: 'equals', subject: eq[1] ?? '', rhs: eq[2] ?? '', isSum: false };
  return null;
}

interface ConditionalMatch {
  kind: 'conditional';
  antecedent: string;
  consequent: string;
}

const CONDITIONAL_FORWARD = /^(?:if|when|whenever) (.+?)(?:, then|,| then) (.+? (?:must|should|shall|can ?not|cannot|never) .+)$/;
const CONDITIONAL_REVERSE = /^(.+? (?:must|should|shall) .+?) (?:when|if|whenever) (.+)$/;

function matchConditional(s: string): ConditionalMatch | null {
  const fwd = CONDITIONAL_FORWARD.exec(s);
  if (fwd) return { kind: 'conditional', antecedent: fwd[1] ?? '', consequent: fwd[2] ?? '' };
  const rev = CONDITIONAL_REVERSE.exec(s);
  // "… when X" is only a condition if X is a comparison ("subtotal is above 3500"), not just a phrase.
  if (rev && findOperator(cleanPhrase(rev[2] ?? '')) !== null) {
    return { kind: 'conditional', antecedent: rev[2] ?? '', consequent: rev[1] ?? '' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Tidies whitespace, quotes and the final full stop. Case is kept (sheet names are case-sensitive in the engine). */
function normalizeSentence(text: string): string {
  return text
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');
}

const FUNCTION_NAMES = /\b(sum|min|max|average|abs|round)(?=\s*\()/gi;
const CELL_TOKENS = /(?<![A-Za-z0-9_'!])(\$?[A-Za-z]{1,3}\$?\d+)(?![A-Za-z0-9_(])/g;

/** Cosmetic: `sum(b5:b9)` → `SUM(B5:B9)` (sheet names, which can be case-sensitive, are left alone). */
function upperCells(expression: string): string {
  return expression
    .replace(FUNCTION_NAMES, (m) => m.toUpperCase())
    .replace(CELL_TOKENS, (m) => m.toUpperCase());
}

function cleanPhrase(phrase: string): string {
  return phrase
    .trim()
    .replace(/^(?:the|a|an|our|my)\s+/, '')
    .replace(/[,;]+$/, '')
    .trim();
}

function splitList(phrase: string): string[] {
  return phrase
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/)
    .map(cleanPhrase)
    .filter(Boolean);
}

const NUMBER_TOKEN = /^[-+]?\s*[$€£]?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*(%|percent)?$/;

interface NumberToken {
  value: number;
  percent: boolean;
}

function parseNumberToken(text: string): NumberToken | null {
  const t = text.trim().replace(/^(?:the )?(?:value of |amount of )?/, '');
  const word = /^(zero|nil)$/.exec(t);
  if (word) return { value: 0, percent: false };
  const m = NUMBER_TOKEN.exec(t);
  if (!m) return null;
  const sign = t.startsWith('-') ? -1 : 1;
  const value = sign * Number((m[1] ?? '').replace(/,/g, ''));
  return Number.isFinite(value) ? { value, percent: m[2] !== undefined } : null;
}

const CONSTANT_PATTERN = /^(.+?)\s+(?:is |are |stays |stay |remains |remain |is held |are held |is kept |are kept |held |kept |being held |being kept )?(?:constant|fixed|unchanged|the same)$/;

function parseConstants(condition: string): string[] | null {
  const m = CONSTANT_PATTERN.exec(condition.trim());
  return m ? splitList(m[1] ?? '') : null;
}

const OPERATOR_SPLIT = /\s*(\+|\*|\/|(?<=[\w)%])\s-\s|\bplus\b|\bminus\b|\btimes\b|\bmultiplied by\b|\bdivided by\b)\s*/;
const WORD_OPERATORS: Record<string, string> = {
  plus: '+',
  minus: '-',
  times: '*',
  'multiplied by': '*',
  'divided by': '/',
};

const COMPARISON_WORDS: Array<{ re: RegExp; op: ComparisonOp }> = [
  { re: /(?:is |are )?(?:greater than or equal to|at least|no less than|>=)/, op: '>=' },
  { re: /(?:is |are )?(?:less than or equal to|at most|no more than|<=)/, op: '<=' },
  { re: /(?:is |are )?(?:not equal to|different from|other than|!=)/, op: '!=' },
  { re: /(?:is |are )?(?:greater than|more than|higher than|above|exceeds|over|>)/, op: '>' },
  { re: /(?:is |are )?(?:less than|lower than|fewer than|below|under|<)/, op: '<' },
  { re: /(?:is |are )?(?:equal to|equals|==|=)|\bis\b/, op: '==' },
];

// ---------------------------------------------------------------------------------------------
// Compiler session
// ---------------------------------------------------------------------------------------------

class Session {
  readonly notes: string[] = [];
  readonly resolutions: Resolution[] = [];
  readonly questions: string[] = [];
  private engineInstance: CalcEngine | null | undefined;
  private readonly lower: string;

  /** `sentence` is the normalised sentence in its original case; slots arrive lower-cased from the matchers. */
  constructor(
    readonly ctx: CompileContext,
    private readonly sentence: string,
  ) {
    this.lower = sentence.toLowerCase();
  }

  /** Recovers the original capitalisation of a slot that was matched on the lower-cased sentence. */
  restore(slot: string): string {
    const at = this.lower.indexOf(slot.toLowerCase());
    return at >= 0 && this.sentence.length === this.lower.length ? this.sentence.slice(at, at + slot.length) : slot;
  }

  get engine(): CalcEngine | null {
    if (this.engineInstance === undefined) {
      try {
        this.engineInstance = CalcEngine.fromWorkbook(this.ctx.workbook);
      } catch {
        this.engineInstance = null;
      }
    }
    return this.engineInstance;
  }

  close(): void {
    this.engineInstance?.destroy();
  }

  valueOf(ref: CellRefModel): number | null {
    return this.engine ? numericValue(this.engine, ref) : null;
  }

  /** Resolves a phrase to one cell, or records a question and returns `null`. */
  cell(phraseRaw: string): CellRefModel | null {
    const phrase = cleanPhrase(phraseRaw);
    const direct = parseCellPhrase(phrase, this.ctx.workbook, this.ctx.activeSheet);
    if (direct) {
      this.resolutions.push({ phrase, ref: direct, via: 'cell reference' });
      return direct;
    }
    const found = resolveLabel(phrase, this.ctx.workbook, this.ctx.activeSheet);
    if (found.kind === 'resolved') {
      this.resolutions.push({ phrase, ref: found.ref, via: found.via });
      return found.ref;
    }
    if (found.kind === 'ambiguous') {
      this.questions.push(
        `“${phrase}” matches more than one cell: ${found.candidates
          .map((c) => `${c.ref.sheet}!${c.ref.address} (${c.via})`)
          .join('; ')}. Which one do you mean? Type the cell address (for example ${found.candidates[0]?.ref.address ?? 'B6'}) to map it.`,
      );
      return null;
    }
    this.questions.push(
      `I could not find a cell labelled “${phrase}”. Type its address (for example B6) to map it.`,
    );
    return null;
  }

  /** A number literal as it should appear in an expression, resolving the "30%" scale question. */
  numberLiteral(token: NumberToken, scaleRef: CellRefModel | null): string {
    if (!token.percent) return String(token.value);
    const reference = scaleRef ? this.valueOf(scaleRef) : null;
    if (reference !== null && Math.abs(reference) > 1) {
      this.notes.push(
        `“${token.value}%” was read as ${token.value}, because the value in ${scaleRef?.address ?? 'the cell'} (${reference}) looks like whole percentage points. If it is stored as a fraction (for example 0.3), change it.`,
      );
      return String(token.value);
    }
    return `${token.value}%`;
  }

  /**
   * Turns a phrase such as “taxable amount times tax rate” or “B10 - B11” into expression text.
   * Returns `null` (and records a question) when part of it cannot be resolved.
   */
  expression(textRaw: string, scaleRef: CellRefModel | null = null): string | null {
    // "10% of subtotal" reads as a multiplication.
    const text = this.restore(cleanPhrase(textRaw)).replace(/(\d[\d.,]*\s*%)\s+of\s+/gi, '$1 * ');
    // Already a valid expression of cell references and numbers? Use it as written.
    try {
      parseExpression(text);
      const refs = expressionCells(text, this.ctx.activeSheet);
      for (const r of refs) this.resolutions.push({ phrase: r.address, ref: r, via: 'cell reference' });
      return upperCells(text);
    } catch {
      /* fall through to label resolution */
    }

    const parts = text.split(OPERATOR_SPLIT).map((p) => p.trim());
    const out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? '';
      if (i % 2 === 1) {
        out.push(WORD_OPERATORS[part] ?? part.replace(/\s/g, ''));
        continue;
      }
      if (part === '') return this.fail(text);
      const number = parseNumberToken(part);
      if (number) {
        // The whole-percent check only makes sense for a lone number compared with a cell; inside a
        // calculation ("10% * subtotal") a percentage is a rate and keeps its meaning.
        out.push(this.numberLiteral(number, parts.length === 1 ? scaleRef : null));
        continue;
      }
      const ref = this.cell(part);
      if (!ref) return null;
      out.push(refForExpression(ref, this.ctx.activeSheet));
    }
    const joined = out.join(' ');
    try {
      parseExpression(joined);
    } catch {
      return this.fail(text);
    }
    return joined;
  }

  private fail(text: string): null {
    this.questions.push(`I could not turn “${text}” into a calculation. Use cell addresses and + − * / (for example B10 - B11).`);
    return null;
  }

  /** Suggested inputs for target cells, plus the standard "review these ranges" note. */
  inputsFor(targets: CellRefModel[], exclude: CellRefModel[]): InputDraft[] {
    const engine = this.engine;
    if (!engine) return [];
    const inputs = suggestInputs(this.ctx.workbook, engine, targets, exclude);
    if (inputs.length > 0) {
      this.notes.push(
        `Inputs to vary were chosen as the numeric cells that feed ${targets.map((t) => t.address).join(', ')}: ${inputs
          .map((i) => i.address)
          .join(', ')}. Their ranges are suggestions based on the current values; review them before running.`,
      );
    }
    return inputs;
  }
}

function blankRef(sheet: string): { sheet: string; address: string } {
  return { sheet, address: '' };
}

function sentenceName(original: string): string {
  const text = original.trim().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 120);
}

function baseDraft(session: Session, original: string): RuleDraft {
  const name = sentenceName(original);
  return {
    id: makeRuleId(name, original.trim()),
    name,
    description: original.trim(),
    type: 'bounds',
    sheet: session.ctx.activeSheet,
    tolerance: DEFAULT_TOLERANCE,
    relativeTolerance: '0',
    source: 'compiler',
    inputs: [],
    outputs: [],
    min: '',
    max: '',
    left: '',
    relation: '==',
    right: '',
    when: { left: '', op: '>', right: '' },
    then: { left: '', op: '>', right: '' },
  };
}

function finish(
  session: Session,
  pattern: PatternId,
  draft: RuleDraft,
  extraQuestions: string[] = [],
): CompileResult {
  const questions = [...session.questions, ...extraQuestions];
  if (questions.length > 0) {
    return {
      status: 'needs_mapping',
      pattern,
      draft,
      resolutions: session.resolutions,
      reason: 'I recognised the rule, but some cells need to be mapped before it can run.',
      questions,
      notes: session.notes,
    };
  }
  return { status: 'compiled', pattern, draft, resolutions: session.resolutions, notes: session.notes };
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

function buildMonotonic(session: Session, original: string, m: MonotonicMatch): CompileResult {
  const draft = baseDraft(session, original);
  draft.type = m.direction === 'increasing' ? 'monotonic_increasing' : 'monotonic_decreasing';
  const sheet = session.ctx.activeSheet;

  const x = session.cell(m.x);
  const y = session.cell(m.y);

  const constants: CellRefModel[] = [];
  const extra: string[] = [];
  if (m.condition) {
    const names = parseConstants(m.condition);
    if (names === null) {
      extra.push(
        `I did not understand the condition “${m.condition}”. Only “… is constant/fixed/unchanged” conditions are supported here; remove it, or build an If … then … rule instead.`,
      );
    } else {
      for (const name of names) {
        const ref = session.cell(name);
        if (ref) constants.push(ref);
      }
      if (constants.length > 0) {
        session.notes.push(
          `Held constant (not varied): ${constants.map((c) => c.address).join(', ')}. They keep their current values in every scenario.`,
        );
      }
    }
  }

  if (x) {
    const value = session.valueOf(x);
    draft.inputs.push(inputDraftFor(session.ctx.workbook, x, value));
    const cell = session.ctx.workbook.sheets.find((s) => s.name === x.sheet)?.cells[x.address];
    if (cell?.formula) {
      session.notes.push(`${x.address} contains a formula. GridFuzz overwrites it with generated values during testing and restores it afterwards.`);
    }
  } else {
    draft.inputs.push({ ...blankInput(sheet) });
  }

  draft.outputs.push(y ? { sheet: y.sheet, address: y.address } : blankRef(sheet));
  if (x && y) {
    draft.inputs.push(...session.inputsFor([y], [x, ...constants]));
  }
  return finish(session, m.direction === 'increasing' ? 'monotonic_increasing' : 'monotonic_decreasing', draft, extra);
}

function blankInput(sheet: string): InputDraft {
  return { sheet, address: '', label: '', min: '0', max: '1000', precision: '0', unit: '' };
}

function buildNonNegative(session: Session, original: string, m: NonNegativeMatch): CompileResult {
  const draft = baseDraft(session, original);
  draft.type = 'non_negative';
  const subjects: CellRefModel[] = [];

  const whole = cleanPhrase(m.subject);
  const direct = parseCellPhrase(whole, session.ctx.workbook, session.ctx.activeSheet);
  const labelled = direct ? null : resolveLabel(whole, session.ctx.workbook, session.ctx.activeSheet);
  const tryWhole = direct !== null || labelled?.kind === 'resolved' || labelled?.kind === 'ambiguous';
  const phrases = tryWhole ? [whole] : splitList(m.subject);
  for (const phrase of phrases) {
    const ref = session.cell(phrase);
    if (ref) subjects.push(ref);
  }
  draft.outputs = subjects.length > 0 ? subjects.map((r) => ({ sheet: r.sheet, address: r.address })) : [blankRef(session.ctx.activeSheet)];
  if (subjects.length > 0) draft.inputs.push(...session.inputsFor(subjects, subjects));
  if (m.strict) {
    session.notes.push('“Positive” was treated as “not negative” (≥ 0). Strictly greater-than-zero checks are not supported; a value of exactly 0 will pass.');
  }
  const extra =
    subjects.length > 0 && draft.inputs.length === 0
      ? [`No numeric input cells feed ${subjects.map((s) => s.address).join(', ')}. Add the input cells you want to vary.`]
      : [];
  return finish(session, 'non_negative', draft, extra);
}

function buildBounds(session: Session, original: string, m: BoundMatch | BetweenMatch): CompileResult {
  const draft = baseDraft(session, original);
  const y = session.cell(m.subject);
  draft.outputs.push(y ? { sheet: y.sheet, address: y.address } : blankRef(session.ctx.activeSheet));

  const number = (text: string): number | null => {
    const token = parseNumberToken(text);
    if (!token) return null;
    const literal = session.numberLiteral(token, y);
    return Number(literal.endsWith('%') ? Number(literal.slice(0, -1)) / 100 : literal);
  };

  if (m.kind === 'between') {
    const low = number(m.low);
    const high = number(m.high);
    if (low === null || high === null) {
      return finish(session, 'bounds_between', { ...draft, type: 'bounds' }, [
        'The limits must be numbers (for example “between 0% and 25%”).',
      ]);
    }
    draft.type = 'bounds';
    draft.min = String(low);
    draft.max = String(high);
    if (y) draft.inputs.push(...session.inputsFor([y], [y]));
    return finish(session, 'bounds_between', draft, noInputsQuestion(session, draft, y));
  }

  if (m.strict) {
    session.notes.push('“Less/more than” was treated as an inclusive limit. A value exactly equal to the limit will pass.');
  }
  const limit = number(m.limit);
  if (limit !== null) {
    draft.type = 'bounds';
    if (m.side === 'max') draft.max = String(limit);
    else draft.min = String(limit);
    if (y) draft.inputs.push(...session.inputsFor([y], [y]));
    return finish(session, m.side === 'max' ? 'bounds_max' : 'bounds_min', draft, noInputsQuestion(session, draft, y));
  }

  // The limit is another cell or a calculation: that is an invariant, not a fixed bound.
  const rhs = session.expression(m.limit, y);
  draft.type = 'invariant';
  draft.left = y ? refForExpression(y, session.ctx.activeSheet) : '';
  draft.relation = m.side === 'max' ? '<=' : '>=';
  draft.right = rhs ?? '';
  const targets = [y, ...(rhs ? expressionCells(rhs, session.ctx.activeSheet) : [])].filter((r): r is CellRefModel => r !== null);
  if (targets.length > 0) draft.inputs.push(...session.inputsFor(targets, []));
  return finish(session, 'relation_expression', draft, noInputsQuestion(session, draft, y));
}

function noInputsQuestion(session: Session, draft: RuleDraft, y: CellRefModel | null): string[] {
  if (!y || draft.inputs.length > 0) return [];
  const cell = session.ctx.workbook.sheets.find((s) => s.name === y.sheet)?.cells[y.address];
  if (cell && cell.formula === null) {
    return [
      `${y.address} is a typed-in value, not a formula, so no other cell can change it and there is nothing to stress-test. Pick a calculated cell for this rule, or map the input cells you want to vary.`,
    ];
  }
  return [`No numeric input cells feed ${y.address}. Add the input cells you want to vary.`];
}

function buildEquals(session: Session, original: string, m: EqualsMatch): CompileResult {
  const draft = baseDraft(session, original);
  draft.type = 'invariant';
  draft.relation = '==';
  const left = session.cell(m.subject);
  draft.left = left ? refForExpression(left, session.ctx.activeSheet) : '';

  let right: string | null = null;
  let pattern: PatternId = 'equals_expression';
  if (m.isSum) {
    pattern = 'equals_sum';
    right = sumExpression(session, m.rhs);
  } else {
    right = session.expression(m.rhs, left);
  }
  draft.right = right ?? '';

  const targets: CellRefModel[] = [];
  if (left) targets.push(left);
  if (right) targets.push(...expressionCells(right, session.ctx.activeSheet));
  if (targets.length > 0) draft.inputs.push(...session.inputsFor(targets, []));
  return finish(session, pattern, draft, left && right && draft.inputs.length === 0
    ? [`No numeric input cells feed ${targets.map((t) => t.address).join(', ')}. Add the input cells you want to vary.`]
    : []);
}

function sumExpression(session: Session, rhsRaw: string): string | null {
  const rhs = cleanPhrase(rhsRaw);
  if (/^(?:all|every|each)\b/.test(rhs)) {
    session.questions.push(
      `“${rhs}” does not say which cells to add. Name them, for example “the sum of B5:B9” or “the sum of B5, B6 and B7”.`,
    );
    return null;
  }
  const rangeMatch = /^(?:(?:'(?:[^']|'')+'|[A-Za-z0-9_.]+)!)?\$?[A-Za-z]{1,3}\$?\d+:\$?[A-Za-z]{1,3}\$?\d+$/.exec(rhs);
  if (rangeMatch) {
    const addressPart = rhs.includes('!') ? rhs.slice(rhs.lastIndexOf('!') + 1) : rhs;
    if (!parseRange(addressPart.replace(/\$/g, '').toUpperCase())) {
      session.questions.push(`“${rhs}” is not a valid range.`);
      return null;
    }
    const expr = `SUM(${rhs.toUpperCase().replace(/^([^!]+)!/, (_, sheet: string) => `${sheet}!`)})`;
    try {
      parseExpression(expr);
      return expr;
    } catch {
      session.questions.push(`“${rhs}” is not a valid range.`);
      return null;
    }
  }
  const items = splitList(rhs);
  if (items.length === 0) return null;
  const parts: string[] = [];
  for (const item of items) {
    const ref = session.cell(item);
    if (!ref) return null;
    parts.push(refForExpression(ref, session.ctx.activeSheet));
  }
  return parts.join(' + ');
}

interface ComparisonParts {
  left: string;
  op: ComparisonOp;
  right: string;
}

function buildComparison(session: Session, text: string, kind: 'condition' | 'requirement'): ComparisonParts | null {
  let sentence = cleanPhrase(text);
  let op: ComparisonOp | null = null;
  let leftText = '';
  let rightText = '';

  if (kind === 'requirement') {
    // "(Y) must [not] be/exceed/equal …"
    const m = /^(.+?) (?:must|should|shall|can ?not|cannot|never) (.+)$/.exec(sentence);
    if (!m) return fail(session, text);
    leftText = m[1] ?? '';
    const rest = (m[2] ?? '').replace(/^(?:always )?/, '');
    const negated = /^(?:never|not) /.test(rest) || /^(?:can ?not|cannot|never)/.test(sentence.slice(leftText.length + 1));
    const tail = rest.replace(/^(?:never|not) /, '').replace(/^be /, '');
    if (negated) {
      if (/^(?:exceed|go above|go over|surpass|more than|greater than|higher than|above|over)/.test(tail)) op = '<=';
      else if (/^(?:fall below|go below|drop below|less than|lower than|smaller than|below|under)/.test(tail)) op = '>=';
      else if (/^(?:equal|equal to|zero)/.test(tail)) op = '!=';
      rightText = tail.replace(/^(?:exceed|go above|go over|surpass|fall below|go below|drop below|equal to|equal|more than|greater than|higher than|above|over|less than|lower than|smaller than|below|under)\s+/, '');
    } else {
      const matched = matchOperator(tail);
      if (matched) {
        op = matched.op;
        rightText = matched.rest;
      } else if (/^(?:positive)$/.test(tail)) {
        op = '>';
        rightText = '0';
      } else if (/^(?:non-?negative)$/.test(tail)) {
        op = '>=';
        rightText = '0';
      } else if (/^(?:zero)$/.test(tail)) {
        op = '==';
        rightText = '0';
      } else if (/^(?:equal to |equals )/.test(tail)) {
        op = '==';
        rightText = tail.replace(/^(?:equal to |equals )/, '');
      }
    }
  } else {
    sentence = sentence.replace(/^(?:the )?/, '');
    const matched = findOperator(sentence);
    if (matched) {
      op = matched.op;
      leftText = matched.left;
      rightText = matched.right;
    }
  }

  if (!op || leftText.trim() === '' || rightText.trim() === '') return fail(session, text);
  const leftRef = parseCellOrNull(session, leftText);
  const left = session.expression(leftText);
  const right = session.expression(rightText, leftRef);
  if (left === null || right === null) return null;
  return { left, op, right };
}

function parseCellOrNull(session: Session, phrase: string): CellRefModel | null {
  const direct = parseCellPhrase(cleanPhrase(phrase), session.ctx.workbook, session.ctx.activeSheet);
  if (direct) return direct;
  const found = resolveLabel(cleanPhrase(phrase), session.ctx.workbook, session.ctx.activeSheet);
  return found.kind === 'resolved' ? found.ref : null;
}

function fail(session: Session, text: string): null {
  session.questions.push(
    `I could not read “${text}” as a comparison. Use a form like “subtotal is greater than 3500” or “volume rebate must not exceed 175”.`,
  );
  return null;
}

function matchOperator(text: string): { op: ComparisonOp; rest: string } | null {
  for (const { re, op } of COMPARISON_WORDS) {
    const m = new RegExp(`^(?:${re.source})\\s+(.+)$`).exec(text);
    if (m) return { op, rest: m[m.length - 1] ?? '' };
  }
  return null;
}

function findOperator(text: string): { op: ComparisonOp; left: string; right: string } | null {
  // Longest operator phrases first so "greater than or equal to" is not read as "greater than".
  for (const { re, op } of COMPARISON_WORDS) {
    const m = new RegExp(`^(.+?)\\s+(?:${re.source})\\s+(.+)$`).exec(text);
    if (m) {
      return { op, left: m[1] ?? '', right: m[m.length - 1] ?? '' };
    }
  }
  return null;
}

function buildConditional(session: Session, original: string, m: ConditionalMatch): CompileResult {
  const draft = baseDraft(session, original);
  draft.type = 'conditional';
  const when = buildComparison(session, m.antecedent, 'condition');
  const then = buildComparison(session, m.consequent, 'requirement');
  if (when) draft.when = when;
  if (then) draft.then = then;

  const targets: CellRefModel[] = [];
  for (const c of [when, then]) {
    if (!c) continue;
    targets.push(...expressionCells(c.left, session.ctx.activeSheet), ...expressionCells(c.right, session.ctx.activeSheet));
  }
  if (targets.length > 0) draft.inputs.push(...session.inputsFor(targets, []));
  const extra =
    when && then && draft.inputs.length === 0
      ? ['No numeric input cells feed the cells in this rule. Add the input cells you want to vary.']
      : [];
  return finish(session, 'conditional', draft, extra);
}

// ---------------------------------------------------------------------------------------------
// Public compiler
// ---------------------------------------------------------------------------------------------

const MAX_SENTENCE_LENGTH = 400;

function unsupported(reason: string): CompileResult {
  return {
    status: 'unsupported',
    reason,
    suggestions: PATTERN_DOCS.flatMap((p) => p.examples.slice(0, 1)),
  };
}

export class LocalRuleCompiler implements RuleCompiler {
  readonly id = 'local-patterns';
  readonly label = 'Built-in pattern compiler';

  compile(text: string, context: CompileContext): CompileResult {
    const original = text.trim();
    if (original === '') return unsupported('Type a rule first.');
    if (original.length > MAX_SENTENCE_LENGTH) {
      return unsupported(`That is longer than ${MAX_SENTENCE_LENGTH} characters. Describe one rule at a time.`);
    }
    const cased = normalizeSentence(original);
    // Patterns are matched on the lower-case sentence; the session keeps the cased one to restore slots.
    const s = cased.toLowerCase();
    const session = new Session(context, cased);
    try {
      const mono = matchMonotonic(s);
      if (mono) return buildMonotonic(session, original, mono);

      const conditional = matchConditional(s);
      if (conditional) return buildConditional(session, original, conditional);

      const nonNegative = matchNonNegative(s);
      if (nonNegative) return buildNonNegative(session, original, nonNegative);

      const bounds = matchBounds(s);
      if (bounds) return buildBounds(session, original, bounds);

      const equals = matchEquals(s);
      if (equals) return buildEquals(session, original, equals);

      return unsupported(
        'I do not recognise that sentence shape, and I will not guess. Rephrase it like one of the examples, or build the rule by hand with the form below.',
      );
    } finally {
      session.close();
    }
  }
}

export const localRuleCompiler = new LocalRuleCompiler();

/** Tries each compiler in order and returns the first result that is not `unsupported`. */
export async function compileWith(
  compilers: readonly RuleCompiler[],
  text: string,
  context: CompileContext,
): Promise<CompileResult> {
  let last: CompileResult = unsupported('No compiler is available.');
  for (const compiler of compilers) {
    const result = await compiler.compile(text, context);
    if (result.status !== 'unsupported') return result;
    last = result;
  }
  return last;
}
