import { describe, expect, it } from 'vitest';
import { PATTERN_DOCS, localRuleCompiler } from '../src/engine/rule-compiler/LocalRuleCompiler';
import { draftToRule, ruleToDraft } from '../src/engine/rule-compiler/draft';
import { buildFreightWorkbook, SAMPLE_SHEET } from '../src/engine/samples/freightQuote';
import { runRule } from '../src/engine/runRule';
import type { CompileResult } from '../src/engine/rule-compiler/types';
import type { CellModel, WorkbookModel } from '../src/types/workbook';
import { parseAddress } from '../src/engine/workbook/a1';

function workbookFrom(sheet: string, cells: Array<[string, string | number]>): WorkbookModel {
  const map: Record<string, CellModel> = {};
  let rows = 0;
  let cols = 0;
  for (const [address, content] of cells) {
    const pos = parseAddress(address);
    if (!pos) throw new Error(address);
    const isFormula = typeof content === 'string' && content.startsWith('=');
    map[address] = {
      address,
      row: pos.row,
      col: pos.col,
      value: isFormula ? null : content,
      formula: isFormula ? (content as string) : null,
    };
    rows = Math.max(rows, pos.row + 1);
    cols = Math.max(cols, pos.col + 1);
  }
  return {
    id: `test:${sheet}`,
    name: `${sheet}.xlsx`,
    sizeBytes: 0,
    source: 'upload',
    sheets: [{ name: sheet, rowCount: rows, colCount: cols, cells: map }],
    warnings: [],
  };
}

const freight = buildFreightWorkbook();
const order = workbookFrom('Order', [
  ['A1', 'Quantity'], ['B1', 10],
  ['A2', 'Unit price'], ['B2', 25],
  ['A3', 'Discount percentage'], ['B3', '=IF(B1>=10,0.15,0.05)'],
  ['A4', 'Total price'], ['B4', '=B1*B2*(1-B3)'],
  ['A5', 'Shipping'], ['B5', 12],
  ['A6', 'Final invoice amount'], ['B6', '=B4+B5'],
]);
const orderWholePercent = workbookFrom('Order', [
  ['A1', 'Discount percentage'], ['B1', '=IF(B4>=10,15,5)'],
  ['A2', 'Price'], ['B2', 200],
  ['A3', 'Net'], ['B3', '=B2*(1-B1/100)'],
  ['A4', 'Quantity'], ['B4', 12],
]);

const compile = (text: string, wb: WorkbookModel, sheet: string): CompileResult =>
  localRuleCompiler.compile(text, { workbook: wb, activeSheet: sheet });

function expectCompiled(result: CompileResult) {
  if (result.status !== 'compiled') {
    throw new Error(`expected compiled, got ${result.status}: ${JSON.stringify(result, null, 1).slice(0, 800)}`);
  }
  return result;
}

describe('rule compiler: monotonic patterns', () => {
  const increasing = [
    'Increasing fuel surcharge must never reduce final freight cost.',
    'Raising the fuel surcharge should not lower the final freight cost',
    'Final freight cost must not decrease when fuel surcharge increases.',
    'If fuel surcharge increases, final freight cost must never decrease.',
    'A higher fuel surcharge must not result in a lower final freight cost.',
  ];
  for (const sentence of increasing) {
    it(`compiles “${sentence}”`, () => {
      const r = expectCompiled(compile(sentence, freight, SAMPLE_SHEET));
      expect(r.draft.type).toBe('monotonic_increasing');
      expect(r.draft.inputs[0]?.address).toBe('B6');
      expect(r.draft.outputs[0]?.address).toBe('B14');
      // Suggested context inputs come from numeric literal cells that feed the output.
      const context = r.draft.inputs.slice(1).map((i) => i.address);
      expect(context).toEqual(expect.arrayContaining(['B5', 'B7', 'B8', 'B9']));
      expect(context).not.toContain('B6');
      expect(r.notes.join(' ')).toMatch(/suggestions/);
    });
  }

  it('compiles the decreasing form', () => {
    const r = expectCompiled(compile('Increasing fuel surcharge must never increase the final freight cost.', freight, SAMPLE_SHEET));
    expect(r.draft.type).toBe('monotonic_decreasing');
    expect(r.draft.outputs[0]?.address).toBe('B14');
    const r2 = expectCompiled(compile('Final freight cost must not increase when fuel surcharge increases', freight, SAMPLE_SHEET));
    expect(r2.draft.type).toBe('monotonic_decreasing');
    expect(r2.draft.inputs[0]?.address).toBe('B6');
  });

  it('holds "constant" cells fixed instead of varying them', () => {
    const r = expectCompiled(
      compile('Increasing quantity must not decrease the total price when unit price is constant.', order, 'Order'),
    );
    expect(r.draft.inputs[0]?.address).toBe('B1');
    expect(r.draft.outputs[0]?.address).toBe('B4');
    const varied = r.draft.inputs.map((i) => i.address);
    expect(varied).not.toContain('B2');
    expect(r.notes.join(' ')).toMatch(/Held constant.*B2/);
  });

  it('asks instead of ignoring a condition it does not understand', () => {
    const r = compile('Increasing quantity must not decrease the total price when quantity is above 100.', order, 'Order');
    expect(r.status).toBe('needs_mapping');
    if (r.status === 'needs_mapping') expect(r.questions.join(' ')).toMatch(/did not understand the condition/);
  });
});

