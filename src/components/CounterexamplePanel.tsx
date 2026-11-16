import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ClipboardCopy, Eye, FlaskConical, Play, RotateCcw } from 'lucide-react';
import { CalcEngine, isCalcError } from '../engine/calculation/CalcEngine';
import { replayScenario } from '../engine/runRule';
import { SAMPLE_EXPLANATION, SAMPLE_FIXED_FORMULA, SAMPLE_WORKBOOK_ID } from '../engine/samples/freightQuote';
import { scenarioAssignments } from '../engine/scenarioView';
import { editableText } from '../engine/workbook/edits';
import { ruleOutputs, type Rule } from '../schemas/rule';
import { useApp } from '../state/AppContext';
import type { Counterexample, CounterexampleCell, RuleRunResult, ScenarioJson, ScalarJson } from '../types/testing';
import type { CellRefModel, WorkbookModel } from '../types/workbook';
import { formatDuration, formatInteger, formatPercent, formatScalar, formatSigned } from '../utils/format';
import { Callout, EmptyState, StatusBadge, cx } from './ui';

const ROLE_LABEL: Record<CounterexampleCell['role'], string> = {
  input: 'Input',
  context: 'Held equal',
  path: 'Calculation',
  output: 'Output',
  referenced: 'Referenced',
};

/** The rule's first output evaluated with the scenario's inputs, on a throw-away engine. */
function outputAtScenario(working: WorkbookModel, rule: Rule, scenario: ScenarioJson): { ref: CellRefModel; values: ScalarJson[] } | null {
  const ref = ruleOutputs(rule)[0];
  if (!ref) return null;
  let engine: CalcEngine;
  try {
    engine = CalcEngine.fromWorkbook(working);
  } catch {
    return null;
  }
  try {
    const runs = scenario.kind === 'pair' ? 2 : 1;
    const values: ScalarJson[] = [];
    for (let run = 0; run < runs; run++) {
      const assignments = scenarioAssignments(rule, scenario, run);
      if (!assignments) return null;
      engine.setMany(assignments.map((a) => ({ sheet: a.ref.sheet, address: a.ref.address, content: a.value })));
      const value = engine.getValue(ref.sheet, ref.address);
      values.push(isCalcError(value) ? value.display : value);
    }
    return { ref, values };
  } catch {
    return null;
  } finally {
    engine.destroy();
  }
}

