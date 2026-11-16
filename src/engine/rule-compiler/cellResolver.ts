import type { CellRefModel, WorkbookModel } from '../../types/workbook';
import { normalizeAddress, parseAddress, toAddress } from '../workbook/a1';

export type LabelResolution =
  | { kind: 'resolved'; ref: CellRefModel; via: string }
  | { kind: 'ambiguous'; candidates: Array<{ ref: CellRefModel; via: string }> }
  | { kind: 'unresolved' };

const STOP_WORDS = new Set(['the', 'a', 'an', 'our', 'my', 'of', 'in', 'for', 'cell', 'value', 'amount', 'field']);

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Lower-case word tokens with light normalisation (plural, "%" ↔ "percent", punctuation, units in brackets). */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/%/g, ' percent ')
    .replace(/percentage/g, 'percent')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .map(singular);
}

const CELL_PHRASE = /^(?:(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!)?\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/;

/** Direct cell references: `B6`, `$B$6`, `Quote!B6`, `'My Sheet'!B6`. Sheet names are matched case-insensitively. */
export function parseCellPhrase(phrase: string, workbook: WorkbookModel, activeSheet: string): CellRefModel | null {
  const match = CELL_PHRASE.exec(phrase.trim());
  if (!match) return null;
  const address = normalizeAddress(`${match[3]}${match[4]}`);
  if (!address) return null;
  const sheetText = (match[1] ?? match[2])?.replace(/''/g, "'");
  if (sheetText === undefined) return { sheet: activeSheet, address };
  const sheet = workbook.sheets.find((s) => s.name.toLowerCase() === sheetText.toLowerCase());
  return sheet ? { sheet: sheet.name, address } : null;
}

interface LabelCandidate {
  ref: CellRefModel;
  labelText: string;
  labelAddress: string;
  sheet: string;
  tokens: string[];
}

/** Text cells that sit next to a value, each paired with the value cell it labels. */
function collectCandidates(workbook: WorkbookModel): LabelCandidate[] {
  const out: LabelCandidate[] = [];
  for (const sheet of workbook.sheets) {
    for (const cell of Object.values(sheet.cells)) {
      if (cell.formula !== null || typeof cell.value !== 'string') continue;
      const text = cell.value.trim();
      if (text === '' || text.length > 60) continue;
      const toks = tokens(text);
      if (toks.length === 0) continue;

      // Value to the right on the same row (skipping empty cells, stopping at the next text label).
      let target: string | null = null;
      for (let col = cell.col + 1; col <= Math.min(cell.col + 3, sheet.colCount - 1); col++) {
        const right = sheet.cells[toAddress(col, cell.row)];
        if (!right) continue;
        if (right.formula === null && typeof right.value === 'string') break;
        target = right.address;
        break;
      }
      // Otherwise a value directly below (column-header style).
      if (target === null) {
        const below = sheet.cells[toAddress(cell.col, cell.row + 1)];
        if (below && (below.formula !== null || typeof below.value !== 'string')) target = below.address;
      }
      if (target === null) continue;
      out.push({
        ref: { sheet: sheet.name, address: target },
        labelText: text,
        labelAddress: cell.address,
        sheet: sheet.name,
        tokens: toks,
      });
    }
  }
  return out;
}

function score(phraseTokens: string[], label: string[]): number {
  if (phraseTokens.length === 0 || label.length === 0) return 0;
  const a = [...phraseTokens].sort().join(' ');
  const b = [...label].sort().join(' ');
  if (a === b) return 100;
  const phraseSet = new Set(phraseTokens);
  const labelSet = new Set(label);
  const common = [...phraseSet].filter((t) => labelSet.has(t)).length;
  if (common === phraseSet.size) return 80 - (labelSet.size - phraseSet.size) * 5; // label contains every word of the phrase
  if (common === labelSet.size) return 60 - (phraseSet.size - labelSet.size) * 5; // phrase contains every word of the label
  return 0;
}

/**
 * Finds the cell a phrase like “fuel surcharge” refers to by comparing it with the text labels
 * next to values. It never guesses between equally good matches: those are reported as ambiguous.
 */
export function resolveLabel(phrase: string, workbook: WorkbookModel, activeSheet: string): LabelResolution {
  const wanted = tokens(phrase);
  if (wanted.length === 0) return { kind: 'unresolved' };

  const scored = collectCandidates(workbook)
    .map((c) => ({ c, s: score(wanted, c.tokens) + (c.sheet === activeSheet ? 1 : 0) }))
    .filter(({ s }) => s >= 55)
    .sort((x, y) => y.s - x.s);
  if (scored.length === 0) return { kind: 'unresolved' };

  // Several labels can point at the same value cell; those count as one candidate.
  const unique = new Map<string, (typeof scored)[number]>();
  for (const item of scored) {
    const key = `${item.c.ref.sheet}!${item.c.ref.address}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const ranked = [...unique.values()];
  const best = ranked[0];
  if (!best) return { kind: 'unresolved' };
  const tied = ranked.filter((r) => r.s === best.s);
  const via = (r: (typeof ranked)[number]): string =>
    `label “${r.c.labelText}” in ${r.c.sheet}!${r.c.labelAddress}`;
  if (tied.length > 1) {
    return { kind: 'ambiguous', candidates: tied.slice(0, 5).map((r) => ({ ref: r.c.ref, via: via(r) })) };
  }
  return { kind: 'resolved', ref: best.c.ref, via: via(best) };
}

/** Sheet-qualified when needed: `B5` on the rule's own sheet, `'Rates'!B5` elsewhere. */
export function refForExpression(ref: CellRefModel, defaultSheet: string): string {
  if (ref.sheet === defaultSheet) return ref.address;
  return /^[A-Za-z0-9_.]+$/.test(ref.sheet) ? `${ref.sheet}!${ref.address}` : `'${ref.sheet.replace(/'/g, "''")}'!${ref.address}`;
}

export { parseAddress };
