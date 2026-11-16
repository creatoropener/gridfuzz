import type { Rule } from '../schemas/rule';
import type { RuleRunResult, TestConfig } from './testing';
import type { CellEdit, WorkbookModel } from './workbook';

/** Messages from the page to the test worker. */
export type WorkerRequest = {
  type: 'run';
  /** Echoed back on every response so the page can ignore stale runs. */
  runId: number;
  /** The ORIGINAL workbook; the worker applies `edits` itself so the page never sends a modified copy. */
  workbook: WorkbookModel;
  edits: CellEdit[];
  rules: Rule[];
  config: TestConfig;
};

/** Messages from the test worker to the page. */
export type WorkerResponse =
  | { type: 'rule-start'; runId: number; ruleId: string; index: number; total: number }
  | { type: 'progress'; runId: number; ruleId: string; executed: number; requested: number }
  | { type: 'rule-result'; runId: number; result: RuleRunResult }
  | { type: 'done'; runId: number }
  | { type: 'error'; runId: number; message: string };
