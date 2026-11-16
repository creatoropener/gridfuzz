import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Eye, RotateCcw, X } from 'lucide-react';
import { isCalcError, type CalcValue } from '../engine/calculation/CalcEngine';
import { colToLetters, parseAddress, toAddress } from '../engine/workbook/a1';
import { editableText } from '../engine/workbook/edits';
import { inferLabel } from '../engine/workbook/labels';
import { sheetValuesForScenario } from '../engine/scenarioView';
import { useApp } from '../state/AppContext';
import { computeMarks, counterexampleMarks, type CellMark } from '../state/highlights';
import type { CellModel, CellRefModel } from '../types/workbook';
import { formatNumber } from '../utils/format';
import { Callout, EmptyState, cx } from './ui';

const ROW_STEP = 100;
const MAX_COLS = 52;

function displayValue(value: CalcValue): string {
  if (value === null) return '';
  if (isCalcError(value)) return value.display;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return value;
}

function ariaFor(address: string, text: string, marks: Set<CellMark> | undefined, edited: boolean): string {
  const parts = [address, text === '' ? 'empty' : text];
  if (marks?.has('failing')) parts.push('moved against the rule');
  if (marks?.has('suspect')) parts.push('suspect');
  if (marks?.has('input')) parts.push('rule input');
  if (marks?.has('output')) parts.push('rule output');
  if (edited) parts.push('edited');
  return parts.join(', ');
}

interface RowProps {
  sheet: string;
  row: number;
  cols: number;
  values: CalcValue[];
  cells: Record<string, CellModel>;
  marks: Map<string, Set<CellMark>>;
  edited: ReadonlySet<string>;
  mode: 'values' | 'formulas';
  selectedCol: number;
  onSelect: (ref: CellRefModel) => void;
}

const Row = memo(function Row({ sheet, row, cols, values, cells, marks, edited, mode, selectedCol, onSelect }: RowProps) {
  const tds = [];
  for (let col = 0; col < cols; col++) {
    const address = toAddress(col, row);
    const cell = cells[address];
    const value = values[col] ?? null;
    const showFormula = mode === 'formulas' && cell?.formula;
    const text = showFormula ? (cell.formula ?? '') : displayValue(value);
    const m = marks.get(address);
    const isEdited = edited.has(address);
    const numeric = !showFormula && typeof value === 'number';
    tds.push(
      <td
        key={col}
        role="gridcell"
        data-address={address}
        aria-selected={selectedCol === col}
        aria-label={ariaFor(address, text, m, isEdited)}
        className={cx(
          'cell',
          numeric && 'cell--num',
          showFormula && 'cell--formula',
          isCalcError(value) && 'cell--error',
          cell?.formula && 'cell--calc',
          selectedCol === col && 'is-selected',
          isEdited && 'is-edited',
          m?.has('input') && 'mark-input',
          m?.has('context') && 'mark-context',
          m?.has('output') && 'mark-output',
          m?.has('path') && 'mark-path',
          m?.has('suspect') && 'mark-suspect',
          m?.has('failing') && 'mark-failing',
        )}
        onClick={() => onSelect({ sheet, address })}
        title={text.length > 18 ? text : undefined}
      >
        {text}
      </td>,
    );
  }
  return (
    <tr role="row" aria-rowindex={row + 1}>
      <th scope="row" className={cx('rowhead', selectedCol >= 0 && 'is-active')}>
        {row + 1}
      </th>
      {tds}
    </tr>
  );
});

function Legend() {
  return (
    <ul className="legend" aria-label="Cell markings">
      <li><span className="legend__sw legend__sw--input" aria-hidden="true" />Input</li>
      <li><span className="legend__sw legend__sw--output" aria-hidden="true" />Output</li>
      <li><span className="legend__sw legend__sw--failing" aria-hidden="true" />Moved against the rule</li>
      <li><span className="legend__sw legend__sw--suspect" aria-hidden="true" />Suspect</li>
      <li><span className="legend__sw legend__sw--edited" aria-hidden="true" />Edited</li>
    </ul>
  );
}

