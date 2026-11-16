import { MousePointerClick, Plus, Trash2 } from 'lucide-react';
import { COMPARISON_OPS, INVARIANT_RELATIONS, type ComparisonOp, type InvariantRelation } from '../schemas/rule';
import { emptyInput } from '../engine/rule-compiler/draft';
import type { ComparisonDraft, InputDraft, RuleDraft } from '../engine/rule-compiler/types';
import type { RuleType } from '../types/testing';
import type { CellRefModel } from '../types/workbook';

export const RULE_TYPE_LABEL: Record<RuleType, string> = {
  monotonic_increasing: 'Raising an input must not lower the output',
  monotonic_decreasing: 'Raising an input must not raise the output',
  bounds: 'Output must stay within limits',
  non_negative: 'Outputs must never be negative',
  invariant: 'Two expressions must always relate',
  conditional: 'If one condition holds, another must too',
};

export const RULE_TYPE_SHORT: Record<RuleType, string> = {
  monotonic_increasing: 'Monotonic ↑',
  monotonic_decreasing: 'Monotonic ↓',
  bounds: 'Bounds',
  non_negative: 'Non-negative',
  invariant: 'Invariant',
  conditional: 'Conditional',
};

interface FormProps {
  draft: RuleDraft;
  onChange: (draft: RuleDraft) => void;
  sheets: string[];
  /** The grid selection, used by the “Use selected cell” buttons. */
  selected: CellRefModel | null;
}

function changeType(draft: RuleDraft, type: RuleType): RuleDraft {
  const next: RuleDraft = { ...draft, type };
  if (next.inputs.length === 0) next.inputs = [emptyInput(draft.sheet)];
  if (next.outputs.length === 0) next.outputs = [{ sheet: draft.sheet, address: '' }];
  return next;
}

function CellField({
  label,
  sheet,
  address,
  sheets,
  selected,
  onChange,
}: {
  label: string;
  sheet: string;
  address: string;
  sheets: string[];
  selected: CellRefModel | null;
  onChange: (cell: { sheet: string; address: string }) => void;
}) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="row">
        {sheets.length > 1 ? (
          <select className="select cellfield__sheet" aria-label={`${label}: sheet`} value={sheet} onChange={(e) => onChange({ sheet: e.target.value, address })}>
            {sheets.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}
        <input className="input input--mono cellfield__addr" aria-label={`${label}: cell address`} placeholder="B14" value={address} spellCheck={false} onChange={(e) => onChange({ sheet, address: e.target.value.toUpperCase() })} />
        <button type="button" className="btn btn--sm" disabled={!selected} title={selected ? `Use ${selected.address} (selected in the grid)` : 'Select a cell in the grid first'} onClick={() => selected && onChange({ sheet: selected.sheet, address: selected.address })}>
          <MousePointerClick size={12} aria-hidden="true" />
          Use selected
        </button>
      </div>
    </div>
  );
}

