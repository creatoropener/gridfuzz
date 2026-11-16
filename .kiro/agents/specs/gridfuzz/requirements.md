# GridFuzz: requirements

GridFuzz stress-tests the business rules of a spreadsheet. A person uploads a workbook, states a rule, and GridFuzz generates thousands of seeded scenarios, calculates each, finds violations, shrinks the first failure to a minimal counterexample, highlights the cells involved and explains the failure. The person then edits a formula in a working copy and reruns the identical test.

Notation follows EARS: `WHEN <condition> THE SYSTEM SHALL <behaviour>`. Requirement IDs (R1, R2, ...) are referenced from `tasks.md` and from test names.

## Glossary
- **Rule**: a validated, structured statement about workbook behaviour (the `Rule` type in `src/schemas/rule.ts`).
- **Scenario**: one assignment of values to the rule's input cells.
- **Counterexample**: a scenario (or before/after pair) that violates a rule, shrunk to the simplest one found.
- **Working copy**: the workbook with the person's formula edits applied. The original is never modified.
- **Inconclusive**: a scenario that could not be judged (calculation error, missing or non-numeric value). Never counted as a pass.

---

## R1. Import a workbook
**User story:** As an analyst, I want to open my own .xlsx or .csv file, so that I can test the rules of a spreadsheet I already own.

**Acceptance criteria**
1. WHEN a person drops or picks a file THE SYSTEM SHALL accept `.xlsx` and `.csv` and reject every other type with a message naming the supported types.
2. WHEN a file is larger than 5 MB, or has more than 200,000 filled cells, THE SYSTEM SHALL refuse it and state the limit.
3. WHEN a file is not a valid workbook (for example a renamed text file) THE SYSTEM SHALL show an error that says what is wrong and SHALL NOT open a session.
4. WHEN a workbook has more than one sheet THE SYSTEM SHALL let the person choose the sheet before opening it.
5. WHEN a file is read THE SYSTEM SHALL show a preview of formulas, calculated values and the cells each formula reads.
6. WHEN a formula cell has no cached value in the file THE SYSTEM SHALL still import the formula and SHALL calculate it itself; cached values stored in the file are never used as results.
7. THE SYSTEM SHALL read and calculate files entirely in the browser; no workbook content SHALL be sent to any server.

## R2. State a rule
**User story:** As an analyst, I want to describe a rule in plain English or by choosing cells, so that I do not have to write test code.

**Acceptance criteria**
1. WHEN a person enters a sentence that matches a documented pattern THE SYSTEM SHALL compile it into a draft rule and show how each phrase was matched to a cell.
2. WHEN a sentence matches a pattern but a phrase cannot be matched to exactly one cell THE SYSTEM SHALL ask the person to map that cell rather than guess.
3. WHEN a sentence matches no documented pattern THE SYSTEM SHALL say so, list the supported patterns, and SHALL NOT invent a rule.
4. THE SYSTEM SHALL support these rule types: monotonic increasing, monotonic decreasing, bounds (min, max, between), non-negative, invariant (`==`, `<=`, `>=` between expressions) and conditional (`when` / `then`).
5. WHEN a rule is built manually THE SYSTEM SHALL offer the cell currently selected in the grid as an input or output.
6. WHEN a draft rule is produced THE SYSTEM SHALL show it for review and SHALL run it only after the person confirms.
7. THE SYSTEM SHALL validate every rule with the Zod `RuleSchema` and report each problem next to its field.
8. THE SYSTEM SHALL evaluate rule expressions with a hand-written parser; `eval` and `new Function` SHALL NOT be used.
9. THE SYSTEM SHALL compile rules behind a `RuleCompiler` interface so that another compiler can be added without changing the engine.

## R3. Generate and run scenarios
**User story:** As an analyst, I want thousands of scenarios checked quickly without freezing the page, so that I can trust "no violation found".

**Acceptance criteria**
1. WHEN a run starts THE SYSTEM SHALL generate scenarios with fast-check from the rule's input ranges and precision, and SHALL calculate each one with HyperFormula inside a Web Worker.
2. THE SYSTEM SHALL use a private calculation instance per run, and a run SHALL NOT change the working copy or the original.
3. WHEN the same rule, workbook, seed and scenario count are run twice THE SYSTEM SHALL produce identical results.
4. THE SYSTEM SHALL let the person choose the scenario count (10 to 50,000) and the seed, and SHALL record both on every result and report.
5. WHILE a run is in progress THE SYSTEM SHALL show progress and SHALL let the person cancel; cancelling SHALL terminate the worker and leave results from earlier runs intact.
6. WHEN a scenario calculates to an error, a blank, or a non-numeric value in a cell the rule needs THE SYSTEM SHALL count it as inconclusive with a stated reason.
7. WHEN every executed scenario passes THE SYSTEM SHALL report "no violation found in N scenarios" and SHALL NOT describe the rule as proven.
8. WHEN no scenario could be judged THE SYSTEM SHALL report the rule as inconclusive, not passed.
9. WHEN a run is cancelled, fails to start, or the worker crashes THE SYSTEM SHALL show an error state and keep the session usable.