describe('rule compiler: other rule types', () => {
  it('non-negative', () => {
    const r = expectCompiled(compile('Final freight cost must never be negative.', freight, SAMPLE_SHEET));
    expect(r.draft.type).toBe('non_negative');
    expect(r.draft.outputs.map((o) => o.address)).toEqual(['B14']);
    expect(r.draft.inputs.length).toBeGreaterThan(0);
  });

  it('non-negative with a list of cells', () => {
    const r = expectCompiled(compile('Tax and final freight cost must not be below zero.', freight, SAMPLE_SHEET));
    expect(r.draft.outputs.map((o) => o.address)).toEqual(['B13', 'B14']);
  });

  it('treats "positive" as ≥ 0 and says so', () => {
    const r = expectCompiled(compile('Final freight cost must be positive.', freight, SAMPLE_SHEET));
    expect(r.draft.type).toBe('non_negative');
    expect(r.notes.join(' ')).toMatch(/Strictly greater-than-zero/);
  });

  it('upper bound with a percentage stored as a fraction', () => {
    const r = expectCompiled(compile('Discount percentage must not exceed 30%.', order, 'Order'));
    expect(r.draft.type).toBe('bounds');
    expect(r.draft.outputs[0]?.address).toBe('B3');
    expect(r.draft.inputs.map((i) => i.address)).toEqual(['B1']);
    expect(Number(r.draft.max)).toBeCloseTo(0.3);
    expect(r.draft.min).toBe('');
  });

  it('upper bound with a percentage stored as whole points', () => {
    const r = expectCompiled(compile('Discount percentage must not exceed 30%.', orderWholePercent, 'Order'));
    expect(Number(r.draft.max)).toBe(30);
    expect(r.notes.join(' ')).toMatch(/whole percentage points/);
  });

  it('lower bound and range', () => {
    const lo = expectCompiled(compile('Subtotal must be at least 100.', freight, SAMPLE_SHEET));
    expect(lo.draft.type).toBe('bounds');
    expect(lo.draft.min).toBe('100');
    expect(lo.draft.max).toBe('');
    const between = expectCompiled(compile('Tax must be between 0 and 500.', freight, SAMPLE_SHEET));
    expect(between.draft.type).toBe('bounds');
    expect(Number(between.draft.min)).toBe(0);
    expect(Number(between.draft.max)).toBe(500);
  });

  it('explains why a typed-in constant cannot be stress-tested', () => {
    const r = compile('Tax rate must be between 0% and 25%.', freight, SAMPLE_SHEET);
    expect(r.status).toBe('needs_mapping');
    if (r.status === 'needs_mapping') {
      expect(r.questions.join(' ')).toMatch(/B19 is a typed-in value, not a formula/);
      // The limits were still understood and are carried into the draft.
      expect(Number(r.draft.max)).toBeCloseTo(0.25);
    }
  });

  it('a limit that is a calculation becomes an invariant', () => {
    const r = expectCompiled(compile('Volume rebate must not exceed 10% of subtotal.', freight, SAMPLE_SHEET));
    expect(r.draft.type).toBe('invariant');
    expect(r.draft.relation).toBe('<=');
    expect(r.draft.left).toBe('B11');
    expect(r.draft.right).toBe('10% * B10');
  });

  it('equals a sum of a range', () => {
    const r = expectCompiled(compile('Subtotal must equal the sum of B5:B9.', freight, SAMPLE_SHEET));
    expect(r.draft.type).toBe('invariant');
    expect(r.draft.left).toBe('B10');
    expect(r.draft.right).toBe('SUM(B5:B9)');
    expect(r.draft.relation).toBe('==');
  });

  it('equals a sum of named cells', () => {
    const r = expectCompiled(
      compile('Subtotal must equal the sum of base ocean freight, fuel surcharge, drayage, handling charges and other charges', freight, SAMPLE_SHEET),
    );
    expect(r.draft.right).toBe('B5 + B6 + B7 + B8 + B9');
  });

  it('equals a calculation written with words or symbols', () => {
    const words = expectCompiled(compile('Tax must equal taxable amount times tax rate.', freight, SAMPLE_SHEET));
    expect(words.draft.left).toBe('B13');
    expect(words.draft.right).toBe('B12 * B19');
    const mixed = expectCompiled(compile('Final freight cost must equal subtotal minus volume rebate plus tax.', freight, SAMPLE_SHEET));
    expect(mixed.draft.right).toBe('B10 - B11 + B13');
    const symbols = expectCompiled(compile('b14 must equal b10 - b11 + b13', freight, SAMPLE_SHEET));
    expect(symbols.draft.left).toBe('B14');
    expect(symbols.draft.right).toBe('B10 - B11 + B13');
  });

  it('conditional', () => {
    const r = expectCompiled(
      compile('If subtotal is greater than 3500 then volume rebate must be greater than 0.', freight, SAMPLE_SHEET),
    );
    expect(r.draft.type).toBe('conditional');
    expect(r.draft.when).toEqual({ left: 'B10', op: '>', right: '3500' });
    expect(r.draft.then).toEqual({ left: 'B11', op: '>', right: '0' });
    const neg = expectCompiled(
      compile('When subtotal is above 3500, volume rebate must not exceed 500', freight, SAMPLE_SHEET),
    );
    expect(neg.draft.then).toEqual({ left: 'B11', op: '<=', right: '500' });
  });
});

