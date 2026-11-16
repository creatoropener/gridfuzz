# GridFuzz: design

Requirements: [requirements.md](requirements.md). Steering: `.kiro/steering/architecture.md`.

## Overview
A static single-page app. Everything runs in the browser. The pure TypeScript `engine/` (no React, no DOM) is used unchanged by the UI, a Web Worker and Vitest.

```
 .xlsx / .csv ──▶ importer ──▶ WorkbookModel (original, immutable)
                                   │  applyEdits(edits) → copy
 sentence ──▶ RuleCompiler ──▶ RuleDraft ──▶ Zod RuleSchema ──▶ Rule
                                   │
 Run ──▶ testRunnerClient ──▶ Worker ──▶ runRule ──▶ makeRunner(property)
                                                       ├─ fast-check scenarios
                                                       ├─ CalcEngine (HyperFormula, private instance)
                                                       └─ shrink + explain
 RuleResult ──▶ UI (results, counterexample, grid marks) ──▶ report JSON
```

## Components

| Module | Responsibility |
|---|---|
| `engine/workbook/` | `WorkbookModel`, A1 helpers, edits, labels, importer validation. `sheetjsAdapter.ts` is the only SheetJS import (`sheetStubs: true` keeps formula cells that have no cached value). |
| `engine/calculation/CalcEngine.ts` | Wraps HyperFormula (`gpl-v3` key). One instance per run; set/get values, evaluate, dependency queries (`getPrecedents`, `getDependents`, with range vertices resolved to the formulas that read them). |
| `engine/calculation/formulaAnalysis.ts` | Finds unsupported and volatile functions and baseline errors; produces `Diagnostic`s. |
| `engine/expression/` | Tokenizer, parser and AST evaluator for rule expressions (`SUM MIN MAX AVERAGE ABS ROUND`, `+ - * / ^`, `%`, cell refs and ranges). |
| `engine/generators/numberArbitrary.ts` | Scaled-integer arbitraries. A value is an offset from the cell's current value, so shrinking heads toward the user's real data. |
| `engine/properties/` | One `PropertyDefinition` per rule type; `runner.ts` is the generic runner; `explain.ts` builds confirmed/suggested findings. |
| `engine/rule-compiler/` | `RuleCompiler` interface, `LocalRuleCompiler` (documented patterns), cell resolver, `RuleDraft` → `Rule`. |
| `engine/runRule.ts` | Validates a rule, builds the engine, runs, returns a `RuleResult`. |
| `workers/testRunner.worker.ts`, `services/testRunnerClient.ts` | One worker per run; progress messages; cancel via `terminate()`. |
| `services/` | `storage` (guarded localStorage), `stats`, `report`. |
| `state/` | `useAppState` (single hook), `AppContext`, grid highlight computation. |
| `components/` | Header, Dashboard, ImportView, Workspace (GridPane, RulesPanel, ResultsPanel, CounterexamplePanel, RunBar, RuleForm). |

## Data models
- `WorkbookModel { id, name, sizeBytes, source: 'upload' | 'sample', sheets: SheetModel[], warnings: Diagnostic[] }`; `SheetModel { name, rowCount, colCount, cells: Record<address, CellModel> }`; `CellModel { address, row, col, value, formula, cachedValue? }` (the cached value is kept for display only, never used as a result).
- `CellEdit { sheet, address, content }`; the working copy is `applyEdits(original, edits)`.
- `Rule` (discriminated union on `type`): `monotonic_increasing | monotonic_decreasing | bounds | non_negative | invariant | conditional`. Each carries `InputSpec[]` (cell, min, max, precision), output cells or expressions, tolerance, and `source` (`sample | compiler | manual`).
- `TestConfig { numRuns: 10..50000, seed: 0..2^31-1 }`; defaults 1000 runs, seed 1031.
- `RuleRunResult { ruleId, status: passed | failed | inconclusive, seed, requestedRuns, executed, passed, failed, inconclusive, inconclusiveReasons, failureRate, durationMs, interrupted, firstFailureAt, shrink, counterexample, warnings, errors, engine, ranAt, workingCopy }`.
- `ShrinkInfo { steps, evaluations, originalFoundAt, originalScenario, reproducible }`.
- `Counterexample { ruleId, ruleType, seed, cells: CounterexampleCell[], violation, expected, actual, difference, findings: Finding[] (confirmed | suggested), highlight: HighlightSet, scenario }`; each `CounterexampleCell` has a role (`input | context | output | path | referenced`), original and scenario values, delta and `movedAgainstRule`.

