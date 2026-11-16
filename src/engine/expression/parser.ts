/**
 * A small, safe arithmetic expression language for business rules.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := primary ('^' unary)?
 *   primary := NUMBER ['%'] | cell | FUNC '(' args ')' | '(' expr ')'
 *   cell    := [sheet '!'] ['$']COL['$']ROW        sheet := name | 'quoted name'
 *   args    := (expr | range) (',' (expr | range))*
 *   range   := cell ':' cell                          (only as a function argument)
 *
 * Functions: SUM, MIN, MAX, AVERAGE, ABS, ROUND. Expressions are parsed into a plain AST and
 * interpreted by `evaluateExpression`; nothing is ever passed to `eval` or `new Function`.
 */
import { normalizeAddress } from '../workbook/a1';

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'ref'; sheet: string | null; address: string }
  | { t: 'range'; sheet: string | null; from: string; to: string }
  | { t: 'neg'; e: Expr }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; l: Expr; r: Expr }
  | { t: 'call'; fn: string; args: Expr[] };

export const EXPRESSION_FUNCTIONS = ['SUM', 'MIN', 'MAX', 'AVERAGE', 'ABS', 'ROUND'] as const;
export type ExpressionFunction = (typeof EXPRESSION_FUNCTIONS)[number];

export class ExpressionSyntaxError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = 'ExpressionSyntaxError';
    this.position = position;
  }
}

type Token =
  | { k: 'num'; v: number; pos: number }
  | { k: 'cell'; sheet: string | null; address: string; pos: number }
  | { k: 'func'; name: string; pos: number }
  | { k: 'op'; ch: '+' | '-' | '*' | '/' | '^' | '(' | ')' | ',' | ':'; pos: number }
  | { k: 'eof'; pos: number };

