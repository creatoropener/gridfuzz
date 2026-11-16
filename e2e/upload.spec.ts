import { expect, test } from '@playwright/test';

const SAMPLE_XLSX = new URL('../public/samples/freight-quote.xlsx', import.meta.url).pathname;
const SAMPLE_CSV = new URL('../public/samples/freight-quote.csv', import.meta.url).pathname;

test.describe('Upload and rule compiler', () => {
  test('upload an .xlsx, review the import, compile a plain-English rule and find the bug', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New test' }).first().click();
    await page.getByTestId('file-input').setInputFiles(SAMPLE_XLSX);

    // Import summary: sheets, formulas, values and what each formula reads.
    await expect(page.getByRole('heading', { name: 'freight-quote.xlsx' })).toBeVisible();
    await expect(page.getByText(/1 sheet · 5 formulas/)).toBeVisible();
    const row = page.locator('.table tbody tr').filter({ has: page.getByRole('cell', { name: 'B11', exact: true }) });
    await expect(row).toContainText('=IF(B10>B17,B10*B18,0)');
    await expect(row).toContainText('B10, B17, B18');
    await page.getByRole('button', { name: 'Open in workspace' }).click();

    // Values come from GridFuzz's own calculation, not from the file.
    await expect(page.locator('[data-address="B14"]')).toHaveText('3,395.35');
    await expect(page.getByText('No rules yet')).toBeVisible();

    // Compile, review, confirm.
    await page.getByLabel('Describe a rule in plain English').fill('Increasing fuel surcharge must never reduce final freight cost.');
    await page.getByRole('button', { name: 'Compile rule' }).click();
    await expect(page.getByText('Rule compiled. Check it before you add it.')).toBeVisible();
    await expect(page.getByText(/“fuel surcharge” → B6/)).toBeVisible();
    await expect(page.getByText(/“final freight cost” → B14/)).toBeVisible();
    await page.getByRole('button', { name: 'Show the rule as JSON' }).click();
    await expect(page.locator('.code')).toContainText('"type": "monotonic_increasing"');
    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByText('Rules in this workbook (1)')).toBeVisible();

    // Run it: the bug is found in an uploaded file exactly as in the built-in sample.
    await page.getByRole('button', { name: 'Run all', exact: true }).click();
    await expect(page.locator('.callout--fail')).toContainText('lowered Final freight cost');
  });

  test('a sentence outside the supported patterns is refused honestly', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open the freight quote sample' }).click();
    await page.getByLabel('Describe a rule in plain English').fill('The vibes of the quote should feel premium.');
    await page.getByRole('button', { name: 'Compile rule' }).click();
    await expect(page.getByText('This sentence is not one of the supported rule patterns')).toBeVisible();
  });

  test('csv upload works and surfaces that formulas were detected', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New test' }).first().click();
    await page.getByTestId('file-input').setInputFiles(SAMPLE_CSV);
    await expect(page.getByRole('heading', { name: 'freight-quote.csv' })).toBeVisible();
    await expect(page.getByText('Cells starting with "=" in the CSV were treated as formulas.')).toBeVisible();
  });

  test('bad files are rejected with a clear reason', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New test' }).first().click();
    const input = page.getByTestId('file-input');

    await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.getByText('notes.txt was not opened')).toBeVisible();
    await expect(page.locator('.drop__error')).toContainText('GridFuzz opens .xlsx and .csv files');

    await input.setInputFiles({ name: 'fake.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not a zip file at all') });
    await expect(page.getByText('fake.xlsx was not opened')).toBeVisible();
    await expect(page.locator('.drop__error')).toContainText('not a valid ZIP');

    await input.setInputFiles({ name: 'huge.csv', mimeType: 'text/csv', buffer: Buffer.alloc(6 * 1024 * 1024, 'a,') });
    await expect(page.getByText('huge.csv was not opened')).toBeVisible();
    await expect(page.locator('.drop__error')).toContainText('The limit is 5 MB');
  });

  test('theme choice is remembered and nothing leaves the browser', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.hostname !== 'localhost') external.push(req.url());
    });
    await page.goto('/');
    const before = await page.locator('html').getAttribute('data-theme');
    await page.getByRole('button', { name: /Switch to (light|dark) theme/ }).click();
    const after = await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(before);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', after as string);

    await page.getByRole('button', { name: 'Open the freight quote sample' }).click();
    await page.getByRole('button', { name: 'Run all', exact: true }).click();
    await expect(page.getByText('Counterexample found')).toBeVisible();
    expect(external).toEqual([]);
  });
});
