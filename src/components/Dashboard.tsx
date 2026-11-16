import { FileSpreadsheet, FlaskConical, Trash2, Upload } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { formatBytes, formatInteger } from '../utils/format';
import { Callout, EmptyState, cx, relativeTime } from './ui';

const STEPS = [
  { title: 'Say the rule', text: 'Write it in plain English, or map the cells yourself.' },
  { title: 'Generate scenarios', text: 'Thousands of inputs, seeded so every run can be repeated.' },
  { title: 'Shrink the failure', text: 'The smallest change to your data that still breaks the rule.' },
  { title: 'Fix and rerun', text: 'Edit a formula in a working copy and run the identical test.' },
];

export function Dashboard() {
  const app = useApp();
  const { stats, recent, activity } = app;
  const ranAnything = stats.scenariosExecuted > 0;

  return (
    <main className="dash">
      <section className="dash__hero" aria-labelledby="hero-title">
        <h1 id="hero-title" className="dash__title">
          Break your spreadsheet before your business does.
        </h1>
        <p className="dash__lead">
          State a business rule, and GridFuzz stress-tests the workbook against it: thousands of generated scenarios, the smallest input that fails, the cells involved, and a retest after you fix the formula.
        </p>
        <div className="row row--wrap">
          <button type="button" className="btn btn--primary btn--lg" onClick={app.goImport}>
            <Upload size={15} aria-hidden="true" />
            New test
          </button>
          <button type="button" className="btn btn--lg" onClick={app.openSample}>
            <FlaskConical size={15} aria-hidden="true" />
            Open the freight quote sample
          </button>
        </div>
        <p className="faint dash__note">Files are read and calculated in your browser. Nothing is uploaded, and no account or API key is needed.</p>

        <ol className="steps" aria-label="How a test works">
          {STEPS.map((s) => (
            <li key={s.title} className="steps__item">
              <span className="steps__title">{s.title}</span>
              <span className="steps__text">{s.text}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="dash__cols">
        <section className="dash__panel" aria-labelledby="recent-title">
          <h2 id="recent-title" className="dash__h">
            Recent workbooks
          </h2>
          {recent.length === 0 ? (
            <EmptyState title="No workbooks yet">Open the sample, or upload an .xlsx or .csv file to start your first test.</EmptyState>
          ) : (
            <ul className="list">
              {recent.map((r) => (
                <li key={r.id} className="list__item">
                  <FileSpreadsheet size={16} aria-hidden="true" className="faint" />
                  <div className="list__main">
                    <div className="list__title">{r.name}</div>
                    <div className="faint list__meta">
                      {r.source === 'sample' ? 'Built-in sample' : `Uploaded · ${formatBytes(r.sizeBytes)}`} · {relativeTime(r.openedAt)}
                    </div>
                  </div>
                  {r.source === 'sample' ? (
                    <button type="button" className="btn btn--sm" onClick={app.openSample}>
                      Open
                    </button>
                  ) : (
                    <button type="button" className="btn btn--sm" onClick={app.goImport} title="GridFuzz does not keep your file. Choose it again to continue; saved rules are restored.">
                      Upload again
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h2 className="dash__h dash__h--spaced">Recent activity</h2>
          {activity.length === 0 ? (
            <p className="faint">Nothing has happened yet.</p>
          ) : (
            <ul className="activity">
              {activity.slice(0, 8).map((a) => (
                <li key={a.at + a.text} className="activity__item">
                  <span className={cx('activity__dot', a.status && `activity__dot--${a.status}`)} aria-hidden="true" />
                  <span className="activity__text">{a.text}</span>
                  <span className="faint activity__when">{relativeTime(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="dash__panel" aria-labelledby="ledger-title">
          <h2 id="ledger-title" className="dash__h">
            Totals in this browser
          </h2>
          <dl className="ledger">
            <div className="ledger__row">
              <dt>Workbooks tested</dt>
              <dd className="num">{formatInteger(stats.testedWorkbooks.length)}</dd>
            </div>
            <div className="ledger__row">
              <dt>Rules created</dt>
              <dd className="num">{formatInteger(stats.rulesCreated)}</dd>
            </div>
            <div className="ledger__row">
              <dt>Rule runs with no violation found</dt>
              <dd className="num">{formatInteger(stats.passedTests)}</dd>
            </div>
            <div className="ledger__row">
              <dt>Rule runs with a violation</dt>
              <dd className={cx('num', stats.failedTests > 0 && 'ledger__fail')}>{formatInteger(stats.failedTests)}</dd>
            </div>
            <div className="ledger__row">
              <dt>Inconclusive rule runs</dt>
              <dd className="num">{formatInteger(stats.inconclusiveTests)}</dd>
            </div>
            <div className="ledger__row">
              <dt>Scenarios executed</dt>
              <dd className="num">{formatInteger(stats.scenariosExecuted)}</dd>
            </div>
          </dl>
          {ranAnything ? (
            <p className="faint dash__fine">Counted from real runs on this device. “No violation found” means none turned up in the scenarios tried, not a proof.</p>
          ) : (
            <Callout tone="info">No tests have run yet. These numbers count real runs on this device; nothing is pre-filled.</Callout>
          )}
          <button type="button" className="btn btn--ghost btn--sm dash__clear" onClick={app.clearLocalData}>
            <Trash2 size={13} aria-hidden="true" />
            Clear local data
          </button>
        </aside>
      </div>
    </main>
  );
}
