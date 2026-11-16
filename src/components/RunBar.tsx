import { useEffect, useState } from 'react';
import { Dices, Play, Square } from 'lucide-react';
import { MAX_RUNS, MIN_RUNS, TestConfigSchema } from '../schemas/rule';
import { useApp } from '../state/AppContext';
import { formatInteger } from '../utils/format';

const PRESETS = [100, 1000, 5000];

export function RunBar() {
  const app = useApp();
  const { session, run } = app;
  const config = session?.config;
  const preset = config ? PRESETS.includes(config.numRuns) : true;
  const [custom, setCustom] = useState(preset ? '' : String(config?.numRuns ?? ''));
  const [seedText, setSeedText] = useState(String(config?.seed ?? ''));
  const [customMode, setCustomMode] = useState(!preset);

  useEffect(() => {
    if (!config) return;
    setSeedText(String(config.seed));
    if (PRESETS.includes(config.numRuns)) {
      setCustom('');
    } else {
      setCustom(String(config.numRuns));
      setCustomMode(true);
    }
  }, [config?.seed, config?.numRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session || !config) return null;
  const running = run.status === 'running';

  const runsProblem = (() => {
    if (!customMode) return null;
    const n = Number(custom);
    const parsed = TestConfigSchema.shape.numRuns.safeParse(custom.trim() === '' ? Number.NaN : n);
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Enter a whole number');
  })();
  const seedProblem = (() => {
    const parsed = TestConfigSchema.shape.seed.safeParse(seedText.trim() === '' ? Number.NaN : Number(seedText));
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Enter a whole number');
  })();

  const pct = run.progress && run.progress.requested > 0 ? Math.min(100, (run.progress.executed / run.progress.requested) * 100) : 0;
  const overall = run.total > 0 ? Math.min(100, ((run.finished + pct / 100) / run.total) * 100) : 0;
  const currentName = session.rules.find((r) => r.id === run.currentRuleId)?.name;

  return (
    <div className="runbar">
      {running ? (
        <div className="runbar__progress" role="status" aria-live="polite">
          <div className="row row--between">
            <span className="runbar__title">
              Testing rule {Math.min(run.finished + 1, run.total)} of {run.total}
            </span>
            <button type="button" className="btn btn--sm btn--danger" onClick={app.cancelRun}>
              <Square size={12} aria-hidden="true" />
              Cancel
            </button>
          </div>
          <div className="runbar__rule" title={currentName}>
            {currentName ?? 'Starting…'}
            {run.progress ? <span className="faint num"> · {formatInteger(run.progress.executed)} of {formatInteger(run.progress.requested)} scenarios</span> : null}
          </div>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall)} aria-label="Test progress">
            <div className="bar__fill" style={{ width: `${overall}%` }} />
          </div>
        </div>
      ) : (
        <div className="runbar__form">
          <div className="field runbar__runs">
            <label className="field__label" htmlFor="runs">
              Scenarios per rule
            </label>
            <div className="row">
              <select
                id="runs"
                className="select"
                value={customMode ? 'custom' : String(config.numRuns)}
                onChange={(e) => {
                  if (e.target.value === 'custom') {
                    setCustomMode(true);
                    setCustom(String(config.numRuns));
                  } else {
                    setCustomMode(false);
                    app.setConfig({ numRuns: Number(e.target.value) });
                  }
                }}
              >
                {PRESETS.map((n) => (
                  <option key={n} value={n}>
                    {formatInteger(n)}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {customMode ? (
                <input
                  className="input num"
                  inputMode="numeric"
                  aria-label="Custom number of scenarios"
                  aria-invalid={runsProblem !== null}
                  value={custom}
                  onChange={(e) => {
                    setCustom(e.target.value);
                    const n = Number(e.target.value);
                    if (e.target.value.trim() !== '' && TestConfigSchema.shape.numRuns.safeParse(n).success) app.setConfig({ numRuns: n });
                  }}
                />
              ) : null}
            </div>
          </div>
          <div className="field runbar__seed">
            <label className="field__label" htmlFor="seed">
              Seed
            </label>
            <div className="row">
              <input
                id="seed"
                className="input num"
                inputMode="numeric"
                aria-invalid={seedProblem !== null}
                value={seedText}
                onChange={(e) => {
                  setSeedText(e.target.value);
                  const n = Number(e.target.value);
                  if (e.target.value.trim() !== '' && TestConfigSchema.shape.seed.safeParse(n).success) app.setConfig({ seed: n });
                }}
              />
              <button type="button" className="btn btn--icon" aria-label="Pick a random seed" title="Random seed" onClick={() => app.setConfig({ seed: Math.floor(Math.random() * 2_147_483_647) })}>
                <Dices size={15} />
              </button>
            </div>
          </div>
          <button type="button" className="btn btn--primary runbar__go" disabled={Boolean(runsProblem || seedProblem) || session.rules.length === 0} onClick={() => app.runRules()}>
            <Play size={13} aria-hidden="true" />
            Run all
          </button>
        </div>
      )}
      {!running && (runsProblem || seedProblem) ? (
        <div className="field__hint runbar__err" role="alert">
          {runsProblem ?? seedProblem} {runsProblem ? `(${formatInteger(MIN_RUNS)} to ${formatInteger(MAX_RUNS)})` : ''}
        </div>
      ) : null}
      {!running && !runsProblem && !seedProblem ? (
        <div className="field__hint">The same seed and scenario count always generate the same scenarios.</div>
      ) : null}
    </div>
  );
}
