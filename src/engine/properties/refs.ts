import type { CellRefModel } from '../../types/workbook';
import { expandRange, parseRange } from '../workbook/a1';
import { collectReferences, parseExpression } from '../expression/parser';
import { refKey } from '../calculation/graph';
import { ruleInputs, ruleOutputs, type Rule } from '../../schemas/rule';

const MAX_RANGE_CELLS = 60;

/** Every cell an expression reads, with ranges expanded (capped) and default sheet filled in. */
export function expressionCells(source: string, defaultSheet: string): CellRefModel[] {
  const refs = collectReferences(parseExpression(source));
  const out: CellRefModel[] = refs.cells.map((c) => ({ sheet: c.sheet ?? defaultSheet, address: c.address }));
  for (const range of refs.ranges) {
    const parsed = parseRange(`${range.from}:${range.to}`);
    if (!parsed) continue;
    for (const address of expandRange(parsed, MAX_RANGE_CELLS)) {
      out.push({ sheet: range.sheet ?? defaultSheet, address });
    }
  }
  return out;
}

export interface RuleReferences {
  inputs: CellRefModel[];
  outputs: CellRefModel[];
  /** Cells read by rule expressions (invariant and conditional rules). */
  referenced: CellRefModel[];
}

function unique(refs: CellRefModel[]): CellRefModel[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = refKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function ruleReferences(rule: Rule): RuleReferences {
  const inputs = ruleInputs(rule).map((i) => i.cell);
  const outputs: CellRefModel[] = [...ruleOutputs(rule)];
  let referenced: CellRefModel[] = [];
  if (rule.type === 'invariant') {
    referenced = [...expressionCells(rule.left, rule.sheet), ...expressionCells(rule.right, rule.sheet)];
  } else if (rule.type === 'conditional') {
    referenced = [
      ...expressionCells(rule.when.left, rule.sheet),
      ...expressionCells(rule.when.right, rule.sheet),
      ...expressionCells(rule.then.left, rule.sheet),
      ...expressionCells(rule.then.right, rule.sheet),
    ];
  }
  return { inputs, outputs, referenced: unique(referenced) };
}
