#!/usr/bin/env node
/**
 * Captures the README screenshots from a running copy of the production build.
 *
 *   npm run build && npm run preview -- --port 4173      (in one terminal)
 *   npm run screenshots                                  (in another)
 *
 * Environment:
 *   GRIDFUZZ_URL                      where the app is served (default http://localhost:4173)
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE    use an already-installed Chromium instead of Playwright's
 *
 * Every screenshot shows a real run: the script drives the UI exactly as a person would.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const url = process.env.GRIDFUZZ_URL ?? 'http://localhost:4173';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const page = await context.newPage();
const shot = async (name) => {
  await page.screenshot({ path: join(out, name) });
  console.log(`wrote docs/screenshots/${name}`);
};

try {
  await page.goto(url);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await shot('01-dashboard.png');

  await page.getByRole('button', { name: 'Open the freight quote sample' }).click();
  await page.getByRole('grid').waitFor();
  await shot('02-workspace.png');

  await page.getByRole('button', { name: /^Run rule Raising fuel surcharge/ }).click();
  await page.getByText('Counterexample found').waitFor({ timeout: 60_000 });
  await shot('03-counterexample.png');

  await page.getByRole('button', { name: /known fix/ }).click();
  await page.getByText('The rule now holds').waitFor({ timeout: 60_000 });
  await shot('04-fix-verified.png');

  await page.getByRole('button', { name: /Switch to light theme/ }).click();
  await shot('05-light-theme.png');
} finally {
  await browser.close();
}
