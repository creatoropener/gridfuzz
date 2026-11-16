import { useMemo, useRef, useState, type DragEvent } from 'react';
import { FileUp, Loader2, UploadCloud } from 'lucide-react';
import { CalcEngine, isCalcError } from '../engine/calculation/CalcEngine';
import { analyzeWorkbook } from '../engine/calculation/formulaAnalysis';
import { MAX_UPLOAD_BYTES } from '../engine/workbook/importer';
import { countFormulas } from '../engine/workbook/model';
import { useApp } from '../state/AppContext';
import type { PendingImport } from '../state/types';
import { formatBytes, formatInteger, formatNumber, pluralize } from '../utils/format';
import { Callout, cx } from './ui';

function DropZone() {
  const app = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { importState } = app;

  const take = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void app.importFile(file);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    take(event.dataTransfer.files);
  };

  return (
    <div
      className={cx('drop', over && 'drop--over')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <UploadCloud size={28} aria-hidden="true" className="drop__icon" />
      <div className="drop__title">Drop a workbook here</div>
      <div className="faint">.xlsx or .csv, up to {formatBytes(MAX_UPLOAD_BYTES)}. It is read in your browser and never uploaded.</div>
      <div className="row row--wrap drop__actions">
        <button type="button" className="btn btn--primary" onClick={() => input.current?.click()}>
          <FileUp size={14} aria-hidden="true" />
          Choose file
        </button>
        <button type="button" className="btn" onClick={app.openSample}>
          Use the freight quote sample
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        className="sr-only"
        aria-label="Choose a workbook file"
        data-testid="file-input"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = '';
        }}
      />
      {importState.status === 'error' ? (
        <div className="drop__error">
          <Callout tone="fail" title={`${importState.fileName} was not opened`}>
            {importState.message}
          </Callout>
        </div>
      ) : null}
    </div>
  );
}

function Preview({ pending }: { pending: PendingImport }) {
  const { workbook, sheet } = pending;
  const analysis = useMemo(() => {
    try {
      const engine = CalcEngine.fromWorkbook(workbook);
      const diagnostics = [...workbook.warnings, ...analyzeWorkbook(workbook, engine)];
      const model = workbook.sheets.find((s) => s.name === sheet);
      const formulas = Object.values(model?.cells ?? {})
        .filter((c) => c.formula)
        .sort((a, b) => a.row - b.row || a.col - b.col);
      const rows = formulas.slice(0, 12).map((c) => {
        const value = engine.getValue(sheet, c.address);
        return {
          address: c.address,
          formula: c.formula ?? '',
          value: isCalcError(value) ? value.display : value === null ? '' : typeof value === 'number' ? formatNumber(value) : String(value),
          reads: engine
            .getPrecedents(sheet, c.address, 40)
            .slice(0, 8)
            .map((r) => (r.sheet === sheet ? r.address : `${r.sheet}!${r.address}`)),
        };
      });
      return { diagnostics, rows, totalFormulas: formulas.length, error: null as string | null };
    } catch (error) {
      return { diagnostics: workbook.warnings, rows: [], totalFormulas: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }, [workbook, sheet]);

  return (
    <div className="preview">
      {analysis.error ? (
        <Callout tone="fail" title="The calculation engine could not load this workbook">
          {analysis.error}
        </Callout>
      ) : null}
      {analysis.diagnostics.length > 0 ? (
        <ul className="diag" aria-label="Import notes">
          {analysis.diagnostics.slice(0, 8).map((d, i) => (
            <li key={`${d.code}-${i}`}>
              <Callout tone={d.level === 'error' ? 'fail' : d.level === 'warning' ? 'warn' : 'info'}>{d.message}</Callout>
            </li>
          ))}
          {analysis.diagnostics.length > 8 ? <li className="faint">and {analysis.diagnostics.length - 8} more notes in the workspace.</li> : null}
        </ul>
      ) : null}

      <h3 className="preview__h">Formulas on {sheet}</h3>
      {analysis.rows.length === 0 ? (
        <p className="faint">This sheet has no formulas. You can still map input and output cells, but a rule needs at least one calculated cell to test.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Cell</th>
                <th scope="col">Formula</th>
                <th scope="col">Value</th>
                <th scope="col">Reads</th>
              </tr>
            </thead>
            <tbody>
              {analysis.rows.map((r) => (
                <tr key={r.address}>
                  <td className="mono">{r.address}</td>
                  <td className="mono table__formula" title={r.formula}>
                    {r.formula}
                  </td>
                  <td className="num">{r.value}</td>
                  <td className="mono faint">{r.reads.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {analysis.totalFormulas > analysis.rows.length ? (
        <p className="faint">Showing {analysis.rows.length} of {formatInteger(analysis.totalFormulas)} formulas. The workspace shows them all.</p>
      ) : null}
    </div>
  );
}

export function ImportView() {
  const app = useApp();
  const { importState } = app;

  return (
    <main className="import">
      <h1 className="import__title">New test</h1>
      <p className="muted import__lead">Open a workbook to test. GridFuzz calculates it with its own engine, so cached values saved in the file are never trusted.</p>

      {importState.status === 'reading' ? (
        <div className="drop drop--busy" role="status">
          <Loader2 size={22} className="spin" aria-hidden="true" />
          <div>Reading {importState.fileName}…</div>
        </div>
      ) : importState.status === 'ready' ? (
        <section className="import__ready" aria-label="Import summary">
          <div className="import__head">
            <div>
              <h2 className="import__file">{importState.pending.workbook.name}</h2>
              <div className="faint">
                {formatBytes(importState.pending.workbook.sizeBytes)} · {pluralize(importState.pending.workbook.sheets.length, 'sheet')} · {pluralize(countFormulas(importState.pending.workbook), 'formula')}
              </div>
            </div>
            <div className="row">
              <button type="button" className="btn" onClick={app.goImport}>
                Choose another file
              </button>
              <button type="button" className="btn btn--primary" onClick={app.confirmImport}>
                Open in workspace
              </button>
            </div>
          </div>

          <fieldset className="sheetpick">
            <legend className="field__label">Sheet to open first</legend>
            {importState.pending.workbook.sheets.map((s) => {
              const formulas = Object.values(s.cells).filter((c) => c.formula).length;
              return (
                <label key={s.name} className={cx('sheetpick__item', importState.pending.sheet === s.name && 'is-on')}>
                  <input type="radio" name="sheet" checked={importState.pending.sheet === s.name} onChange={() => app.chooseImportSheet(s.name)} />
                  <span className="sheetpick__name">{s.name}</span>
                  <span className="faint">
                    {s.rowCount} × {s.colCount} · {pluralize(formulas, 'formula')}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <Preview pending={importState.pending} />
        </section>
      ) : (
        <DropZone />
      )}
    </main>
  );
}
