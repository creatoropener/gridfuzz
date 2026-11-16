// Generates public/samples/freight-quote.xlsx and .csv from the same JSON the app uses.
// Run with: npm run samples
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = JSON.parse(readFileSync(join(root, 'src/engine/samples/freight-quote.json'), 'utf8'));

const ws = {};
let maxRow = 0;
let maxCol = 0;
for (const item of sample.cells) {
  const { r, c } = XLSX.utils.decode_cell(item.a);
  maxRow = Math.max(maxRow, r);
  maxCol = Math.max(maxCol, c);
  if (item.f) ws[item.a] = { t: 'n', f: item.f.slice(1) };
  else if (typeof item.v === 'number') ws[item.a] = { t: 'n', v: item.v };
  else ws[item.a] = { t: 's', v: String(item.v) };
}
ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
ws['!cols'] = [{ wch: 28 }, { wch: 14 }];

const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, ws, sample.sheet);

const outDir = join(root, 'public/samples');
mkdirSync(outDir, { recursive: true });
XLSX.writeFile(book, join(outDir, 'freight-quote.xlsx'));
writeFileSync(join(outDir, 'freight-quote.csv'), XLSX.utils.sheet_to_csv(ws, { forceQuotes: false }));
console.log('Wrote public/samples/freight-quote.xlsx and freight-quote.csv');