function InputEditor({
  title,
  value,
  sheets,
  selected,
  onChange,
  onRemove,
}: {
  title: string;
  value: InputDraft;
  sheets: string[];
  selected: CellRefModel | null;
  onChange: (value: InputDraft) => void;
  onRemove?: (() => void) | undefined;
}) {
  const set = (patch: Partial<InputDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="inputrow">
      <div className="row row--between">
        <CellField label={title} sheet={value.sheet} address={value.address} sheets={sheets} selected={selected} onChange={(c) => set(c)} />
        {onRemove ? (
          <button type="button" className="btn btn--ghost btn--icon btn--sm inputrow__remove" aria-label={`Remove ${title}`} onClick={onRemove}>
            <Trash2 size={13} />
          </button>
        ) : null}
      </div>
      <div className="inputrow__range">
        <div className="field">
          <label className="field__label">Smallest value to try</label>
          <input className="input num" inputMode="decimal" value={value.min} onChange={(e) => set({ min: e.target.value })} />
        </div>
        <div className="field">
          <label className="field__label">Largest value to try</label>
          <input className="input num" inputMode="decimal" value={value.max} onChange={(e) => set({ max: e.target.value })} />
        </div>
        <div className="field">
          <label className="field__label">Decimals</label>
          <input className="input num" inputMode="numeric" value={value.precision} onChange={(e) => set({ precision: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

function InputList({
  heading,
  hint,
  titleFor,
  items,
  min,
  sheets,
  selected,
  onChange,
}: {
  heading: string;
  hint?: string;
  titleFor: (index: number) => string;
  items: InputDraft[];
  min: number;
  sheets: string[];
  selected: CellRefModel | null;
  onChange: (items: InputDraft[]) => void;
}) {
  return (
    <fieldset className="formgroup">
      <legend className="formgroup__h">{heading}</legend>
      {hint ? <p className="field__hint">{hint}</p> : null}
      {items.map((item, i) => (
        <InputEditor
          key={i}
          title={titleFor(i)}
          value={item}
          sheets={sheets}
          selected={selected}
          onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))}
          onRemove={items.length > min ? () => onChange(items.filter((_, j) => j !== i)) : undefined}
        />
      ))}
      <button type="button" className="btn btn--sm formgroup__add" onClick={() => onChange([...items, emptyInput(items[0]?.sheet ?? '')])}>
        <Plus size={12} aria-hidden="true" />
        Add an input
      </button>
    </fieldset>
  );
}

function ComparisonEditor({ title, value, onChange }: { title: string; value: ComparisonDraft; onChange: (v: ComparisonDraft) => void }) {
  return (
    <div className="field">
      <span className="field__label">{title}</span>
      <div className="comparison">
        <input className="input input--mono" aria-label={`${title}: left side`} placeholder="B10" value={value.left} spellCheck={false} onChange={(e) => onChange({ ...value, left: e.target.value })} />
        <select className="select comparison__op" aria-label={`${title}: comparison`} value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value as ComparisonOp })}>
          {COMPARISON_OPS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        <input className="input input--mono" aria-label={`${title}: right side`} placeholder="3500" value={value.right} spellCheck={false} onChange={(e) => onChange({ ...value, right: e.target.value })} />
      </div>
    </div>
  );
}

