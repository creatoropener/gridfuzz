import { useMemo, useState } from 'react';
import { ArrowRight, Check, Pencil, Play, Plus, Sparkles, Trash2, Wrench } from 'lucide-react';
import { checkRuleAgainstWorkbook } from '../engine/runRule';
import { describeCell } from '../engine/workbook/labels';
import { PATTERN_DOCS, compileWith, localRuleCompiler } from '../engine/rule-compiler/LocalRuleCompiler';
import { draftToRule, emptyDraft, ruleToDraft } from '../engine/rule-compiler/draft';
import type { CompileResult, RuleDraft } from '../engine/rule-compiler/types';
import { ruleInputs, ruleOutputs, type Rule } from '../schemas/rule';
import { useApp } from '../state/AppContext';
import type { RuleType } from '../types/testing';
import { RULE_TYPE_SHORT, RuleForm } from './RuleForm';
import { Callout, EmptyState, StatusBadge, cx } from './ui';

const EXAMPLES = PATTERN_DOCS.map((p) => p.examples[0]).filter((e): e is string => Boolean(e));

function summary(rule: Rule, describe: (ref: { sheet: string; address: string }) => string): string {
  const ins = ruleInputs(rule).map((i) => describe(i.cell));
  const outs = ruleOutputs(rule).map((o) => describe(o));
  if (rule.type === 'invariant') return `${rule.left} ${rule.relation} ${rule.right}`;
  if (rule.type === 'conditional') return `If ${rule.when.left} ${rule.when.op} ${rule.when.right}, then ${rule.then.left} ${rule.then.op} ${rule.then.right}`;
  const from = ins.slice(0, 2).join(', ') + (ins.length > 2 ? ` +${ins.length - 2}` : '');
  return `${from} → ${outs.join(', ') || '—'}`;
}

