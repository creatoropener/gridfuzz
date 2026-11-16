import { useMemo } from 'react';
import { AlertTriangle, Info, RotateCcw, Sheet, XCircle } from 'lucide-react';
import { editableText } from '../engine/workbook/edits';
import { useApp } from '../state/AppContext';
import { formatBytes, pluralize } from '../utils/format';
import { cx } from './ui';

export function WorkbookPane() {
  const app = useApp();
  const { session, working, diagnostics } = app;

  const sheetInfo = useMemo(
    () =>
      (working?.sheets ?? []).map((s) => ({
        name: s.name,
        formulas: Object.values(s.cells).filter((c) => c.formula).length,
        rows: s.rowCount,
        cols: s.colCount,
      })),
    [working],
  );
  if (!session || !working) return null;

  return (
    <aside className="leftpane" aria-label="Workbook">
      <section className="side">
        <h2 className="side__h">Workbook</h2>
        <div className="side__file">{session.original.name}</div>
        <div className="faint">
          {session.original.source === 'sample' ? 'Built-in sample' : formatBytes(session.original.sizeBytes)}
        </div>
        <p className="side__note">
          {session.edits.length === 0 ? 'Showing the original, unchanged.' : 'Showing a working copy. The original file is unchanged.'}
        </p>
      </section>

      <section className="side">
        <h2 className="side__h">Sheets</h2>
        <ul className="sheets" role="list">
          {sheetInfo.map((s) => (
            <li key={s.name}>
              <button type="button" className={cx('sheets__btn', session.activeSheet === s.name && 'is-on')} aria-current={session.activeSheet === s.name ? 'true' : undefined} onClick={() => app.setActiveSheet(s.name)}>
                <Sheet size={14} aria-hidden="true" />
                <span className="sheets__name">{s.name}</span>
                <span className="faint">{s.formulas}ƒ</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="side">
        <div className="row row--between">
          <h2 className="side__h">Working copy</h2>
          {session.edits.length > 0 ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={app.resetEdits}>
              <RotateCcw size={12} aria-hidden="true" />
              Reset
            </button>
          ) : null}
        </div>
        {session.edits.length === 0 ? (
          <p className="faint">No edits. Select a cell and change its formula to try a fix; tests always run on the working copy.</p>
        ) : (
          <ul className="edits">
            {session.edits.map((e) => {
              const originalText = editableText(session.original.sheets.find((s) => s.name === e.sheet)?.cells[e.address]);
              return (
                <li key={`${e.sheet}!${e.address}`} className="edits__item">
                  <button type="button" className="edits__cell mono" onClick={() => app.selectCell({ sheet: e.sheet, address: e.address })}>
                    {e.sheet}!{e.address}
                  </button>
                  <div className="edits__new mono" title={e.content}>
                    {e.content || '(cleared)'}
                  </div>
                  <div className="edits__old mono faint" title={originalText}>
                    was {originalText || '(empty)'}
                  </div>
                  <button type="button" className="btn btn--ghost btn--icon btn--sm edits__undo" aria-label={`Revert ${e.address} to the original`} onClick={() => app.commitEdit(e.sheet, e.address, originalText)}>
                    <RotateCcw size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="side">
        <h2 className="side__h">Checks</h2>
        {diagnostics.length === 0 ? (
          <p className="faint">No unsupported functions, calculation errors or import problems found. {pluralize(sheetInfo.reduce((n, s) => n + s.formulas, 0), 'formula')} calculated.</p>
        ) : (
          <ul className="diagnostics">
            {diagnostics.slice(0, 30).map((d, i) => {
              const Icon = d.level === 'error' ? XCircle : d.level === 'warning' ? AlertTriangle : Info;
              return (
                <li key={`${d.code}-${d.sheet}-${d.address}-${i}`} className={cx('diagnostics__item', `diagnostics__item--${d.level}`)}>
                  <Icon size={14} aria-hidden="true" />
                  <span>
                    {d.message}
                    {d.sheet && d.address ? (
                      <>
                        {' '}
                        <button type="button" className="linkbtn mono" onClick={() => app.selectCell({ sheet: d.sheet as string, address: d.address as string })}>
                          Go to {d.address}
                        </button>
                      </>
                    ) : null}
                  </span>
                </li>
              );
            })}
            {diagnostics.length > 30 ? <li className="faint">and {diagnostics.length - 30} more.</li> : null}
          </ul>
        )}
      </section>
    </aside>
  );
}
