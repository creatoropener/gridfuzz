import { ruleInputs, ruleOutputs } from '../schemas/rule';
import type { Session } from './types';

export type CellMark = 'input' | 'context' | 'output' | 'path' | 'failing' | 'suspect';

/**
 * Which cells of a sheet to mark for the selected rule: its mapped inputs and outputs, and, when a
 * counterexample from the current working copy exists, the cells the analysis flagged.
 */
export function computeMarks(session: Session, fingerprint: string, sheet: string): Map<string, Set<CellMark>> {
  const marks = new Map<string, Set<CellMark>>();
  const add = (ref: { sheet: string; address: string }, mark: CellMark): void => {
    if (ref.sheet !== sheet) return;
    const set = marks.get(ref.address) ?? new Set<CellMark>();
    set.add(mark);
    marks.set(ref.address, set);
  };

  const rule = session.rules.find((r) => r.id === session.selectedRuleId);
  if (!rule) return marks;

  const inputs = ruleInputs(rule);
  const monotonic = rule.type === 'monotonic_increasing' || rule.type === 'monotonic_decreasing';
  inputs.forEach((spec, i) => add(spec.cell, monotonic && i > 0 ? 'context' : 'input'));
  for (const out of ruleOutputs(rule)) add(out, 'output');

  const result = session.results[rule.id];
  const ce = result && result.workingCopy === fingerprint ? result.counterexample : null;
  if (ce) {
    for (const ref of ce.highlight.related) add(ref, 'path');
    for (const ref of ce.highlight.suspects) add(ref, 'suspect');
    for (const ref of ce.highlight.failing) add(ref, 'failing');
  }
  return marks;
}

/** Marks for a counterexample shown in "view counterexample" mode: the same set, regardless of staleness. */
export function counterexampleMarks(session: Session, ruleId: string, sheet: string): Map<string, Set<CellMark>> {
  const marks = new Map<string, Set<CellMark>>();
  const ce = session.results[ruleId]?.counterexample;
  if (!ce) return marks;
  const add = (ref: { sheet: string; address: string }, mark: CellMark): void => {
    if (ref.sheet !== sheet) return;
    const set = marks.get(ref.address) ?? new Set<CellMark>();
    set.add(mark);
    marks.set(ref.address, set);
  };
  for (const ref of ce.highlight.inputs) add(ref, 'input');
  for (const ref of ce.highlight.outputs) add(ref, 'output');
  for (const ref of ce.highlight.related) add(ref, 'path');
  for (const ref of ce.highlight.suspects) add(ref, 'suspect');
  for (const ref of ce.highlight.failing) add(ref, 'failing');
  return marks;
}
