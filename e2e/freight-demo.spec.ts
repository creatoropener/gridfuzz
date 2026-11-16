import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SAMPLE_XLSX = new URL('../public/samples/freight-quote.xlsx', import.meta.url);

async function openSample(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open the freight quote sample' }).click();
  await expect(page.getByRole('grid')).toBeVisible();
}

test.describe('Freight quote demo', () => {
  test('dashboard starts empty: no pre-filled statistics', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Break your spreadsheet');
    const ledger = page.locator('.ledger');
    for (const row of await ledger.locator('.ledger__row').all()) {
      await expect(row.locator('dd')).toHaveText('0');
    }
    await expect(page.getByText('No workbooks yet')).toBeVisible();
  });

  test('find, shrink, explain, fix and retest, end to end', async ({ page }) => {
    await openSample(page);

    // The sample opens with its four rules; the flagship one is selected and its cells are marked.
    await expect(page.getByText('Rules in this workbook (4)')).toBeVisible();
    await expect(page.locator('[data-address="B6"]')).toHaveClass(/mark-input/);
    await expect(page.locator('[data-address="B14"]')).toHaveClass(/mark-output/);

    // Run the flagship rule: the default seed and 1,000 scenarios find the bug.
    await page.getByRole('button', { name: /^Run rule Raising fuel surcharge/ }).click();
    await expect(page.getByText('Counterexample found')).toBeVisible();

    // Shrunk to the exact threshold boundary: a $1 step in the fuel surcharge crosses the 3,500 rebate threshold.
    const violation = page.locator('.callout--fail');
    await expect(violation).toContainText('Raising Fuel surcharge (B6) from 179 to 180 lowered Final freight cost (B14) from 3,815 to 3,625.29');
    await expect(page.getByText(/7 of 1,000 scenarios failed/)).toBeVisible();
    await expect(page.getByText(/135 steps/)).toBeVisible();

    // Cells are highlighted: B12 moved against the rule (confirmed); B11 is only a suspect (suggested).
    await expect(page.locator('[data-address="B12"]')).toHaveClass(/mark-failing/);
    await expect(page.locator('[data-address="B11"]')).toHaveClass(/mark-suspect/);

    // Confirmed facts and suggested causes are labelled differently.
    await expect(page.locator('.findings .badge', { hasText: 'Confirmed' }).first()).toBeVisible();
    await expect(page.locator('.findings .badge', { hasText: 'Suggested' }).first()).toBeVisible();

    // View Counterexample: the grid shows the failing scenario's own values, on a throw-away copy.
    await page.getByRole('button', { name: 'View counterexample' }).click();
    await expect(page.locator('.scenario-banner')).toContainText('This is not your data');
    await expect(page.locator('[data-address="B6"]')).toHaveText('179');
    await expect(page.locator('[data-address="B11"]')).toHaveText('0');
    await page.getByRole('button', { name: 'Higher input' }).click();
    await expect(page.locator('[data-address="B6"]')).toHaveText('180');
    await expect(page.locator('[data-address="B11"]')).toHaveText('175.05');
    await expect(page.locator('[data-address="B14"]')).toHaveText('3,625.29');
    await page.getByRole('button', { name: 'Back to working copy' }).click();
    await expect(page.locator('[data-address="B6"]')).toHaveText('180'); // the real workbook value
    await expect(page.locator('[data-address="B14"]')).toHaveText('3,395.35');

    // Fix: edit the formula in the working copy, rerun the identical rule.
    await page.getByRole('button', { name: /known fix/ }).click();
    await expect(page.getByText('The rule now holds')).toBeVisible();
    await expect(page.getByText(/Before the edit 7 of 1,000 scenarios failed; now 0 of 1,000 do/)).toBeVisible();
    await expect(page.getByText('Same inputs, now passes.')).toBeVisible();
    await expect(page.locator('.replay__table')).toContainText('3,625.29');
    await expect(page.locator('.replay__table')).toContainText('3,816.04');

    // The original is untouched: only the working copy carries the edit.
    await expect(page.locator('.crumb')).toContainText('1 edit');
    await expect(page.locator('.edits__item')).toContainText('=MAX(B10-B17,0)*B18');
    await expect(page.locator('.edits__item')).toContainText('was =IF(B10>B17,B10*B18,0)');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    await page.getByRole('menuitem', { name: /Original workbook/ }).click();
    const original = await download;
    const path = await original.path();
    expect(readFileSync(path).equals(readFileSync(SAMPLE_XLSX))).toBe(true);
  });

  test('the same fix typed by hand works, and exports are real', async ({ page }) => {
    await openSample(page);
    await page.getByRole('button', { name: 'Run all', exact: true }).click();
    await expect(page.getByText('Counterexample found')).toBeVisible();

    // One of four rules fails; the other three pass.
    await page.getByRole('tab', { name: 'Results' }).click();
    await expect(page.getByText('Violation found').first()).toBeVisible();
    await expect(page.locator('.totals')).toContainText('4'); // rules
    await expect(page.locator('.result')).toHaveCount(4);

    // Type the fix into the formula bar.
    await page.locator('[data-address="B11"]').click();
    await page.getByLabel(/^Cell content/).fill('=MAX(B10-B17,0)*B18');
    await page.getByLabel(/^Cell content/).press('Enter');
    await expect(page.locator('.crumb')).toContainText('1 edit');
    await expect(page.locator('[data-address="B11"]')).toHaveClass(/is-edited/);

    // Results made before the edit are labelled outdated until they are rerun.
    await expect(page.getByText('(outdated)').first()).toBeVisible();
    await page.getByRole('button', { name: 'Rerun all' }).click();
    await expect(page.getByText('(outdated)')).toHaveCount(0);
    await expect(page.locator('.totals')).toContainText('Violation');

    // JSON report: complete and consistent with what ran.
    const reportDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export JSON report' }).click();
    const report = JSON.parse(readFileSync(await (await reportDownload).path(), 'utf8')) as {
      format: string;
      workingCopy: { edited: boolean; edits: Array<{ address: string; content: string }> };
      summary: { rules: number; rulesPassed: number; rulesFailed: number; scenariosExecuted: number };
      config: { seed: number; numRuns: number };
    };
    expect(report.format).toBe('gridfuzz-report/1');
    expect(report.workingCopy.edited).toBe(true);
    expect(report.workingCopy.edits[0]).toMatchObject({ address: 'B11', content: '=MAX(B10-B17,0)*B18' });
    expect(report.summary).toMatchObject({ rules: 4, rulesPassed: 4, rulesFailed: 0, scenariosExecuted: 4000 });
    expect(report.config).toEqual({ seed: 1031, numRuns: 1000 });

    // The dashboard now reports what really ran.
    await page.getByRole('button', { name: 'GridFuzz dashboard' }).click();
    await expect(page.locator('.ledger')).toContainText('8,000'); // two full runs of four rules
  });

  test('a run can be cancelled and leaves the app usable', async ({ page }) => {
    await openSample(page);
    await page.getByRole('combobox', { name: 'Scenarios per rule' }).selectOption('custom');
    await page.getByLabel('Custom number of scenarios').fill('50000');
    await page.getByRole('button', { name: 'Run all', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: 'Test progress' })).toBeVisible();
    await page.locator('.runbar').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Run all', exact: true })).toBeEnabled();
  });
});
