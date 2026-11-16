import { describe, expect, it } from 'vitest';
import { runRule } from '../src/engine/runRule';
import {
  SAMPLE_FAULTY_CELL,
  SAMPLE_FIXED_FORMULA,
  SAMPLE_FLAGSHIP_RULE_ID,
  buildFreightRules,
  buildFreightWorkbook,
} from '../src/engine/samples/freightQuote';
import { applyEdits } from '../src/engine/workbook/edits';
import { REPORT_FORMAT, buildReport, counterexampleText, reportFileName } from '../src/services/report';
import { EMPTY_STATS, recordRun } from '../src/services/stats';
import { formatNumber, formatSigned, formatPercent, formatDuration, formatBytes } from '../src/utils/format';

const config = { numRuns: 400, seed: 1031 };
const workbook = buildFreightWorkbook();
const rules = buildFreightRules();
const results = rules.map((r) => runRule(workbook, r, config));

describe('report export', () => {
  const report = buildReport({ workbook, edits: [], rules, results, config, appVersion: '9.9.9', now: new Date('2026-11-13T00:00:00Z') });

  it('summarises exactly what ran, with consistent totals', () => {
    expect(report.format).toBe(REPORT_FORMAT);
    expect(report.tool).toMatchObject({ name: 'GridFuzz', version: '9.9.9' });
    expect(report.tool.hyperformula).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.generatedAt).toBe('2026-11-13T00:00:00.000Z');
    const s = report.summary;
    expect(s.rules).toBe(rules.length);
    expect(s.rulesPassed + s.rulesFailed + s.rulesInconclusive).toBe(s.rules);
    expect(s.passed + s.failed + s.inconclusive).toBe(s.scenariosExecuted);
    expect(s.scenariosExecuted).toBe(results.reduce((n, r) => n + r.executed, 0));
    expect(s.rulesFailed).toBe(1);
    expect(s.failureRate).toBeCloseTo(s.failed / s.scenariosExecuted, 12);
    expect(report.workingCopy).toEqual({ edited: false, edits: [] });
  });

  it('survives a JSON round trip unchanged (it is valid, complete JSON)', () => {
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(parsed).toEqual(report);
    const failed = parsed.results.find((r) => r.ruleId === SAMPLE_FLAGSHIP_RULE_ID)!;
    expect(failed.counterexample?.scenario.kind).toBe('pair');
    expect(failed.seed).toBe(1031);
  });

  it('records the formula edits that made up the working copy', () => {
    const edits = [{ sheet: 'Quote', address: SAMPLE_FAULTY_CELL, content: SAMPLE_FIXED_FORMULA }];
    const fixed = applyEdits(workbook, edits);
    const flagship = rules.find((r) => r.id === SAMPLE_FLAGSHIP_RULE_ID)!;
    const after = runRule(fixed, flagship, config, { edits });
    const r = buildReport({ workbook, edits, rules: [flagship], results: [after], config, appVersion: '1' });
    expect(r.workingCopy.edited).toBe(true);
    expect(r.workingCopy.edits).toEqual(edits);
    expect(r.summary.rulesPassed).toBe(1);
  });

  it('produces a readable counterexample for the clipboard', () => {
    const failed = results.find((r) => r.status === 'failed')!;
    const text = counterexampleText(failed, failed.counterexample!);
    expect(text).toContain('Seed 1031');
    expect(text).toContain('Violation: Raising Fuel surcharge (B6)');
    expect(text).toMatch(/output\s+Quote!B14 \(Final freight cost\):/);
    expect(text).toContain('[confirmed]');
    expect(text).toContain('[suggested]');
  });

  it('names files safely', () => {
    expect(reportFileName('My Quote (v2).xlsx', new Date('2026-11-13T10:00:00Z'))).toBe('gridfuzz-report-My-Quote-v2-2026-11-13.json');
    expect(reportFileName('', new Date('2026-11-13T10:00:00Z'))).toBe('gridfuzz-report-workbook-2026-11-13.json');
  });
});

describe('dashboard statistics come only from real runs', () => {
  it('starts empty and counts only rules that actually executed', () => {
    expect(EMPTY_STATS).toMatchObject({ rulesCreated: 0, passedTests: 0, failedTests: 0, scenariosExecuted: 0, testedWorkbooks: [] });
    const unrunnable = runRule(workbook, { type: 'bounds' }, config); // invalid rule: executed = 0
    expect(recordRun(EMPTY_STATS, 'w', [unrunnable])).toBe(EMPTY_STATS);

    const stats = recordRun(EMPTY_STATS, 'sample', results);
    expect(stats.testedWorkbooks).toEqual(['sample']);
    expect(stats.failedTests).toBe(1);
    expect(stats.passedTests).toBe(results.length - 1);
    expect(stats.scenariosExecuted).toBe(results.reduce((n, r) => n + r.executed, 0));
    const twice = recordRun(stats, 'sample', results);
    expect(twice.testedWorkbooks).toEqual(['sample']); // distinct workbooks
    expect(twice.failedTests).toBe(2);
  });
});

describe('number formatting', () => {
  it('is deterministic and never prints negative zero', () => {
    expect(formatNumber(1234567.891)).toBe('1,234,567.891');
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(-0.0000001)).toBe('0');
    expect(formatNumber(3815)).toBe('3,815');
    expect(formatSigned(-189.71)).toBe('−189.71');
    expect(formatSigned(5)).toBe('+5');
    expect(formatSigned(0)).toBe('0');
    expect(formatPercent(0.0125)).toBe('1.3%');
    expect(formatDuration(282)).toBe('282 ms');
    expect(formatDuration(2500)).toBe('2.50 s');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});
