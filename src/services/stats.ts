import type { RuleRunResult } from '../types/testing';
import { readJson, writeJson } from './storage';

/** Dashboard statistics. Every number is accumulated from real runs in this browser; nothing is seeded. */
export interface Stats {
  /** Ids of workbooks that have had at least one completed test run. */
  testedWorkbooks: string[];
  rulesCreated: number;
  passedTests: number;
  failedTests: number;
  inconclusiveTests: number;
  scenariosExecuted: number;
}

export interface RecentWorkbook {
  id: string;
  name: string;
  sizeBytes: number;
  source: 'upload' | 'sample';
  openedAt: string;
}

export interface ActivityEntry {
  at: string;
  kind: 'opened' | 'rule' | 'run' | 'fix';
  text: string;
  status?: 'passed' | 'failed' | 'inconclusive';
}

export const EMPTY_STATS: Stats = {
  testedWorkbooks: [],
  rulesCreated: 0,
  passedTests: 0,
  failedTests: 0,
  inconclusiveTests: 0,
  scenariosExecuted: 0,
};

const MAX_RECENT = 8;
const MAX_ACTIVITY = 25;

const isStats = (v: unknown): v is Stats =>
  typeof v === 'object' &&
  v !== null &&
  Array.isArray((v as Stats).testedWorkbooks) &&
  typeof (v as Stats).rulesCreated === 'number' &&
  typeof (v as Stats).passedTests === 'number' &&
  typeof (v as Stats).failedTests === 'number';

export function loadStats(): Stats {
  return { ...EMPTY_STATS, ...readJson<Stats>('stats', EMPTY_STATS, isStats) };
}
export function loadRecent(): RecentWorkbook[] {
  return readJson<RecentWorkbook[]>('recent', [], Array.isArray as (v: unknown) => v is RecentWorkbook[]);
}
export function loadActivity(): ActivityEntry[] {
  return readJson<ActivityEntry[]>('activity', [], Array.isArray as (v: unknown) => v is ActivityEntry[]);
}

export function recordRulesCreated(stats: Stats, count: number): Stats {
  const next = { ...stats, rulesCreated: stats.rulesCreated + count };
  writeJson('stats', next);
  return next;
}

/** Folds completed rule runs into the statistics. Cancelled or unrunnable rules (0 executed) do not count. */
export function recordRun(stats: Stats, workbookId: string, results: readonly RuleRunResult[]): Stats {
  const counted = results.filter((r) => r.executed > 0);
  if (counted.length === 0) return stats;
  const next: Stats = {
    testedWorkbooks: stats.testedWorkbooks.includes(workbookId) ? stats.testedWorkbooks : [...stats.testedWorkbooks, workbookId],
    rulesCreated: stats.rulesCreated,
    passedTests: stats.passedTests + counted.filter((r) => r.status === 'passed').length,
    failedTests: stats.failedTests + counted.filter((r) => r.status === 'failed').length,
    inconclusiveTests: stats.inconclusiveTests + counted.filter((r) => r.status === 'inconclusive').length,
    scenariosExecuted: stats.scenariosExecuted + counted.reduce((sum, r) => sum + r.executed, 0),
  };
  writeJson('stats', next);
  return next;
}

export function pushRecent(list: RecentWorkbook[], entry: RecentWorkbook): RecentWorkbook[] {
  const next = [entry, ...list.filter((r) => r.id !== entry.id)].slice(0, MAX_RECENT);
  writeJson('recent', next);
  return next;
}

export function pushActivity(list: ActivityEntry[], entry: Omit<ActivityEntry, 'at'>): ActivityEntry[] {
  const next = [{ ...entry, at: new Date().toISOString() }, ...list].slice(0, MAX_ACTIVITY);
  writeJson('activity', next);
  return next;
}

export function clearAll(): { stats: Stats; recent: RecentWorkbook[]; activity: ActivityEntry[] } {
  writeJson('stats', EMPTY_STATS);
  writeJson('recent', []);
  writeJson('activity', []);
  return { stats: EMPTY_STATS, recent: [], activity: [] };
}
