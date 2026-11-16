---
inclusion: fileMatch
fileMatchPattern: ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
---
# GridFuzz: architecture steering

## Layers (dependencies point downward only)
```
components/  state/            React UI, one app-state hook + context
services/    workers/          Worker client, report export, stats, storage
engine/      schemas/ types/   Pure TypeScript: no React, no DOM
```
`engine/` must stay free of React and browser globals so it runs unchanged in a Web Worker and in Vitest.

## Key modules
- `engine/workbook/` plain `WorkbookModel`; the **only** place SheetJS is imported is `sheetjsAdapter.ts`.
- `engine/calculation/CalcEngine.ts` wraps HyperFormula (`licenseKey: 'gpl-v3'`). One private instance per run; instances never share state.
- `engine/properties/` one `PropertyDefinition` per rule type, executed by the generic `makeRunner` (census pass counts every scenario; a second seeded pass shrinks).
- `engine/generators/numberArbitrary.ts` values are integers on the precision grid, generated as an offset from the cell's current value so shrinking heads toward the user's real data.
- `engine/rule-compiler/` `RuleCompiler` interface + `LocalRuleCompiler` (documented regex patterns). An AI compiler may be added behind the same interface through a server-side proxy; never put an API key in the client.
- `engine/expression/` hand-written parser/evaluator for rule expressions. **No `eval`, no `Function`.**
- `workers/testRunner.worker.ts` + `services/testRunnerClient.ts` one Worker per run; cancel = `terminate()`.

## Invariants
- Rules are validated by `RuleSchema` (Zod) before they reach the engine. Compilers return `RuleDraft`s; `draftToRule` validates.
- `applyEdits` returns a copy. Property runners restore every input they touch after each scenario, and a signature check detects leaks.
- Seeds are explicit and recorded on every result and counterexample.
- localStorage holds only metadata, rules, settings and the user's own edits. Never workbook contents.
- GPL-3.0-only licence (HyperFormula is GPLv3). New dependencies must be GPL-compatible; regenerate `THIRD_PARTY_NOTICES.md` with `npm run notices`.