describe('rule compiler: honesty', () => {
  it('asks for a mapping instead of guessing when the sentence is vague', () => {
    const r = compile('Total cost must equal the sum of all cost components.', freight, SAMPLE_SHEET);
    expect(r.status).toBe('needs_mapping');
    if (r.status === 'needs_mapping') {
      expect(r.questions.join(' ')).toMatch(/does not say which cells/);
      expect(r.pattern).toBe('equals_sum');
    }
  });

  it('asks when a phrase matches no cell', () => {
    const r = compile('Increasing handling fee must never reduce final freight cost.', freight, SAMPLE_SHEET);
    expect(r.status).toBe('needs_mapping');
    if (r.status === 'needs_mapping') {
      expect(r.questions.join(' ')).toMatch(/could not find a cell labelled “handling fee”/);
      expect(r.draft.inputs[0]?.address).toBe('');
      expect(r.draft.outputs[0]?.address).toBe('B14');
    }
  });

  it('reports ambiguous labels rather than picking one', () => {
    const wb = workbookFrom('S', [
      ['A1', 'Fee'], ['B1', 5],
      ['A2', 'Fee'], ['B2', 7],
      ['A3', 'Total'], ['B3', '=B1+B2'],
    ]);
    const r = compile('Increasing fee must never reduce total.', wb, 'S');
    expect(r.status).toBe('needs_mapping');
    if (r.status === 'needs_mapping') expect(r.questions.join(' ')).toMatch(/matches more than one cell/);
  });

  it('rejects unsupported and empty sentences', () => {
    for (const text of ['', '   ', 'Tax must be calculated using the correct tax rate.', 'Make the spreadsheet better', 'x'.repeat(500)]) {
      const r = compile(text, freight, SAMPLE_SHEET);
      expect(r.status, text).toBe('unsupported');
      if (r.status === 'unsupported') expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('does not modify the workbook', () => {
    const snapshot = JSON.stringify(freight);
    compile('Increasing fuel surcharge must never reduce final freight cost.', freight, SAMPLE_SHEET);
    expect(JSON.stringify(freight)).toBe(snapshot);
  });

  it('every documented example is recognised by some pattern (never "unsupported")', () => {
    // The examples reference generic names; compile them against a workbook that has those labels.
    const wb = workbookFrom('Sheet1', [
      ['A1', 'Fuel surcharge'], ['B1', 100],
      ['A2', 'Final freight cost'], ['B2', '=B1*2'],
      ['A3', 'Total price'], ['B3', '=B4*B5'],
      ['A4', 'Quantity'], ['B4', 10],
      ['A5', 'Unit price'], ['B5', 4],
      ['A6', 'Discount'], ['B6', 0.1],
      ['A7', 'Final price'], ['B7', '=B3*(1-B6)'],
      ['A8', 'Net price'], ['B8', '=B3-B6'],
    ]);
    for (const doc of PATTERN_DOCS) {
      for (const example of doc.examples) {
        const r = compile(example, wb, 'Sheet1');
        expect(r.status, `${doc.id}: ${example}`).not.toBe('unsupported');
      }
    }
  });
});

describe('compiled drafts become valid rules that really run', () => {
  it('compile → validate → run finds the freight bug from plain English', () => {
    const r = expectCompiled(compile('Increasing fuel surcharge must never reduce final freight cost.', freight, SAMPLE_SHEET));
    const validated = draftToRule(r.draft);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.rule.source).toBe('compiler');
    // Suggested ranges come from current values; widen the fuel range so the cliff is reachable.
    const draft = { ...r.draft, inputs: r.draft.inputs.map((i) => (i.address === 'B6' ? { ...i, min: '0', max: '2000' } : i)) };
    const widened = draftToRule(draft);
    if (!widened.ok) throw new Error(widened.issues.join('; '));
    const result = runRule(freight, widened.rule, { numRuns: 1000, seed: 1031 });
    expect(result.errors).toEqual([]);
    expect(result.executed).toBe(1000);
    expect(['failed', 'passed']).toContain(result.status);
  });

  it('rule ↔ draft round trip is lossless', () => {
    const r = expectCompiled(compile('Final freight cost must equal subtotal minus volume rebate plus tax.', freight, SAMPLE_SHEET));
    const rule = draftToRule(r.draft);
    if (!rule.ok) throw new Error(rule.issues.join('; '));
    const again = draftToRule(ruleToDraft(rule.rule));
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.rule).toEqual(rule.rule);
  });
});
