import type { Rule } from '../schemas/rule';
import type { RuleRunResult, TestConfig } from '../types/testing';
import type { CellEdit, CellRefModel, WorkbookModel } from '../types/workbook';

export type View = 'dashboard' | 'import' | 'workspace';
export type RightTab = 'rules' | 'results' | 'counterexample';
/** On narrow screens only one pane is visible at a time. */
export type MobilePane = 'workbook' | 'grid' | 'tests';

export interface Session {
  /** Exactly as imported. Never modified; all changes live in `edits`. */
  original: WorkbookModel;
  /** The bytes of the uploaded file, kept in memory so the unchanged original can be downloaded. */
  originalBytes: ArrayBuffer | null;
  edits: CellEdit[];
  rules: Rule[];
  config: TestConfig;
  activeSheet: string;
  selected: CellRefModel | null;
  selectedRuleId: string | null;
  /** Latest result per rule. */
  results: Record<string, RuleRunResult>;
  /** The result a rule had before its latest run on a different working copy (for before/after). */
  previous: Record<string, RuleRunResult>;
  /** Rules, settings or edits changed since the last Save. */
  dirty: boolean;
  /** Rules and edits were loaded from a previous Save. */
  restored: boolean;
}

export interface PendingImport {
  workbook: WorkbookModel;
  bytes: ArrayBuffer;
  sheet: string;
}

export type ImportState =
  | { status: 'idle' }
  | { status: 'reading'; fileName: string }
  | { status: 'error'; fileName: string; message: string }
  | { status: 'ready'; pending: PendingImport };

export interface RunState {
  status: 'idle' | 'running';
  total: number;
  finished: number;
  currentRuleId: string | null;
  progress: { executed: number; requested: number } | null;
  error: string | null;
}

export const IDLE_RUN: RunState = { status: 'idle', total: 0, finished: 0, currentRuleId: null, progress: null, error: null };

export interface ScenarioView {
  ruleId: string;
  /** 0 = lower input, 1 = higher input for before/after pairs. */
  run: number;
}

export interface ToastMessage {
  id: number;
  tone: 'info' | 'pass' | 'fail';
  text: string;
}

export interface SavedWorkspace {
  rules: unknown[];
  config: TestConfig;
  edits: CellEdit[];
  savedAt: string;
}
