import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, FileJson, Play } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { INCONCLUSIVE_REASONS, type InconclusiveReason, type RuleRunResult } from '../types/testing';
import { formatDuration, formatInteger, formatPercent } from '../utils/format';
import { EmptyState, StatusBadge, cx } from './ui';

export const REASON_LABEL: Record<InconclusiveReason, string> = {
  calc_error: 'Calculation error',
  division_by_zero: 'Division by zero',
  circular_reference: 'Circular reference',
  invalid_reference: 'Invalid reference',
  unsupported_function: 'Unsupported function',
  missing_value: 'Missing value',
  non_numeric: 'Non-numeric result',
  non_finite_result: 'Result is not a finite number',
  precondition_not_met: 'Condition not met (not a failure)',
  engine_error: 'Engine error',
};

function short(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function ResultsPanel() {
  const app = useApp();
  const { session, fingerprint, run } = app;
  if (!session) return null;

  const results = session.rules.map((r) => session.results[r.id]).filter((r): r is RuleRunResult => Boolean(r));
  const running = run.status === 'running';

  if (results.length === 0) {
    return (
      <div className="panel">
        <section className="panel__section">
          <EmptyState
            title="No results yet"
            action={
              <button type="button" className="btn btn--primary" disabled={running || session.rules.length === 0} onClick={() => app.runRules()}>
                <Play size={13} aria-hidden="true" />
                Run all rules
              </button>
            }
          >
            {session.rules.length === 0 ? 'Add a rule first, then run it. Results appear here with the scenarios, failures and timing of the real run.' : 'Run your rules to see how many scenarios passed, failed or could not be decided.'}
          </EmptyState>
        </section>
      </div>
    );
  }

  const totals = results.reduce(
    (t, r) => ({
      executed: t.executed + r.executed,
      failed: t.failed + r.failed,
      inconclusive: t.inconclusive + r.inconclusive,
      duration: t.duration + r.durationMs,
    }),
    { executed: 0, failed: 0, inconclusive: 0, duration: 0 },
  );
  const rulesFailed = results.filter((r) => r.status === 'failed').length;
  const rulesPassed = results.filter((r) => r.status === 'passed').length;
  const rulesInconclusive = results.length - rulesFailed - rulesPassed;
  const chart = results.map((r) => ({ name: short(r.ruleName), full: r.ruleName, passed: r.passed, failed: r.failed, inconclusive: r.inconclusive }));

  return (
    <div className="panel">
      <section className="panel__section">
        <h3 className="panel__h">Latest run</h3>
        <dl className="totals">
          <div>
            <dt>Rules</dt>
            <dd className="num">{results.length}</dd>
          </div>
          <div>
            <dt>No violation</dt>
            <dd className="num">{rulesPassed}</dd>
          </div>
          <div>
            <dt>Violation</dt>
            <dd className={cx('num', rulesFailed > 0 && 'totals__fail')}>{rulesFailed}</dd>
          </div>
          <div>
            <dt>Inconclusive</dt>
            <dd className="num">{rulesInconclusive}</dd>
          </div>
          <div>
            <dt>Scenarios</dt>
            <dd className="num">{formatInteger(totals.executed)}</dd>
          </div>
          <div>
            <dt>Failure rate</dt>
            <dd className="num">{totals.executed > 0 ? formatPercent(totals.failed / totals.executed) : '—'}</dd>
          </div>
        </dl>
        <p className="faint totals__note">
          {formatDuration(totals.duration)} in total. “No violation” means none turned up in the scenarios tried, which is evidence rather than proof.
        </p>
      </section>

      <section className="panel__section">
        <h3 className="panel__h">Scenario outcomes by rule</h3>
        <div className="chart" role="img" aria-label={`Stacked bars of passed, failed and inconclusive scenarios for ${results.length} rules. The table below has the same numbers.`}>
          <ResponsiveContainer width="100%" height={Math.max(110, chart.length * 38 + 44)}>
            <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid horizontal={false} stroke="var(--line)" />
              <XAxis type="number" tick={{ fill: 'var(--text-3)', fontSize: 11 }} stroke="var(--line-strong)" allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={156} tick={{ fill: 'var(--text-2)', fontSize: 11 }} stroke="var(--line-strong)" />
              <Tooltip
                cursor={{ fill: 'var(--surface-3)' }}
                contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)', borderRadius: 6, fontSize: 12, color: 'var(--text)' }}
                labelFormatter={(_label, payload) => (payload?.[0]?.payload as { full?: string } | undefined)?.full ?? ''}
              />
              <Bar dataKey="passed" name="Passed" stackId="a" fill="var(--pass)" isAnimationActive={false} />
              <Bar dataKey="inconclusive" name="Inconclusive" stackId="a" fill="var(--warn)" isAnimationActive={false} />
              <Bar dataKey="failed" name="Failed" stackId="a" fill="var(--fail)" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="panel__section">
        <h3 className="panel__h">By rule</h3>
        <ul className="results">
          {results.map((r) => {
            const prev = session.previous[r.ruleId];
            const stale = r.workingCopy !== fingerprint;
            const reasons = INCONCLUSIVE_REASONS.filter((k) => (r.inconclusiveReasons[k] ?? 0) > 0);
            return (
              <li key={r.ruleId} className="result">
                <div className="result__head">
                  <StatusBadge status={r.status} stale={stale} />
                  <span className="result__name">{r.ruleName}</span>
                </div>
                <div className="result__stats num">
                  {formatInteger(r.executed)} of {formatInteger(r.requestedRuns)} scenarios · {formatInteger(r.failed)} failed{r.executed > 0 ? ` (${formatPercent(r.failureRate)})` : ''} · {formatInteger(r.inconclusive)} inconclusive · {formatDuration(r.durationMs)} · seed {r.seed}
                </div>
                {r.interrupted ? <div className="result__warn">Stopped at the time limit after {formatInteger(r.executed)} of {formatInteger(r.requestedRuns)} scenarios.</div> : null}
                {r.errors.map((e) => (
                  <div key={e} className="result__err">
                    {e}
                  </div>
                ))}
                {r.warnings.map((w) => (
                  <div key={w} className="result__warn">
                    {w}
                  </div>
                ))}
                {reasons.length > 0 ? (
                  <ul className="reasons">
                    {reasons.map((k) => (
                      <li key={k}>
                        <strong>{formatInteger(r.inconclusiveReasons[k] ?? 0)}</strong> {REASON_LABEL[k]}
                        {r.inconclusiveSamples[k] ? <span className="faint"> — {r.inconclusiveSamples[k]}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {prev && prev.workingCopy !== r.workingCopy ? (
                  <div className="compare">
                    <div className="compare__col">
                      <div className="faint">Before your edit</div>
                      <StatusBadge status={prev.status} />
                      <div className="num faint">
                        {formatInteger(prev.failed)} of {formatInteger(prev.executed)} failed
                      </div>
                    </div>
                    <div className="compare__arrow" aria-hidden="true">→</div>
                    <div className="compare__col">
                      <div className="faint">Now</div>
                      <StatusBadge status={r.status} stale={stale} />
                      <div className="num faint">
                        {formatInteger(r.failed)} of {formatInteger(r.executed)} failed
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="row result__actions">
                  {r.status === 'failed' ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        app.selectRule(r.ruleId);
                        app.setRightTab('counterexample');
                      }}
                    >
                      View counterexample
                    </button>
                  ) : null}
                  <button type="button" className="btn btn--sm btn--ghost" disabled={running} onClick={() => app.runRules([r.ruleId])}>
                    <Play size={11} aria-hidden="true" />
                    Rerun
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel__section">
        <h3 className="panel__h">Take it with you</h3>
        <div className="row row--wrap">
          <button type="button" className="btn" onClick={app.exportReport}>
            <FileJson size={13} aria-hidden="true" />
            Export JSON report
          </button>
          <button type="button" className="btn" onClick={() => void app.downloadOriginal()}>
            <Download size={13} aria-hidden="true" />
            Download original workbook
          </button>
          <button type="button" className="btn" disabled={running} onClick={() => app.runRules()}>
            <Play size={13} aria-hidden="true" />
            Rerun all
          </button>
        </div>
        <p className="faint">The original is the file you opened, byte for byte. Edits live only in the working copy.</p>
      </section>
    </div>
  );
}
