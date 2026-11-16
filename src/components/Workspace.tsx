import { Columns3, FlaskConical, Grid3x3, Workflow } from 'lucide-react';
import { useApp } from '../state/AppContext';
import type { MobilePane, RightTab } from '../state/types';
import { CounterexamplePanel } from './CounterexamplePanel';
import { GridPane } from './GridPane';
import { ResultsPanel } from './ResultsPanel';
import { RulesPanel } from './RulesPanel';
import { RunBar } from './RunBar';
import { WorkbookPane } from './WorkbookPane';
import { cx } from './ui';

const TABS: Array<{ id: RightTab; label: string }> = [
  { id: 'rules', label: 'Rules' },
  { id: 'results', label: 'Results' },
  { id: 'counterexample', label: 'Counterexample' },
];

const MOBILE: Array<{ id: MobilePane; label: string; icon: typeof Grid3x3 }> = [
  { id: 'workbook', label: 'Workbook', icon: Columns3 },
  { id: 'grid', label: 'Grid', icon: Grid3x3 },
  { id: 'tests', label: 'Tests', icon: FlaskConical },
];

export function Workspace() {
  const app = useApp();
  const { session, rightTab, mobilePane, run } = app;
  if (!session) return null;

  const failed = session.rules.filter((r) => session.results[r.id]?.status === 'failed').length;
  const running = run.status === 'running';

  return (
    <div className="workspace" data-pane={mobilePane}>
      <div className="workspace__left">
        <WorkbookPane />
      </div>
      <div className="workspace__center">
        <GridPane />
      </div>
      <aside className="workspace__right" aria-label="Rules and results">
        <div className="tabs" role="tablist" aria-label="Test panels">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              className="tab"
              aria-selected={rightTab === t.id}
              aria-controls="right-panel"
              onClick={() => app.setRightTab(t.id)}
            >
              {t.label}
              {t.id === 'counterexample' && failed > 0 ? <span className="badge badge--fail">{failed}</span> : null}
              {t.id === 'rules' ? <span className="faint num">{session.rules.length}</span> : null}
            </button>
          ))}
          {running ? <Workflow size={14} className="tabs__busy" aria-label="Tests are running" /> : null}
        </div>
        <div id="right-panel" role="tabpanel" aria-labelledby={`tab-${rightTab}`} className="workspace__scroll">
          {rightTab === 'rules' ? <RulesPanel /> : rightTab === 'results' ? <ResultsPanel /> : <CounterexamplePanel />}
        </div>
        <RunBar />
      </aside>

      <nav className="mobilebar" aria-label="Workspace sections">
        {MOBILE.map((m) => (
          <button key={m.id} type="button" className={cx('mobilebar__btn', mobilePane === m.id && 'is-on')} aria-pressed={mobilePane === m.id} onClick={() => app.setMobilePane(m.id)}>
            <m.icon size={16} aria-hidden="true" />
            {m.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
