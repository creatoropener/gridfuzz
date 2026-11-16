---
inclusion: fileMatch
fileMatchPattern: ["tests/**", "e2e/**", "src/engine/**"]
---
# GridFuzz: testing steering

## Commands
- `npm run typecheck` strict TypeScript, no emit.
- `npm test` Vitest unit and property tests (`tests/**/*.test.ts`).
- `npm run test:e2e` Playwright against the production build (`npm run build` runs first).

## What must stay covered
- **Rule parsing and validation:** every documented pattern in `PATTERN_DOCS` has a compile test; unsupported and ambiguous sentences are refused, not guessed.
- **Generators:** values stay in range and on the precision grid; shrinking stays valid at every step and heads toward the current value.
- **Property evaluation:** each rule type has a passing and a failing case with a known answer.
- **Shrinking:** the sample bug shrinks to the exact threshold pair, deterministically per seed.
- **Calculation:** formula results are checked against hand-computed values; errors surface as data, not numbers; engine instances are isolated.
- **Regression:** after the known fix the same seed and run count passes, and the previous counterexample replays as a pass.
- **Honesty:** the original workbook object is unchanged by any run; inconclusive results are never counted as passes; no result is hardcoded.
- **E2E:** the 9-step freight demo (open, rule, run, violation, shrunk counterexample, highlight, fix, rerun, pass), upload and rejection of bad files, export contents, cancel, and "no request leaves localhost".

## Conventions
- Prefer deterministic seeds in tests. A randomly seeded test that can flake is a bug.
- Test real behaviour. Do not assert against copies of the implementation's own constants when a hand-computed value exists.
- When a test fails, find out whether the code or the test is wrong before touching either.
- Vitest here swallows `console.log`; write debug output to a file.
- Playwright: `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can point at an installed Chromium.