## Key decisions

**Status semantics.** `failed` if any scenario failed; `passed` only if at least one scenario passed and none failed; otherwise `inconclusive`. UI copy says "no violation found in N scenarios".

**Two passes.** A census pass counts every scenario (so the failure rate is real). A second seeded pass finds the first failure and shrinks it. This keeps counts honest and shrinking deterministic.

**Monotonic pairs.** `fc.oneof(widePair, neighbourPair)` mixes arbitrary before/after pairs with adjacent values, because threshold bugs (like the rebate) only show at small steps.

**Confirmed vs suggested.** The first cell on the dependency path from the raised input to the output that moved against the rule is a *confirmed* finding, because both values were calculated. The heuristic lead (a step-like function such as `IF`) is *suggested*.

**Isolation.** `applyEdits` returns a copy. Each run builds its own HyperFormula instance. After each scenario the runner restores the inputs it touched, and a signature check detects leaks. The engine is never destroyed inside a React memo (double-render safety).

**Dependencies.** HyperFormula `getCellDependents` returns range vertices for `SUM`-style reads; `CalcEngine.getDependents` resolves them breadth-first to the formulas that read the range, de-duplicated and capped.

**Persistence.** `localStorage` keys use the `gridfuzz.` prefix: stats, recent, activity, theme, and `workspace.<id>` (rules, config, edits). Workbook contents are never stored; reopening a recent workbook asks for the file again (the built-in sample reloads from the static file).

**Licence.** HyperFormula is GPLv3, so GridFuzz is GPL-3.0-only. SheetJS (Apache-2.0), fast-check (MIT), Zod (MIT), React (MIT) are compatible.

**AI extension point.** `RuleCompiler` is an interface. An AI-backed compiler would run behind a server-side proxy that holds the key and returns a `RuleDraft`, which still goes through `RuleSchema` and user confirmation. Not implemented; no key is ever read in the browser.

## Error handling

| Situation | Behaviour |
|---|---|
| Wrong type, too large, corrupt file | Import error callout with the reason; no session opened. |
| Formula calculates to error or blank | Scenario is inconclusive with a reason; reasons are tallied per rule. |
| Unsupported function | Warning on import and on results; affected scenarios inconclusive. |
| Volatile function | Warning; reproducibility not guaranteed. |
| Invalid rule | Zod issues shown beside the fields; rule cannot run. |
| Worker crash or start failure | Run state `error` with message; session stays usable. |
| Cancel | Worker terminated; earlier results kept. |
| `localStorage` unavailable | Silent in-memory fallback; app keeps working. |

## Testing strategy
- **Unit (Vitest, deterministic seeds):** expression parser and evaluator, schema, generators, each property type with passing and failing cases, rule compiler patterns and refusals, workbook import round trip, `applyEdits` immutability, CalcEngine behaviour and isolation, report and stats.
- **Integration:** the freight demo through `runRule` (find, shrink to exact threshold pair, fix passes, same seed).
- **Detection rate:** at 1000 scenarios the bug is found for 40 of 40 tested seeds; the UI offers 1,000 as the default.
- **E2E (Playwright, production build):** the full demo, a hand-typed fix, JSON report content, cancel, upload and rejection of bad files, theme persistence, no off-origin requests.