function CellsTable({ ce }: { ce: Counterexample }) {
  const multi = ce.runs.length > 1;
  const app = useApp();
  return (
    <div className="table-wrap">
      <table className="table ce-table">
        <thead>
          <tr>
            <th scope="col">Cell</th>
            {ce.runs.map((r) => (
              <th key={r} scope="col" className="num-col">
                {r}
              </th>
            ))}
            {multi ? (
              <th scope="col" className="num-col">
                Change
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {ce.cells.map((c) => (
            <tr key={`${c.cell.sheet}!${c.cell.address}`} className={cx(c.movedAgainstRule && 'ce-row--flag')}>
              <th scope="row" className="ce-cell">
                <span className="ce-cell__top">
                  <button type="button" className="linkbtn mono" onClick={() => app.selectCell(c.cell)}>
                    {c.cell.address}
                  </button>
                  <span className="ce-cell__role">{ROLE_LABEL[c.role]}</span>
                </span>
                <span className="ce-cell__label">{c.label ?? ''}</span>
                {c.movedAgainstRule ? <span className="badge badge--fail">moved against the rule</span> : null}
                {c.formula ? (
                  <code className="ce-cell__formula" title={c.formula}>
                    {c.formula}
                  </code>
                ) : null}
              </th>
              {c.values.map((v, i) => (
                <td key={i} className="num num-col">
                  {formatScalar(v)}
                </td>
              ))}
              {multi ? <td className={cx('num num-col', c.delta !== null && c.delta !== 0 && (c.movedAgainstRule ? 'delta--bad' : 'delta'))}>{c.delta === null ? '—' : formatSigned(c.delta)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FixAndRetest({ result, ce, rule }: { result: RuleRunResult; ce: Counterexample; rule: Rule }) {
  const app = useApp();
  const { session, working, run } = app;

  // Offer the cells with formulas that the analysis pointed at first, then the rest of the calculation.
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ ref: CellRefModel; label: string }> = [];
    const add = (ref: CellRefModel) => {
      const key = `${ref.sheet}!${ref.address}`;
      if (seen.has(key)) return;
      const cell = ce.cells.find((c) => c.cell.sheet === ref.sheet && c.cell.address === ref.address);
      if (!cell?.formula) return;
      seen.add(key);
      out.push({ ref, label: `${ref.address}${cell.label ? ` — ${cell.label}` : ''}` });
    };
    ce.highlight.suspects.forEach(add);
    ce.highlight.failing.forEach(add);
    ce.cells.forEach((c) => add(c.cell));
    return out;
  }, [ce]);

  const [pick, setPick] = useState(0);
  const target = candidates[Math.min(pick, candidates.length - 1)];
  const currentText = useMemo(() => {
    if (!target || !working) return '';
    return editableText(working.sheets.find((s) => s.name === target.ref.sheet)?.cells[target.ref.address]);
  }, [target, working]);
  const [text, setText] = useState(currentText);
  useEffect(() => setText(currentText), [currentText, target?.ref.address]);

  if (!session || !working) return null;
  const running = run.status === 'running';
  const isSample = session.original.id === SAMPLE_WORKBOOK_ID;
  const sampleFixAvailable = isSample && candidates.some((c) => c.ref.address === 'B11');

  const apply = () => {
    if (!target) return;
    app.commitEdit(target.ref.sheet, target.ref.address, text);
    app.runRules([rule.id]);
  };

  return (
    <section className="fix" aria-labelledby="fix-title">
      <h3 id="fix-title" className="panel__h">
        Fix and retest
      </h3>
      <p className="muted">
        Edit a formula in the working copy and run this same rule again with seed <span className="num">{result.seed}</span> and {formatInteger(result.requestedRuns)} scenarios. Your original file is never changed.
      </p>
      {candidates.length === 0 ? (
        <p className="faint">None of the cells in this counterexample contain formulas. Select a cell in the grid to edit it.</p>
      ) : (
        <>
          <div className="field">
            <label className="field__label" htmlFor="fix-cell">
              Cell to change
            </label>
            <select id="fix-cell" className="select" value={Math.min(pick, candidates.length - 1)} onChange={(e) => setPick(Number(e.target.value))}>
              {candidates.map((c, i) => (
                <option key={c.ref.address} value={i}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="fix-formula">
              New formula
            </label>
            <textarea id="fix-formula" className="textarea textarea--mono" rows={2} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="row row--wrap">
            <button type="button" className="btn btn--primary" disabled={running || text.trim() === currentText.trim()} onClick={apply}>
              <Play size={13} aria-hidden="true" />
              Apply edit and rerun this rule
            </button>
            {sampleFixAvailable ? (
              <button
                type="button"
                className="btn"
                disabled={running}
                title={`Sets B11 to ${SAMPLE_FIXED_FORMULA}`}
                onClick={() => {
                  app.applySampleFix();
                  app.runRules([rule.id]);
                }}
              >
                <FlaskConical size={13} aria-hidden="true" />
                Apply this sample’s known fix
              </button>
            ) : null}
          </div>
          {sampleFixAvailable ? (
            <p className="faint">
              The known fix sets B11 to <code>{SAMPLE_FIXED_FORMULA}</code>: the rebate applies only to the part above the threshold. Typing it yourself works the same way.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function FixVerified({ rule, current, previous }: { rule: Rule; current: RuleRunResult; previous: RuleRunResult }) {
  const app = useApp();
  const { working } = app;
  const ce = previous.counterexample as Counterexample;

  const replay = useMemo(() => (working ? replayScenario(working, rule, ce.scenario) : null), [working, rule, ce]);
  const after = useMemo(() => (working ? outputAtScenario(working, rule, ce.scenario) : null), [working, rule, ce]);
  const before = ce.cells.find((c) => c.role === 'output');

  return (
    <div className="panel">
      <section className="panel__section">
        <Callout tone={current.status === 'passed' ? 'pass' : 'info'} title={current.status === 'passed' ? 'The rule now holds' : 'The rule was re-run after your edit'}>
          <p>
            Same seed ({current.seed}) and {formatInteger(current.requestedRuns)} scenarios. Before the edit {formatInteger(previous.failed)} of {formatInteger(previous.executed)} scenarios failed; now {formatInteger(current.failed)} of {formatInteger(current.executed)} do.
            {current.status === 'passed' ? ' That is evidence, not a proof: no violation turned up in the scenarios tried.' : ''}
          </p>
        </Callout>
        <div className="compare compare--wide">
          <div className="compare__col">
            <div className="faint">Before your edit</div>
            <StatusBadge status={previous.status} />
            <div className="num faint">{formatInteger(previous.failed)} failed</div>
          </div>
          <div className="compare__arrow" aria-hidden="true">→</div>
          <div className="compare__col">
            <div className="faint">Now</div>
            <StatusBadge status={current.status} />
            <div className="num faint">{formatInteger(current.failed)} failed</div>
          </div>
        </div>
      </section>

      <section className="panel__section">
        <h3 className="panel__h">The earlier counterexample, replayed</h3>
        <p className="muted">{ce.violation}</p>
        {replay?.verdict ? (
          <div className="replay">
            <div className="row">
              {replay.verdict.kind === 'pass' ? <CheckCircle2 size={15} className="replay__ok" aria-hidden="true" /> : null}
              <strong>
                {replay.verdict.kind === 'pass' ? 'Same inputs, now passes.' : replay.verdict.kind === 'fail' ? 'Same inputs, still fails.' : 'Same inputs, now inconclusive.'}
              </strong>
            </div>
            {before && after && before.values.length === after.values.length ? (
              <table className="table replay__table">
                <thead>
                  <tr>
                    <th scope="col">{before.label ?? before.cell.address}</th>
                    {ce.runs.map((r) => (
                      <th key={r} scope="col" className="num-col">
                        {r}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Before</th>
                    {before.values.map((v, i) => (
                      <td key={i} className="num num-col">
                        {formatScalar(v)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row">After</th>
                    {after.values.map((v, i) => (
                      <td key={i} className="num num-col">
                        {formatScalar(v)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            ) : null}
          </div>
        ) : replay?.errors.length ? (
          <p className="faint">The earlier scenario could not be replayed: {replay.errors[0]}</p>
        ) : null}
        <div className="row row--wrap">
          <button
            type="button"
            className="btn"
            onClick={() => {
              app.resetEdits();
              app.runRules([rule.id]);
            }}
          >
            <RotateCcw size={13} aria-hidden="true" />
            Undo edits and rerun
          </button>
          <button type="button" className="btn" onClick={() => void app.downloadWorkingCopy()}>
            Download the working copy
          </button>
        </div>
      </section>
    </div>
  );
}

export function CounterexamplePanel() {
  const app = useApp();
  const { session, working, fingerprint } = app;

  const failedRules = useMemo(() => (session ? session.rules.filter((r) => session.results[r.id]?.counterexample) : []), [session]);

  // Hooks must run in the same order every render, so everything below that needs data is guarded, not hoisted.
  const rule = session?.rules.find((r) => r.id === session.selectedRuleId) ?? null;
  const result = rule && session ? session.results[rule.id] : undefined;
  const previous = rule && session ? session.previous[rule.id] : undefined;

  if (!session || !working) return null;

  if (!rule) {
    return (
      <div className="panel">
        <section className="panel__section">
          <EmptyState title="Nothing selected">Choose a rule on the Rules tab, then run it.</EmptyState>
        </section>
      </div>
    );
  }

  const ce = result?.counterexample ?? null;

  if (result && !ce && previous?.counterexample) {
    return <FixVerified rule={rule} current={result} previous={previous} />;
  }

  if (!result || !ce) {
    return (
      <div className="panel">
        <section className="panel__section">
          {failedRules.length > 0 ? (
            <div className="field">
              <label className="field__label" htmlFor="ce-rule">
                Rule with a violation
              </label>
              <select id="ce-rule" className="select" value="" onChange={(e) => app.selectRule(e.target.value)}>
                <option value="" disabled>
                  Choose…
                </option>
                {failedRules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <EmptyState title={result ? 'No counterexample for this rule' : 'No counterexample yet'}>
            {result
              ? result.status === 'passed'
                ? 'No scenario broke this rule. That is evidence, not proof; try more scenarios or another seed.'
                : 'The rule could not be decided, so there is nothing to shrink. See the Results tab for the reasons.'
              : 'Run this rule. If a scenario breaks it, GridFuzz shrinks it to the smallest change that still fails and shows it here.'}
          </EmptyState>
          {!result ? (
            <button type="button" className="btn btn--primary" onClick={() => app.runRules([rule.id])}>
              <Play size={13} aria-hidden="true" />
              Run this rule
            </button>
          ) : null}
        </section>
      </div>
    );
  }

  const stale = result.workingCopy !== fingerprint;
  const showingScenario = app.scenarioView?.ruleId === rule.id;
  const confirmed = ce.findings.filter((f) => f.level === 'confirmed');
  const suggested = ce.findings.filter((f) => f.level === 'suggested');
  const isSample = session.original.id === SAMPLE_WORKBOOK_ID;

  const viewInGrid = () => {
    const out = ce.highlight.outputs[0];
    if (out) app.setActiveSheet(out.sheet);
    app.setScenarioView(showingScenario ? null : { ruleId: rule.id, run: 0 });
    app.setMobilePane('grid');
  };

  return (
    <div className="panel">
      <section className="panel__section">
        {failedRules.length > 1 ? (
          <div className="field">
            <label className="field__label" htmlFor="ce-rule">
              Rule
            </label>
            <select id="ce-rule" className="select" value={rule.id} onChange={(e) => app.selectRule(e.target.value)}>
              {failedRules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="ce-rule">{rule.name}</div>
        )}
        {stale ? (
          <Callout tone="warn" title="This counterexample is from before your latest edit">
            Run the rule again to check the current working copy.
          </Callout>
        ) : null}
        <Callout tone="fail" title="Counterexample found">
          {ce.violation}
        </Callout>
        <dl className="facts">
          <div>
            <dt>Expected</dt>
            <dd>{ce.expected}</dd>
          </div>
          <div>
            <dt>Actual</dt>
            <dd>{ce.actual}</dd>
          </div>
          {ce.difference !== null ? (
            <div>
              <dt>Difference</dt>
              <dd className="num">{formatSigned(ce.difference)}</dd>
            </div>
          ) : null}
          <div>
            <dt>How often</dt>
            <dd className="num">
              {formatInteger(result.failed)} of {formatInteger(result.executed)} scenarios failed ({formatPercent(result.failureRate)}); first at scenario {result.firstFailureAt ?? '?'}
            </dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd className="num">
              {ce.seed} · {formatDuration(result.durationMs)}
            </dd>
          </div>
          {result.shrink ? (
            <div>
              <dt>Shrinking</dt>
              <dd>
                <span className="num">{formatInteger(result.shrink.steps)}</span> steps (<span className="num">{formatInteger(result.shrink.evaluations)}</span> checks) reduced the failing scenario to the smallest change from your current values.
                {result.shrink.reproducible ? '' : ' The second pass did not reproduce the exact first failure, so this counterexample may differ from the first one found.'}
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="row row--wrap">
          <button type="button" className={cx('btn', showingScenario && 'btn--on')} aria-pressed={showingScenario} onClick={viewInGrid}>
            <Eye size={13} aria-hidden="true" />
            {showingScenario ? 'Hide counterexample' : 'View counterexample'}
          </button>
          <button type="button" className="btn" onClick={() => void app.copyCounterexample(rule.id)}>
            <ClipboardCopy size={13} aria-hidden="true" />
            Copy counterexample
          </button>
        </div>
      </section>

      <section className="panel__section">
        <h3 className="panel__h">Cells involved</h3>
        <CellsTable ce={ce} />
      </section>

      <section className="panel__section">
        <h3 className="panel__h">What the test can tell you</h3>
        <ul className="findings">
          {confirmed.map((f, i) => (
            <li key={`c${i}`}>
              <span className="badge badge--accent">Confirmed</span>
              <span>{f.text}</span>
            </li>
          ))}
          {suggested.map((f, i) => (
            <li key={`s${i}`}>
              <span className="badge badge--suggested">Suggested</span>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
        <p className="faint">Confirmed findings were observed in the counterexample itself. Suggested ones are leads worth checking; they are not proof of the cause.</p>
        {isSample ? (
          <details className="authornote">
            <summary>About this sample’s bug (written by the authors, not derived by the test)</summary>
            <p>{SAMPLE_EXPLANATION}</p>
          </details>
        ) : null}
      </section>

      <FixAndRetest result={result} ce={ce} rule={rule} />
    </div>
  );
}