export function RuleForm({ draft, onChange, sheets, selected }: FormProps) {
  const set = (patch: Partial<RuleDraft>) => onChange({ ...draft, ...patch });
  const setOutput = (i: number, cell: { sheet: string; address: string }) => set({ outputs: draft.outputs.map((o, j) => (j === i ? cell : o)) });
  const monotonic = draft.type === 'monotonic_increasing' || draft.type === 'monotonic_decreasing';

  return (
    <div className="ruleform">
      <div className="field">
        <label className="field__label" htmlFor="rule-name">
          Rule name
        </label>
        <input id="rule-name" className="input" value={draft.name} placeholder="Name this rule" onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="rule-type">
          What kind of rule is it?
        </label>
        <select id="rule-type" className="select" value={draft.type} onChange={(e) => onChange(changeType(draft, e.target.value as RuleType))}>
          {(Object.keys(RULE_TYPE_LABEL) as RuleType[]).map((t) => (
            <option key={t} value={t}>
              {RULE_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>

      {monotonic ? (
        <>
          <InputList
            heading="Inputs to vary"
            hint="The first input is the one that is raised. The others take random values but stay equal inside each before/after pair."
            titleFor={(i) => (i === 0 ? 'Input that is raised' : `Held-equal input ${i}`)}
            items={draft.inputs}
            min={1}
            sheets={sheets}
            selected={selected}
            onChange={(inputs) => set({ inputs })}
          />
          <fieldset className="formgroup">
            <legend className="formgroup__h">Output to watch</legend>
            <CellField label="Output cell" sheet={draft.outputs[0]?.sheet ?? draft.sheet} address={draft.outputs[0]?.address ?? ''} sheets={sheets} selected={selected} onChange={(c) => setOutput(0, c)} />
          </fieldset>
        </>
      ) : null}

      {draft.type === 'bounds' ? (
        <>
          <InputList heading="Inputs to vary" titleFor={(i) => `Input ${i + 1}`} items={draft.inputs} min={1} sheets={sheets} selected={selected} onChange={(inputs) => set({ inputs })} />
          <fieldset className="formgroup">
            <legend className="formgroup__h">Output and limits</legend>
            <CellField label="Output cell" sheet={draft.outputs[0]?.sheet ?? draft.sheet} address={draft.outputs[0]?.address ?? ''} sheets={sheets} selected={selected} onChange={(c) => setOutput(0, c)} />
            <div className="inputrow__range">
              <div className="field">
                <label className="field__label">Lowest allowed</label>
                <input className="input num" inputMode="decimal" placeholder="no limit" value={draft.min} onChange={(e) => set({ min: e.target.value })} />
              </div>
              <div className="field">
                <label className="field__label">Highest allowed</label>
                <input className="input num" inputMode="decimal" placeholder="no limit" value={draft.max} onChange={(e) => set({ max: e.target.value })} />
              </div>
            </div>
          </fieldset>
        </>
      ) : null}

      {draft.type === 'non_negative' ? (
        <>
          <InputList heading="Inputs to vary" titleFor={(i) => `Input ${i + 1}`} items={draft.inputs} min={1} sheets={sheets} selected={selected} onChange={(inputs) => set({ inputs })} />
          <fieldset className="formgroup">
            <legend className="formgroup__h">Outputs that must stay at or above zero</legend>
            {draft.outputs.map((o, i) => (
              <div key={i} className="row">
                <div style={{ flex: 1 }}>
                  <CellField label={`Output ${i + 1}`} sheet={o.sheet} address={o.address} sheets={sheets} selected={selected} onChange={(c) => setOutput(i, c)} />
                </div>
                {draft.outputs.length > 1 ? (
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Remove output ${i + 1}`} onClick={() => set({ outputs: draft.outputs.filter((_, j) => j !== i) })}>
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </div>
            ))}
            <button type="button" className="btn btn--sm formgroup__add" onClick={() => set({ outputs: [...draft.outputs, { sheet: draft.sheet, address: '' }] })}>
              <Plus size={12} aria-hidden="true" />
              Add an output
            </button>
          </fieldset>
        </>
      ) : null}

      {draft.type === 'invariant' ? (
        <>
          <InputList heading="Inputs to vary" titleFor={(i) => `Input ${i + 1}`} items={draft.inputs} min={1} sheets={sheets} selected={selected} onChange={(inputs) => set({ inputs })} />
          <fieldset className="formgroup">
            <legend className="formgroup__h">Relationship that must always hold</legend>
            <p className="field__hint">Use cell references (B10), ranges, SUM, MIN, MAX, AVERAGE, ABS, ROUND and percentages such as 5%.</p>
            <div className="comparison">
              <input className="input input--mono" aria-label="Left expression" placeholder="B14" value={draft.left} spellCheck={false} onChange={(e) => set({ left: e.target.value })} />
              <select className="select comparison__op" aria-label="Relation" value={draft.relation} onChange={(e) => set({ relation: e.target.value as InvariantRelation })}>
                {INVARIANT_RELATIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <input className="input input--mono" aria-label="Right expression" placeholder="SUM(B5:B9)" value={draft.right} spellCheck={false} onChange={(e) => set({ right: e.target.value })} />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="rel-tol">
                Relative tolerance
              </label>
              <input id="rel-tol" className="input num" inputMode="decimal" value={draft.relativeTolerance} onChange={(e) => set({ relativeTolerance: e.target.value })} />
            </div>
          </fieldset>
        </>
      ) : null}

      {draft.type === 'conditional' ? (
        <>
          <InputList heading="Inputs to vary" titleFor={(i) => `Input ${i + 1}`} items={draft.inputs} min={1} sheets={sheets} selected={selected} onChange={(inputs) => set({ inputs })} />
          <fieldset className="formgroup">
            <legend className="formgroup__h">Condition</legend>
            <ComparisonEditor title="When" value={draft.when} onChange={(when) => set({ when })} />
            <ComparisonEditor title="Then it must be true that" value={draft.then} onChange={(then) => set({ then })} />
          </fieldset>
        </>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="tol">
          Tolerance when comparing numbers
        </label>
        <input id="tol" className="input num" inputMode="decimal" value={draft.tolerance} onChange={(e) => set({ tolerance: e.target.value })} />
        <span className="field__hint">Differences smaller than this are treated as equal (rounding noise).</span>
      </div>
    </div>
  );
}
