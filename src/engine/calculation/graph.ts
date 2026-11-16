import type { CellRefModel } from '../../types/workbook';
import type { CalcEngine } from './CalcEngine';

export function refKey(ref: CellRefModel): string {
  return `${ref.sheet}!${ref.address}`;
}

export interface PrecedentGraph {
  root: CellRefModel;
  nodes: Map<string, CellRefModel>;
  /** key → direct precedents. Only nodes that were expanded have an entry. */
  precedents: Map<string, CellRefModel[]>;
  /** True when the graph was cut at `maxNodes`. */
  truncated: boolean;
}

/** Breadth-first closure of everything the `root` cell's value depends on. */
export function buildPrecedentGraph(engine: CalcEngine, root: CellRefModel, maxNodes = 600): PrecedentGraph {
  const nodes = new Map<string, CellRefModel>([[refKey(root), root]]);
  const precedents = new Map<string, CellRefModel[]>();
  const queue: CellRefModel[] = [root];
  let truncated = false;

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (!current) continue;
    const direct = engine.getPrecedents(current.sheet, current.address);
    precedents.set(refKey(current), direct);
    for (const p of direct) {
      const key = refKey(p);
      if (nodes.has(key)) continue;
      if (nodes.size >= maxNodes) {
        truncated = true;
        continue;
      }
      nodes.set(key, p);
      queue.push(p);
    }
  }
  return { root, nodes, precedents, truncated };
}

/** True when `output` is (transitively) calculated from `input`. */
export function dependsOn(engine: CalcEngine, output: CellRefModel, input: CellRefModel): boolean {
  return buildPrecedentGraph(engine, output).nodes.has(refKey(input));
}

export interface DependencyPath {
  /** Cells that depend on `input` and feed `output` (output included, input excluded), ordered input → output. */
  cells: CellRefModel[];
  /** key → precedents of that cell that are themselves on the path or are the input. */
  inPathPrecedents: Map<string, CellRefModel[]>;
  truncated: boolean;
}

/**
 * Every cell lying on some dependency path from `input` to `output`.
 * Built only from the precedent information the engine reports.
 */
export function dependencyPath(engine: CalcEngine, input: CellRefModel, output: CellRefModel): DependencyPath {
  const graph = buildPrecedentGraph(engine, output);
  const inputKey = refKey(input);
  if (!graph.nodes.has(inputKey)) return { cells: [], inPathPrecedents: new Map(), truncated: graph.truncated };

  // Reverse edges, restricted to the closure of the output.
  const dependents = new Map<string, string[]>();
  for (const [key, preds] of graph.precedents) {
    for (const p of preds) {
      const pk = refKey(p);
      if (!graph.nodes.has(pk)) continue;
      dependents.set(pk, [...(dependents.get(pk) ?? []), key]);
    }
  }

  // Breadth-first walk from the input along dependents gives path membership and a level for ordering.
  const level = new Map<string, number>([[inputKey, 0]]);
  const queue = [inputKey];
  for (let head = 0; head < queue.length; head++) {
    const key = queue[head];
    if (key === undefined) continue;
    const base = level.get(key) ?? 0;
    for (const dep of dependents.get(key) ?? []) {
      if (!level.has(dep)) {
        level.set(dep, base + 1);
        queue.push(dep);
      }
    }
  }

  const pathKeys = [...level.keys()].filter((k) => k !== inputKey);
  pathKeys.sort((a, b) => (level.get(a) ?? 0) - (level.get(b) ?? 0) || a.localeCompare(b));
  const cells = pathKeys.map((k) => graph.nodes.get(k)).filter((c): c is CellRefModel => c !== undefined);

  const member = new Set<string>([inputKey, ...pathKeys]);
  const inPathPrecedents = new Map<string, CellRefModel[]>();
  for (const key of pathKeys) {
    inPathPrecedents.set(
      key,
      (graph.precedents.get(key) ?? []).filter((p) => member.has(refKey(p))),
    );
  }
  return { cells, inPathPrecedents, truncated: graph.truncated };
}

/** Formula cells that feed `output`, nearest first, excluding the output itself. */
export function relatedFormulaCells(engine: CalcEngine, output: CellRefModel, cap = 12): CellRefModel[] {
  const graph = buildPrecedentGraph(engine, output);
  const rootKey = refKey(output);
  const out: CellRefModel[] = [];
  for (const [key, ref] of graph.nodes) {
    if (key === rootKey) continue;
    if (engine.getFormula(ref.sheet, ref.address) === null) continue;
    out.push(ref);
    if (out.length >= cap) break;
  }
  return out;
}
