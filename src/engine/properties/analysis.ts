import type { CellRefModel } from '../../types/workbook';
import { formatNumber, formatSigned } from '../../utils/format';
import { refKey } from '../calculation/graph';

export interface PathNode {
  ref: CellRefModel;
  formula: string | null;
  /** Value in the run with the lower input, when numeric. */
  low: number | null;
  /** Value in the run with the higher input, when numeric. */
  high: number | null;
  /** Direct precedents of this cell that lie on the input → output path (or are the input itself). */
  precedents: CellRefModel[];
}

export interface Suspect {
  ref: CellRefModel;
  /** `confirmed`: follows directly from the calculated numbers. `suggested`: a pointer to look at. */
  level: 'confirmed' | 'suggested';
  reason: string;
}

export interface PathAnalysis {
  /** Cells whose value moved against the rule's expected direction between the two runs. */
  flagged: Set<string>;
  /** Flagged cells none of whose on-path precedents are flagged: where the reversal first appears. */
  earliest: PathNode[];
  suspects: Suspect[];
}

function delta(node: PathNode): number | null {
  return node.low !== null && node.high !== null ? node.high - node.low : null;
}

/**
 * Looks at how every cell between the input and the output changed when the input was raised.
 *
 * `direction` is the direction the output is allowed to move: +1 for a monotonic increasing rule
 * (the output must not fall), −1 for a decreasing rule.
 *
 * Only numbers that were actually calculated are used: a cell is "flagged" when it moved against
 * that direction by more than `tolerance`. This does not prove which formula is wrong — a cell can
 * legitimately move either way — which is why callers label the output as evidence, not a verdict.
 */
export function analyzePath(nodes: readonly PathNode[], direction: 1 | -1, tolerance: number): PathAnalysis {
  const byKey = new Map(nodes.map((n) => [refKey(n.ref), n]));
  const flagged = new Set<string>();
  for (const node of nodes) {
    const d = delta(node);
    if (d !== null && d * direction < -tolerance) flagged.add(refKey(node.ref));
  }

  const earliest = nodes.filter(
    (node) =>
      flagged.has(refKey(node.ref)) && !node.precedents.some((p) => flagged.has(refKey(p))),
  );

  const suspects: Suspect[] = [];
  const seen = new Set<string>();
  const add = (suspect: Suspect): void => {
    const key = `${refKey(suspect.ref)}|${suspect.level}`;
    if (seen.has(key)) return;
    seen.add(key);
    suspects.push(suspect);
  };

  for (const node of earliest) {
    add({
      ref: node.ref,
      level: 'confirmed',
      reason: `First cell on the path whose value moved against the rule (${formatNumber(node.low ?? 0)} → ${formatNumber(node.high ?? 0)}).`,
    });

    // Among the cells this one reads, the one that changed the most is the best lead.
    let lead: { node: PathNode; magnitude: number; change: number } | null = null;
    for (const p of node.precedents) {
      const pn = byKey.get(refKey(p));
      if (!pn || pn.formula === null) continue;
      const d = delta(pn);
      if (d === null || d === 0) continue;
      if (!lead || Math.abs(d) > lead.magnitude) lead = { node: pn, magnitude: Math.abs(d), change: d };
    }
    if (lead) {
      add({
        ref: lead.node.ref,
        level: 'suggested',
        reason: `Went from ${formatNumber(lead.node.low ?? 0)} to ${formatNumber(lead.node.high ?? 0)} (${formatSigned(lead.change)}), the largest change among the cells ${node.ref.address} reads. A good first place to look, not a confirmed cause.`,
      });
    }
  }
  return { flagged, earliest, suspects };
}
