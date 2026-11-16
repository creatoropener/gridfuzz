import { Download, FileJson, FileSpreadsheet, Moon, Play, Save, Square, Sun, Upload, ClipboardCopy, Copy } from 'lucide-react';
import { useApp } from '../state/AppContext';
import { Logo, Menu, cx } from './ui';

export function Header() {
  const app = useApp();
  const { view, session, run, theme } = app;
  const inWorkspace = view === 'workspace' && session;
  const running = run.status === 'running';
  const results = session ? Object.keys(session.results).length : 0;
  const failedId = session?.selectedRuleId && session.results[session.selectedRuleId]?.counterexample ? session.selectedRuleId : null;

  return (
    <header className="header">
      <button type="button" className="brand" onClick={app.goDashboard} aria-label="GridFuzz dashboard">
        <Logo />
        <span className="brand__name">GridFuzz</span>
      </button>

      {inWorkspace ? (
        <div className="crumb" aria-label="Current workbook">
          <FileSpreadsheet size={14} aria-hidden="true" />
          <span className="crumb__name">{session.original.name}</span>
          {session.edits.length > 0 ? (
            <span className="badge badge--warn" title="Edits live in a working copy; the uploaded file is never changed">
              {session.edits.length} edit{session.edits.length === 1 ? '' : 's'}
            </span>
          ) : (
            <span className="badge">Original</span>
          )}
        </div>
      ) : null}

      <div className="spacer" />

      {inWorkspace ? (
        <>
          <button type="button" className="btn" onClick={app.goImport} title="Upload another workbook">
            <Upload size={14} aria-hidden="true" />
            <span className="btn__label">Upload</span>
          </button>
          <button type="button" className={cx('btn', session.dirty && 'btn--dirty')} onClick={app.saveSession} title="Save rules, settings and edits in this browser">
            <Save size={14} aria-hidden="true" />
            <span className="btn__label">Save</span>
            {session.dirty ? <span className="dot" aria-label="Unsaved changes" /> : null}
          </button>
          <Menu label="Export" icon={<Download size={14} aria-hidden="true" />}>
            {(close) => (
              <>
                <button type="button" className="menu__item" role="menuitem" disabled={results === 0} onClick={() => (app.exportReport(), close())}>
                  <FileJson size={15} aria-hidden="true" />
                  <span>
                    JSON report
                    <small>{results === 0 ? 'Run a test first' : 'Rules, seeds, results and counterexamples'}</small>
                  </span>
                </button>
                <button type="button" className="menu__item" role="menuitem" onClick={() => (void app.downloadOriginal(), close())}>
                  <FileSpreadsheet size={15} aria-hidden="true" />
                  <span>
                    Original workbook
                    <small>The file as you uploaded it, unchanged</small>
                  </span>
                </button>
                <button type="button" className="menu__item" role="menuitem" onClick={() => (void app.downloadWorkingCopy(), close())}>
                  <Copy size={15} aria-hidden="true" />
                  <span>
                    Working copy (.xlsx)
                    <small>With your formula edits applied</small>
                  </span>
                </button>
                <button type="button" className="menu__item" role="menuitem" disabled={!failedId} onClick={() => (failedId && void app.copyCounterexample(failedId), close())}>
                  <ClipboardCopy size={15} aria-hidden="true" />
                  <span>
                    Copy counterexample
                    <small>{failedId ? 'Plain text, for a bug report' : 'No counterexample selected'}</small>
                  </span>
                </button>
              </>
            )}
          </Menu>
          {running ? (
            <button type="button" className="btn btn--danger" onClick={app.cancelRun}>
              <Square size={13} aria-hidden="true" />
              Cancel
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => app.runRules()}>
              <Play size={13} aria-hidden="true" />
              Run tests
            </button>
          )}
        </>
      ) : view === 'dashboard' ? (
        <button type="button" className="btn btn--primary" onClick={app.goImport}>
          <Upload size={14} aria-hidden="true" />
          New test
        </button>
      ) : null}

      <button
        type="button"
        className="btn btn--ghost btn--icon"
        onClick={app.toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
      >
        {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
      </button>
    </header>
  );
}
