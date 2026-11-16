---
inclusion: always
---
# GridFuzz: product steering

GridFuzz stress-tests the business rules of a spreadsheet. A person states a rule ("increasing fuel surcharge must never reduce final freight cost"), and GridFuzz generates thousands of scenarios, calculates each one, finds violations, shrinks the first failure to a minimal counterexample, highlights the cells involved, and lets the person edit a formula and rerun the identical test.

Tagline: **Break your spreadsheet before your business does.** (Kiroween 2026, Frankenstein category: a monster stitched from a property-based tester, a spreadsheet engine and a rule compiler.)

## Who it is for
Analysts, finance and operations people who own spreadsheets that drive money decisions and have no test suite.

## Non-negotiable product rules
1. **Everything runs in the browser.** No server, no account, no API key, no upload. Do not add network calls that carry workbook content.
2. **Never fake a result.** Statistics, counterexamples, pass/fail and timings come from real runs. No hardcoded outputs, no seeded dashboard numbers. The sample workbook's bug must be found by the engine, not announced by the UI.
3. **Be honest about certainty.** "No violation found in N scenarios" is evidence, not proof. Findings are labelled *confirmed* (observed in the counterexample) or *suggested* (a lead). Never present a heuristic as a root cause.
4. **Inconclusive is its own outcome.** Division by zero, circular references, unsupported functions, missing or non-numeric values are reported separately and never counted as passes.
5. **The original file is never modified.** Edits live in a working copy; "download original" returns the uploaded bytes unchanged.
6. **Say what is unsupported.** Unsupported or volatile functions, array formulas and external links are surfaced as warnings, never silently skipped.
7. **A reliable demo beats more features.** The freight-quote flow must work end to end on a clean checkout.

## Voice
Plain verbs, sentence case, specific errors that say what to do next. No apologies, no hype, no emoji.