## R4. Shrink and explain a counterexample
**User story:** As an analyst, I want the smallest example of the failure and the cells involved, so that I can see why the rule breaks.

**Acceptance criteria**
1. WHEN a scenario violates a rule THE SYSTEM SHALL shrink it toward the simplest failing scenario, staying close to the values currently in the workbook.
2. THE SYSTEM SHALL report the number of scenarios executed, the index of the first failure, the failure count and the shrink steps taken.
3. WHEN a counterexample is shown THE SYSTEM SHALL list the input and output cells with their before and after values and the change.
4. WHEN a counterexample is shown THE SYSTEM SHALL separate **confirmed** findings (observed in the calculated values) from **suggested** causes (heuristics) and label each.
5. THE SYSTEM SHALL highlight the failing cells in the grid and SHALL offer a "View counterexample" action that shows the grid with the counterexample's values applied, without changing the working copy.
6. THE SYSTEM SHALL provide a "Copy counterexample" action producing readable text that includes the seed.

## R5. Fix and retest
**User story:** As an analyst, I want to edit a formula and rerun the identical test, so that I can prove my fix works.

**Acceptance criteria**
1. WHEN a person edits a formula or value THE SYSTEM SHALL change only the working copy and SHALL show that the working copy differs from the original.
2. WHEN a person reruns a rule after an edit THE SYSTEM SHALL use the same rule, seed and scenario count.
3. WHEN a rerun follows an edit THE SYSTEM SHALL show the previous and the new result side by side, including a replay of the earlier counterexample.
4. WHEN the person asks to revert THE SYSTEM SHALL restore the original formulas.
5. THE SYSTEM SHALL let the person download the original file unchanged and SHALL provide the working copy separately.
6. WHEN an edited formula is not valid THE SYSTEM SHALL keep the previous content and say why.

## R6. Results and reports
**User story:** As an analyst, I want a summary and an exportable record, so that I can share what I tested and what I found.

**Acceptance criteria**
1. THE SYSTEM SHALL show totals for rules, passed, failed and inconclusive, and for scenarios executed.
2. THE SYSTEM SHALL export a JSON report containing the tool version, workbook name, rules, seed, scenario counts, results, counterexamples and the formula edits that make up the working copy.
3. WHEN a rule result carries warnings (unsupported or volatile functions, errors in the baseline) THE SYSTEM SHALL show them with the result.
4. THE SYSTEM SHALL let the person rerun a single rule or all rules.

## R7. Freight Quote sample
**User story:** As a first-time visitor, I want a ready example, so that I can see GridFuzz find a real bug in under a minute.

**Acceptance criteria**
1. THE SYSTEM SHALL ship a Freight Quote workbook whose volume rebate applies the 5% rebate to the whole subtotal once it passes 3,500, so that a small increase in cost lowers the final price.
2. WHEN the sample's flagship rule is run with the default seed THE SYSTEM SHALL find the violation by calculation; no counterexample, count or timing SHALL be hardcoded.
3. WHEN the sample's fix (`=MAX(B10-B17,0)*B18`) is applied and the rule rerun with the same seed THE SYSTEM SHALL report no violation found.
4. THE SYSTEM SHALL require no account and no API key for the sample.

## R8. Dashboard and persistence
**User story:** As a returning user, I want to see my recent work, so that I can pick up where I left off.

**Acceptance criteria**
1. THE SYSTEM SHALL display only statistics derived from runs that actually executed; a new user SHALL see zeros.
2. THE SYSTEM SHALL keep recent workbooks, activity, theme and per-workbook rules and edits in `localStorage`, and SHALL NOT store workbook contents.
3. WHEN a person chooses "Clear local data" THE SYSTEM SHALL remove everything GridFuzz stored.
4. WHEN storage is unavailable or full THE SYSTEM SHALL continue to work for the session.

## R9. Interface quality
**User story:** As any user, I want an interface that is clear, fast and usable with a keyboard, so that I can rely on it.

**Acceptance criteria**
1. THE SYSTEM SHALL present a three-pane workspace (workbook, rules, results/counterexample) with a toolbar for upload, save, run tests and export.
2. THE SYSTEM SHALL support dark and light themes and SHALL remember the choice.
3. THE SYSTEM SHALL provide loading, empty, error, success and unsupported states for import, rule compilation and runs.
4. THE SYSTEM SHALL be operable by keyboard, expose accessible names for icon-only controls, respect `prefers-reduced-motion`, and not scroll horizontally at 390 px wide.
5. WHEN a mobile viewport is used THE SYSTEM SHALL provide a switcher between the workbook, rules and results panes.

## R10. Honesty and privacy
**Acceptance criteria**
1. THE SYSTEM SHALL make no network request carrying workbook content, and SHALL make no request to any host other than the page's own origin.
2. WHEN a workbook uses a function the calculation engine lacks, or a volatile function, THE SYSTEM SHALL warn before running and SHALL report affected scenarios as inconclusive.
3. THE SYSTEM SHALL NOT present suggested causes as confirmed facts.

## Out of scope
Macros (VBA), pivot tables, charts inside workbooks, external links, multi-user editing, server storage, and live AI rule interpretation (the compiler interface leaves room for it; a key must never ship in the client).