function FormulaBar({ cell, inputRef, locked }: { cell: CellRefModel | null; inputRef: React.RefObject<HTMLInputElement | null>; locked: boolean }) {
  const app = useApp();
  const { working, session, calc } = app;
  const sheetModel = working?.sheets.find((s) => s.name === cell?.sheet);
  const current = cell ? editableText(sheetModel?.cells[cell.address]) : '';
  const originalText = cell && session ? editableText(session.original.sheets.find((s) => s.name === cell.sheet)?.cells[cell.address]) : '';
  const key = cell ? `${cell.sheet}!${cell.address}|${current}` : '';
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = cell && working ? inferLabel(working, cell) : null;
  const isEdited = cell ? current.trim() !== originalText.trim() : false;
  const value = cell && calc?.engine ? calc.engine.getValue(cell.sheet, cell.address) : null;
  const dirty = draft.trim() !== current.trim();

  const commit = () => {
    if (!cell || !dirty) return;
    app.commitEdit(cell.sheet, cell.address, draft);
  };

  return (
    <div className="fbar">
      <div className="fbar__name mono" aria-label="Selected cell">
        {cell ? cell.address : '—'}
      </div>
      <div className="fbar__field">
        <label className="sr-only" htmlFor="formula-input">
          Cell content{cell ? ` for ${cell.address}` : ''}
        </label>
        <input
          id="formula-input"
          ref={inputRef}
          className="input input--mono fbar__input"
          value={draft}
          disabled={!cell || locked}
          placeholder={cell ? 'Type a value or a formula such as =SUM(B5:B9)' : 'Select a cell'}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setDraft(current);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <button type="button" className="btn btn--icon btn--sm" aria-label="Apply edit to the working copy" disabled={!dirty || locked} onClick={commit} title="Apply (Enter)">
          <Check size={14} />
        </button>
        <button type="button" className="btn btn--icon btn--sm" aria-label="Discard typing" disabled={!dirty} onClick={() => setDraft(current)} title="Discard (Esc)">
          <X size={14} />
        </button>
      </div>
      {cell ? (
        <div className="fbar__meta">
          {label ? <span className="fbar__label">{label}</span> : null}
          {value !== null ? (
            <span className={cx('num', 'fbar__value', isCalcError(value) && 'fbar__value--error')}>= {displayValue(value)}</span>
          ) : null}
          {isCalcError(value as CalcValue) ? <span className="faint">{(value as { message: string }).message}</span> : null}
          {isEdited ? (
            <span className="fbar__edited">
              <span className="badge badge--warn">Edited</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => app.commitEdit(cell.sheet, cell.address, originalText)} title={`Original: ${originalText || '(empty)'}`}>
                <RotateCcw size={12} aria-hidden="true" />
                Revert to original
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Inspector({ cell }: { cell: CellRefModel | null }) {
  const app = useApp();
  const { calc, working } = app;
  const info = useMemo(() => {
    if (!cell || !calc?.engine) return null;
    try {
      return { precedents: calc.engine.getPrecedents(cell.sheet, cell.address, 60), dependents: calc.engine.getDependents(cell.sheet, cell.address, 60) };
    } catch {
      return null;
    }
  }, [cell, calc]);
  if (!cell || !info || !working) return null;
  const chip = (ref: CellRefModel) => (
    <button key={`${ref.sheet}!${ref.address}`} type="button" className="chip mono" onClick={() => app.selectCell(ref)} title={inferLabel(working, ref) ?? undefined}>
      {ref.sheet === cell.sheet ? ref.address : `${ref.sheet}!${ref.address}`}
    </button>
  );
  const MAX = 14;
  return (
    <div className="inspector">
      <div className="inspector__group">
        <span className="inspector__label">Reads</span>
        {info.precedents.length === 0 ? <span className="faint">nothing (a typed-in value)</span> : info.precedents.slice(0, MAX).map(chip)}
        {info.precedents.length > MAX ? <span className="faint">+{info.precedents.length - MAX} more</span> : null}
      </div>
      <div className="inspector__group">
        <span className="inspector__label">Used by</span>
        {info.dependents.length === 0 ? <span className="faint">no formula reads it</span> : info.dependents.slice(0, MAX).map(chip)}
        {info.dependents.length > MAX ? <span className="faint">+{info.dependents.length - MAX} more</span> : null}
      </div>
    </div>
  );
}

export function GridPane() {
  const app = useApp();
  const { session, working, calc, fingerprint, scenarioView } = app;
  const [mode, setMode] = useState<'values' | 'formulas'>('values');
  const [rowLimit, setRowLimit] = useState(ROW_STEP);
  const formulaInput = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const sheetName = session?.activeSheet ?? '';
  const sheet = working?.sheets.find((s) => s.name === sheetName);
  useEffect(() => setRowLimit(ROW_STEP), [sheetName]);

  const scenarioRule = scenarioView ? session?.rules.find((r) => r.id === scenarioView.ruleId) : undefined;
  const scenarioResult = scenarioView && session ? session.results[scenarioView.ruleId] : undefined;
  const scenario = scenarioResult?.counterexample?.scenario;

  const values = useMemo<CalcValue[][] | null>(() => {
    if (!working || !sheet) return null;
    if (scenarioView && scenarioRule && scenario) {
      return sheetValuesForScenario(working, scenarioRule, scenario, scenarioView.run, sheet.name);
    }
    try {
      return calc?.engine ? calc.engine.getSheetValues(sheet.name) : null;
    } catch {
      return null;
    }
  }, [working, sheet, calc, scenarioView, scenarioRule, scenario]);

  const marks = useMemo(() => {
    if (!session || !sheet) return new Map<string, Set<CellMark>>();
    return scenarioView ? counterexampleMarks(session, scenarioView.ruleId, sheet.name) : computeMarks(session, fingerprint, sheet.name);
  }, [session, sheet, fingerprint, scenarioView]);

  const edited = useMemo(() => new Set((session?.edits ?? []).filter((e) => e.sheet === sheetName).map((e) => e.address)), [session?.edits, sheetName]);

  if (!session || !working || !sheet) return null;

  const rows = Math.max(sheet.rowCount, 1);
  const cols = Math.min(Math.max(sheet.colCount, 1), MAX_COLS);
  const shownRows = Math.min(rows, rowLimit);
  const selected = session.selected && session.selected.sheet === sheet.name ? session.selected : null;
  const selectedPos = selected ? parseAddress(selected.address) : null;

  const move = (dRow: number, dCol: number) => {
    const from = selectedPos ?? { row: 0, col: 0 };
    const row = Math.min(shownRows - 1, Math.max(0, from.row + dRow));
    const col = Math.min(cols - 1, Math.max(0, from.col + dCol));
    const address = toAddress(col, row);
    app.selectCell({ sheet: sheet.name, address });
    wrapRef.current?.querySelector(`[data-address="${address}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    switch (e.key) {
      case 'ArrowDown': move(1, 0); break;
      case 'ArrowUp': move(-1, 0); break;
      case 'ArrowLeft': move(0, -1); break;
      case 'ArrowRight': move(0, 1); break;
      case 'Enter':
      case 'F2':
        formulaInput.current?.focus();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const header = [];
  for (let c = 0; c < cols; c++) {
    header.push(
      <th key={c} scope="col" className={cx('colhead', selectedPos?.col === c && 'is-active')}>
        {colToLetters(c)}
      </th>,
    );
  }
  const body = [];
  for (let r = 0; r < shownRows; r++) {
    body.push(
      <Row
        key={r}
        sheet={sheet.name}
        row={r}
        cols={cols}
        values={values?.[r] ?? []}
        cells={sheet.cells}
        marks={marks}
        edited={edited}
        mode={mode}
        selectedCol={selectedPos && selectedPos.row === r ? selectedPos.col : -1}
        onSelect={app.selectCell}
      />,
    );
  }

  const runNames = scenarioResult?.counterexample?.runs ?? [];

  return (
    <section className="gridpane" aria-label={`Sheet ${sheet.name}`}>
      <div className="gridpane__bar">
        <div className="seg" role="group" aria-label="Cell display">
          <button type="button" className={cx('seg__btn', mode === 'values' && 'is-on')} aria-pressed={mode === 'values'} onClick={() => setMode('values')}>
            Values
          </button>
          <button type="button" className={cx('seg__btn', mode === 'formulas' && 'is-on')} aria-pressed={mode === 'formulas'} onClick={() => setMode('formulas')}>
            Formulas
          </button>
        </div>
        <span className="gridpane__sheet">{sheet.name}</span>
        <span className="faint hide-sm">
          {rows} rows × {sheet.colCount} columns
        </span>
        <div className="spacer" />
        <Legend />
      </div>

      {scenarioView && scenario ? (
        <div className="scenario-banner" role="status">
          <Eye size={15} aria-hidden="true" />
          <div className="scenario-banner__text">
            <strong>Viewing the counterexample.</strong> Its input values are applied to a throw-away copy of the sheet. This is not your data.
          </div>
          <div className="seg" role="group" aria-label="Counterexample run">
            {runNames.map((name, i) => (
              <button key={name} type="button" className={cx('seg__btn', scenarioView.run === i && 'is-on')} aria-pressed={scenarioView.run === i} onClick={() => app.setScenarioView({ ruleId: scenarioView.ruleId, run: i })}>
                {name}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn--sm" onClick={() => app.setScenarioView(null)}>
            Back to working copy
          </button>
        </div>
      ) : null}

      <FormulaBar cell={selected} inputRef={formulaInput} locked={Boolean(scenarioView)} />
      {calc?.error ? (
        <div className="gridpane__error">
          <Callout tone="fail" title="The calculation engine could not load this workbook">
            {calc.error}
          </Callout>
        </div>
      ) : null}

      {sheet.rowCount === 0 || Object.keys(sheet.cells).length === 0 ? (
        <div className="gridpane__empty">
          <EmptyState title="This sheet is empty">Choose another sheet in the left pane, or open a workbook with data on it.</EmptyState>
        </div>
      ) : (
        <div className="gridwrap" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} role="application" aria-label="Spreadsheet grid. Use arrow keys to move, Enter to edit.">
          <table className="grid" role="grid" aria-rowcount={rows} aria-colcount={cols}>
            <thead>
              <tr role="row">
                <th className="corner" aria-label="Row numbers" />
                {header}
              </tr>
            </thead>
            <tbody>{body}</tbody>
          </table>
          <div className="gridwrap__foot">
            {shownRows < rows ? (
              <button type="button" className="btn btn--sm" onClick={() => setRowLimit((n) => n + ROW_STEP)}>
                Show {Math.min(ROW_STEP, rows - shownRows)} more rows ({rows - shownRows} hidden)
              </button>
            ) : null}
            {sheet.colCount > MAX_COLS ? <span className="faint">Showing the first {MAX_COLS} of {sheet.colCount} columns.</span> : null}
          </div>
        </div>
      )}
      <Inspector cell={selected} />
    </section>
  );
}
