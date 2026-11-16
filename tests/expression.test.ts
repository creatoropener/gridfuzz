import { describe, expect, it } from 'vitest';
import { CalcEngine } from '../src/engine/calculation/CalcEngine';
import { evaluateExpression } from '../src/engine/expression/evaluate';
import { ExpressionSyntaxError, collectReferences, parseExpression } from '../src/engine/expression/parser';
import { makeWorkbook } from './helpers';

const wb = makeWorkbook([
  ['A1', 10],
  ['A2', 4],
  ['A3', 0],
  ['A4', 'text'],
  ['A5', '=1/0'],
  ['A6', '=NOPE(1)'],
  ['B1', 1],
  ['B2', 2],
  ['B3', 3],
]);

function value(source: string): ReturnType<typeof evaluateExpression> {
  const engine = CalcEngine.fromWorkbook(wb);
  try {
    return evaluateExpression(parseExpression(source), {
      defaultSheet: 'S',
      getValue: (sheet, address) => engine.getValue(sheet, address),
    });
  } finally {
    engine.destroy();
  }
}

describe('expression language: parsing and evaluation', () => {
  it('respects operator precedence and associativity', () => {
    expect(value('1 + 2 * 3')).toEqual({ ok: true, value: 7 });
    expect(value('(1 + 2) * 3')).toEqual({ ok: true, value: 9 });
    expect(value('10 - 4 - 3')).toEqual({ ok: true, value: 3 });
    expect(value('2 ^ 3 ^ 2')).toEqual({ ok: true, value: 512 });
    expect(value('-2 ^ 2')).toEqual({ ok: true, value: -4 });
    expect(value('8 / 2 / 2')).toEqual({ ok: true, value: 2 });
  });

  it('reads cells, percentages and unary signs', () => {
    expect(value('A1 + A2')).toEqual({ ok: true, value: 14 });
    expect(value('A1 * 10%')).toEqual({ ok: true, value: 1 });
    expect(value('-A2 + +A1')).toEqual({ ok: true, value: 6 });
    expect(value('S!A1 + $A$2')).toEqual({ ok: true, value: 14 });
    expect(value("'S'!A1")).toEqual({ ok: true, value: 10 });
  });

  it('supports the documented functions over ranges and scalars', () => {
    expect(value('SUM(B1:B3)')).toEqual({ ok: true, value: 6 });
    expect(value('MIN(B1:B3, 0.5)')).toEqual({ ok: true, value: 0.5 });
    expect(value('MAX(B1:B3)')).toEqual({ ok: true, value: 3 });
    expect(value('AVERAGE(B1:B3)')).toEqual({ ok: true, value: 2 });
    expect(value('ABS(0 - A1)')).toEqual({ ok: true, value: 10 });
    expect(value('ROUND(2.567, 2)')).toEqual({ ok: true, value: 2.57 });
    expect(value('sum(b1:b3)')).toEqual({ ok: true, value: 6 });
  });

  it('rejects anything outside the language, including attempts to run code', () => {
    const bad = [
      '',
      '1 +',
      '(1',
      '1 2',
      'FOO(1)',
      'constructor.constructor("return 1")()',
      'process.exit(1)',
      'A1:A3',
      'ABS(B1:B3)',
      'ROUND(1)',
      "'S'A1",
      '1 $ 2',
      'x'.repeat(301),
    ];
    for (const source of bad) {
      expect(() => parseExpression(source), source).toThrow(ExpressionSyntaxError);
    }
  });

  it('reports spreadsheet problems as inconclusive with a precise reason, never as numbers', () => {
    expect(value('A1 / A3')).toMatchObject({ ok: false, reason: 'division_by_zero' });
    expect(value('A5')).toMatchObject({ ok: false, reason: 'division_by_zero' });
    expect(value('A6')).toMatchObject({ ok: false, reason: 'unsupported_function' });
    expect(value('A4')).toMatchObject({ ok: false, reason: 'non_numeric' });
    expect(value('Z9')).toMatchObject({ ok: false, reason: 'missing_value' });
    expect(value('SUM(A5:A6)')).toMatchObject({ ok: false });
    expect(value('AVERAGE(Z1:Z3)')).toMatchObject({ ok: false, reason: 'division_by_zero' });
    expect(value('10 ^ 400')).toMatchObject({ ok: false, reason: 'non_finite_result' });
  });

  it('collects every referenced cell and range', () => {
    const refs = collectReferences(parseExpression("SUM(A1:A3) + 'Other Sheet'!B2 * C4"));
    expect(refs.ranges).toEqual([{ sheet: null, from: 'A1', to: 'A3' }]);
    expect(refs.cells).toEqual([
      { sheet: 'Other Sheet', address: 'B2' },
      { sheet: null, address: 'C4' },
    ]);
  });
});
