import type { Rule } from '../schemas/rule';
import type { Counterexample, RuleRunResult, TestConfig } from '../types/testing';
import type { CellEdit, WorkbookModel } from '../types/workbook';
import { formatNumber, formatPercent, formatScalar } from '../utils/format';
import { CalcEngine } from '../engine/calculation/CalcEngine';
import { FAST_CHECK_VERSION } from '../engine/properties';

export const REPORT_FORMAT = 'gridfuzz-report/1';

export interface TestReport {
  format: typeof REPORT_FORMAT;
  tool: { name: 'GridFuzz'; version: string; hyperformula: string; fastCheck: string };
  generatedAt: string;
  workbook: {
    name: string;
    source: 'upload' | 'sample';
    sizeBytes: number;
    sheets: Array<{ name: string; rows: number; columns: number }>;
  };
  /** Formula/value edits made in the test workspace. The original file is never changed. */
  workingCopy: { edited: boolean; edits: CellEdit[] };
  config: TestConfig;
  summary: {
    rules: number;
    rulesPassed: number;
    rulesFailed: number;
    rulesInconclusive: number;
    scenariosExecuted: number;
    passed: number;
    failed: number;
    inconclusive: number;
    durationMs: number;
    failureRate: number;
  };
  rules: Rule[];
  results: RuleRunResult[];
}

export function buildReport(args: {
  workbook: WorkbookModel;
  edits: readonly CellEdit[];
  rules: readonly Rule[];
  results: readonly RuleRunResult[];
  config: TestConfig;
  appVersion: string;
  now?: Date;
}): TestReport {
  const { workbook, edits, rules, results, config } = args;
  const executed = results.reduce((s, r) => s + r.executed, 0);
  const failed = results.reduce((s, r) => s + r.failed, 0);
  return {
    format: REPORT_FORMAT,
    tool: {
      name: 'GridFuzz',
      version: args.appVersion,
      hyperformula: CalcEngine.hyperFormulaVersion,
      fastCheck: FAST_CHECK_VERSION,
    },
    generatedAt: (args.now ?? new Date()).toISOString(),
    workbook: {
      name: workbook.name,
      source: workbook.source,
      sizeBytes: workbook.sizeBytes,
      sheets: workbook.sheets.map((s) => ({ name: s.name, rows: s.rowCount, columns: s.colCount })),
    },
    workingCopy: { edited: edits.length > 0, edits: [...edits] },
    config,
    summary: {
      rules: results.length,
      rulesPassed: results.filter((r) => r.status === 'passed').length,
      rulesFailed: results.filter((r) => r.status === 'failed').length,
      rulesInconclusive: results.filter((r) => r.status === 'inconclusive').length,
      scenariosExecuted: executed,
      passed: results.reduce((s, r) => s + r.passed, 0),
      failed,
      inconclusive: results.reduce((s, r) => s + r.inconclusive, 0),
      durationMs: results.reduce((s, r) => s + r.durationMs, 0),
      failureRate: executed > 0 ? failed / executed : 0,
    },
    rules: [...rules],
    results: [...results],
  };
}

/** Plain-text description of a counterexample, for the clipboard or a bug report. */
export function counterexampleText(result: RuleRunResult, ce: Counterexample): string {
  const lines: string[] = [];
  lines.push(`GridFuzz counterexample: ${result.ruleName}`);
  lines.push(`Seed ${ce.seed} · found at scenario ${result.firstFailureAt ?? '?'} of ${result.executed}`);
  if (result.shrink) {
    lines.push(`Shrunk in ${result.shrink.steps} steps (${result.shrink.evaluations} evaluations)`);
  }
  lines.push('');
  lines.push(`Violation: ${ce.violation}`);
  lines.push(`Expected: ${ce.expected}`);
  lines.push(`Actual: ${ce.actual}`);
  if (ce.difference !== null) lines.push(`Difference: ${formatNumber(ce.difference)}`);
  lines.push('');
  lines.push(`Cells (${ce.runs.join(' → ')}):`);
  for (const cell of ce.cells) {
    const values = cell.values.map(formatScalar).join(' → ');
    const formula = cell.formula ? `  ${cell.formula}` : '';
    lines.push(`  ${cell.role.padEnd(9)} ${cell.cell.sheet}!${cell.cell.address}${cell.label ? ` (${cell.label})` : ''}: ${values}${formula}`);
  }
  lines.push('');
  lines.push('Findings:');
  for (const f of ce.findings) lines.push(`  [${f.level}] ${f.text}`);
  lines.push('');
  lines.push(`Failure rate: ${formatPercent(result.failureRate)} (${result.failed} of ${result.executed})`);
  return lines.join('\n');
}

export function reportFileName(workbookName: string, now = new Date()): string {
  const base = workbookName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workbook';
  return `gridfuzz-report-${base}-${now.toISOString().slice(0, 10)}.json`;
}

export function downloadBlob(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