export function RulesPanel() {
  const app = useApp();
  const { session, working, fingerprint, run } = app;
  const [text, setText] = useState('');
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [manualType, setManualType] = useState<RuleType>('monotonic_increasing');

  const validated = useMemo(() => (draft ? draftToRule(draft) : null), [draft]);
  const problems = useMemo(() => {
    if (!validated) return [];
    if (!validated.ok) return validated.issues;
    return working ? checkRuleAgainstWorkbook(validated.rule, working) : [];
  }, [validated, working]);

  if (!session || !working) return null;
  const sheets = session.original.sheets.map((s) => s.name);
  const running = run.status === 'running';
  const describe = (ref: { sheet: string; address: string }) => describeCell(working, ref);

  const compile = async (sentence: string) => {
    const trimmed = sentence.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const result = await compileWith([localRuleCompiler], trimmed, { workbook: working, activeSheet: session.activeSheet });
      setCompiled(result);
      setDraft(result.status === 'unsupported' ? null : result.draft);
      setShowJson(false);
    } catch (error) {
      setCompiled({ status: 'unsupported', reason: error instanceof Error ? error.message : 'The rule could not be read.', suggestions: [] });
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const discard = () => {
    setDraft(null);
    setCompiled(null);
  };

  const confirm = () => {
    if (!validated?.ok || problems.length > 0) return;
    const created = app.addRule(validated.rule);
    app.toast(created ? `Added “${validated.rule.name}”. Run tests to try it.` : `Updated “${validated.rule.name}”.`, 'pass');
    setText('');
    discard();
  };

  const editing = draft ? session.rules.some((r) => r.id === draft.id) : false;

  return (
    <div className="panel">
      <section className="panel__section">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void compile(text);
          }}
        >
          <label className="field__label" htmlFor="rule-text">
            Describe a rule in plain English
          </label>
          <textarea
            id="rule-text"
            className="textarea"
            rows={3}
            value={text}
            placeholder="Increasing fuel surcharge must never reduce final freight cost."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void compile(text);
              }
            }}
          />
          <div className="row row--between rulesbar">
            <span className="field__hint">Ctrl+Enter to compile. Rules are read by documented patterns, not guessed.</span>
            <button type="submit" className="btn btn--primary" disabled={busy || text.trim() === ''}>
              <Sparkles size={13} aria-hidden="true" />
              Compile rule
            </button>
          </div>
        </form>
        <details className="examples">
          <summary>Examples that work</summary>
          <ul>
            {EXAMPLES.map((ex) => (
              <li key={ex}>
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => {
                    setText(ex);
                    void compile(ex);
                  }}
                >
                  {ex}
                </button>
              </li>
            ))}
          </ul>
        </details>
      </section>

      {compiled?.status === 'unsupported' ? (
        <section className="panel__section">
          <Callout tone="warn" title="This sentence is not one of the supported rule patterns">
            <p>{compiled.reason}</p>
            {compiled.suggestions.length > 0 ? (
              <ul className="plainlist">
                {compiled.suggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : null}
          </Callout>
        </section>
      ) : null}

      {draft && compiled && compiled.status !== 'unsupported' ? (
        <section className="panel__section">
          {compiled.status === 'needs_mapping' ? (
            <Callout tone="info" title="A few cells need your help">
              <p>{compiled.reason}</p>
              {compiled.questions.length > 0 ? (
                <ul className="plainlist">
                  {compiled.questions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              ) : null}
            </Callout>
          ) : (
            <Callout tone="pass" title="Rule compiled. Check it before you add it.">
              {compiled.resolutions.length > 0 ? (
                <ul className="plainlist">
                  {compiled.resolutions.map((r) => (
                    <li key={`${r.phrase}-${r.ref.address}`}>
                      “{r.phrase}” → <span className="mono">{r.ref.address}</span> <span className="faint">({r.via})</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Callout>
          )}
          {compiled.notes.length > 0 ? (
            <ul className="notes">
              {compiled.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {draft ? (
        <section className="panel__section" aria-label="Review rule">
          <h3 className="panel__h">{editing ? 'Edit rule' : 'Review rule'}</h3>
          <RuleForm draft={draft} onChange={setDraft} sheets={sheets} selected={session.selected} />
          {problems.length > 0 ? (
            <Callout tone="warn" title="Fix these before the rule can run">
              <ul className="plainlist">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          {validated?.ok ? (
            <>
              <button type="button" className="linkbtn" aria-expanded={showJson} onClick={() => setShowJson((v) => !v)}>
                {showJson ? 'Hide' : 'Show'} the rule as JSON
              </button>
              {showJson ? <pre className="code">{JSON.stringify(validated.rule, null, 2)}</pre> : null}
            </>
          ) : null}
          <div className="row rulesbar">
            <button type="button" className="btn btn--primary" disabled={!validated?.ok || problems.length > 0} onClick={confirm}>
              <Check size={13} aria-hidden="true" />
              {editing ? 'Save changes' : 'Add rule'}
            </button>
            <button type="button" className="btn" onClick={discard}>
              Discard
            </button>
          </div>
        </section>
      ) : (
        <section className="panel__section">
          <div className="row row--wrap">
            <label className="field__label" htmlFor="manual-type">
              Or map the cells yourself
            </label>
          </div>
          <div className="row">
            <select id="manual-type" className="select" value={manualType} onChange={(e) => setManualType(e.target.value as RuleType)}>
              {(Object.keys(RULE_TYPE_SHORT) as RuleType[]).map((t) => (
                <option key={t} value={t}>
                  {RULE_TYPE_SHORT[t]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCompiled(null);
                setDraft(emptyDraft(manualType, session.activeSheet));
              }}
            >
              <Plus size={13} aria-hidden="true" />
              New rule
            </button>
          </div>
        </section>
      )}

      <section className="panel__section">
        <div className="row row--between">
          <h3 className="panel__h">Rules in this workbook ({session.rules.length})</h3>
        </div>
        {session.rules.length === 0 ? (
          <EmptyState title="No rules yet">Describe a rule above, or open the sample workbook to see four ready-made ones.</EmptyState>
        ) : (
          <ul className="rulelist">
            {session.rules.map((rule) => {
              const result = session.results[rule.id];
              const selected = session.selectedRuleId === rule.id;
              const [from, to] = summary(rule, describe).split(' → ');
              return (
                <li key={rule.id} className={cx('rulecard', selected && 'is-selected')}>
                  <button type="button" className="rulecard__main" aria-pressed={selected} onClick={() => app.selectRule(rule.id)}>
                    <span className="rulecard__name">{rule.name}</span>
                    <span className="rulecard__meta">
                      <span className="badge">{RULE_TYPE_SHORT[rule.type]}</span>
                      {result ? <StatusBadge status={result.status} stale={result.workingCopy !== fingerprint} /> : <span className="faint">Not run yet</span>}
                    </span>
                    <span className="rulecard__map">
                      {to !== undefined ? (
                        <>
                          {from}
                          <ArrowRight size={11} aria-hidden="true" />
                          {to}
                        </>
                      ) : (
                        from
                      )}
                    </span>
                  </button>
                  <div className="rulecard__actions">
                    <button type="button" className="btn btn--sm" disabled={running} aria-label={`Run rule ${rule.name}`} onClick={() => app.runRules([rule.id])}>
                      <Play size={11} aria-hidden="true" />
                      Run
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      aria-label={`Edit rule ${rule.name}`}
                      onClick={() => {
                        setCompiled(null);
                        setDraft(ruleToDraft(rule));
                      }}
                    >
                      <Pencil size={11} aria-hidden="true" />
                      Edit
                    </button>
                    <button type="button" className="btn btn--sm btn--ghost btn--danger" aria-label={`Remove rule ${rule.name}`} onClick={() => app.deleteRule(rule.id)}>
                      <Trash2 size={11} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {session.restored ? (
          <p className="faint">
            <Wrench size={11} aria-hidden="true" /> Rules and edits restored from your last save.
          </p>
        ) : null}
      </section>
    </div>
  );
}