const CELL_TEXT = /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/;
const IDENT_CHAR = /[A-Za-z0-9_.$]/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const readCellText = (): string => {
    const start = i;
    while (i < src.length && /[A-Za-z0-9$]/.test(src[i] ?? '')) i++;
    return src.slice(start, i);
  };

  while (i < src.length) {
    const ch = src[i] ?? '';
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const pos = i;

    if (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      const text = m?.[0] ?? ch;
      i += text.length;
      let value = Number(text);
      if (src[i] === '%') {
        value /= 100;
        i++;
      }
      tokens.push({ k: 'num', v: value, pos });
      continue;
    }

    if (ch === "'") {
      // 'Sheet name'!A1  (a doubled '' is an escaped quote)
      let name = '';
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            name += "'";
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        name += src[i];
        i++;
      }
      if (!closed) throw new ExpressionSyntaxError('Unterminated sheet name', pos);
      if (src[i] !== '!') throw new ExpressionSyntaxError('Expected "!" after the sheet name', i);
      i++;
      const text = readCellText();
      const address = CELL_TEXT.test(text) ? normalizeAddress(text) : null;
      if (!address) throw new ExpressionSyntaxError(`"${text}" is not a valid cell address`, i);
      tokens.push({ k: 'cell', sheet: name, address, pos });
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < src.length && IDENT_CHAR.test(src[i] ?? '')) i++;
      const word = src.slice(start, i);
      let j = i;
      while (/\s/.test(src[j] ?? '')) j++;

      if (src[i] === '!') {
        // Unquoted sheet name followed by a cell address.
        i++;
        const text = readCellText();
        const address = CELL_TEXT.test(text) ? normalizeAddress(text) : null;
        if (!address) throw new ExpressionSyntaxError(`"${text}" is not a valid cell address`, i);
        tokens.push({ k: 'cell', sheet: word, address, pos });
      } else if (src[j] === '(') {
        tokens.push({ k: 'func', name: word.toUpperCase(), pos });
      } else if (CELL_TEXT.test(word)) {
        const address = normalizeAddress(word);
        if (!address) throw new ExpressionSyntaxError(`"${word}" is not a valid cell address`, pos);
        tokens.push({ k: 'cell', sheet: null, address, pos });
      } else {
        throw new ExpressionSyntaxError(
          `Unknown name "${word}". Use cell addresses such as B5 or Quote!B5.`,
          pos,
        );
      }
      continue;
    }

    if ('+-*/^(),:'.includes(ch)) {
      tokens.push({ k: 'op', ch: ch as '+', pos });
      i++;
      continue;
    }

    throw new ExpressionSyntaxError(`Unexpected character "${ch}"`, pos);
  }
  tokens.push({ k: 'eof', pos: src.length });
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index] ?? { k: 'eof', pos: 0 };
  }

  private next(): Token {
    const token = this.peek();
    this.index++;
    return token;
  }

  private isOp(ch: string): boolean {
    const t = this.peek();
    return t.k === 'op' && t.ch === ch;
  }

  private expectOp(ch: string): void {
    const t = this.next();
    if (t.k !== 'op' || t.ch !== ch) throw new ExpressionSyntaxError(`Expected "${ch}"`, t.pos);
  }

  parse(): Expr {
    const expr = this.expression();
    const t = this.peek();
    if (t.k !== 'eof') throw new ExpressionSyntaxError('Unexpected input after the expression', t.pos);
    return expr;
  }

  private expression(): Expr {
    let left = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.next() as { ch: '+' | '-' }).ch;
      left = { t: 'bin', op, l: left, r: this.term() };
    }
    return left;
  }

  private term(): Expr {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/')) {
      const op = (this.next() as { ch: '*' | '/' }).ch;
      left = { t: 'bin', op, l: left, r: this.unary() };
    }
    return left;
  }

  private unary(): Expr {
    if (this.isOp('-')) {
      this.next();
      return { t: 'neg', e: this.unary() };
    }
    if (this.isOp('+')) {
      this.next();
      return this.unary();
    }
    return this.power();
  }

  private power(): Expr {
    const base = this.primary();
    if (this.isOp('^')) {
      this.next();
      return { t: 'bin', op: '^', l: base, r: this.unary() };
    }
    return base;
  }

  private primary(): Expr {
    const t = this.next();
    switch (t.k) {
      case 'num':
        return { t: 'num', v: t.v };
      case 'cell':
        if (this.isOp(':')) throw new ExpressionSyntaxError('Ranges can only be used inside a function such as SUM(B4:B8)', t.pos);
        return { t: 'ref', sheet: t.sheet, address: t.address };
      case 'func':
        return this.call(t.name, t.pos);
      case 'op':
        if (t.ch === '(') {
          const inner = this.expression();
          this.expectOp(')');
          return inner;
        }
        throw new ExpressionSyntaxError(`Unexpected "${t.ch}"`, t.pos);
      default:
        throw new ExpressionSyntaxError('The expression ended unexpectedly', t.pos);
    }
  }

  private call(name: string, pos: number): Expr {
    if (!(EXPRESSION_FUNCTIONS as readonly string[]).includes(name)) {
      throw new ExpressionSyntaxError(
        `Function ${name}() is not supported in rules. Supported: ${EXPRESSION_FUNCTIONS.join(', ')}.`,
        pos,
      );
    }
    this.expectOp('(');
    const args: Expr[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        args.push(this.argument());
        if (this.isOp(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectOp(')');
    const arity = FUNCTION_ARITY[name as ExpressionFunction];
    if (args.length < arity.min || args.length > arity.max) {
      throw new ExpressionSyntaxError(
        `${name}() takes ${arity.min === arity.max ? arity.min : `${arity.min}–${arity.max === Infinity ? 'many' : arity.max}`} argument(s)`,
        pos,
      );
    }
    if (arity.scalarOnly && args.some((a) => a.t === 'range')) {
      throw new ExpressionSyntaxError(`${name}() does not accept a range`, pos);
    }
    return { t: 'call', fn: name, args };
  }

  private argument(): Expr {
    const t = this.peek();
    if (t.k === 'cell') {
      const after = this.tokens[this.index + 1];
      if (after && after.k === 'op' && after.ch === ':') {
        this.next();
        this.next();
        const end = this.next();
        if (end.k !== 'cell') throw new ExpressionSyntaxError('Expected a cell address after ":"', end.pos);
        return { t: 'range', sheet: t.sheet, from: t.address, to: end.address };
      }
    }
    return this.expression();
  }
}

const FUNCTION_ARITY: Record<ExpressionFunction, { min: number; max: number; scalarOnly: boolean }> = {
  SUM: { min: 1, max: Infinity, scalarOnly: false },
  MIN: { min: 1, max: Infinity, scalarOnly: false },
  MAX: { min: 1, max: Infinity, scalarOnly: false },
  AVERAGE: { min: 1, max: Infinity, scalarOnly: false },
  ABS: { min: 1, max: 1, scalarOnly: true },
  ROUND: { min: 2, max: 2, scalarOnly: true },
};

export function parseExpression(source: string): Expr {
  if (source.trim() === '') throw new ExpressionSyntaxError('The expression is empty', 0);
  if (source.length > 300) throw new ExpressionSyntaxError('The expression is too long (limit 300 characters)', 300);
  return new Parser(tokenize(source)).parse();
}

export interface ExpressionReferences {
  cells: Array<{ sheet: string | null; address: string }>;
  ranges: Array<{ sheet: string | null; from: string; to: string }>;
}

/** Every cell and range an expression reads. `sheet: null` means "the rule's default sheet". */
export function collectReferences(expr: Expr): ExpressionReferences {
  const out: ExpressionReferences = { cells: [], ranges: [] };
  const walk = (e: Expr): void => {
    switch (e.t) {
      case 'ref':
        out.cells.push({ sheet: e.sheet, address: e.address });
        break;
      case 'range':
        out.ranges.push({ sheet: e.sheet, from: e.from, to: e.to });
        break;
      case 'neg':
        walk(e.e);
        break;
      case 'bin':
        walk(e.l);
        walk(e.r);
        break;
      case 'call':
        e.args.forEach(walk);
        break;
      case 'num':
        break;
    }
  };
  walk(expr);
  return out;
}
