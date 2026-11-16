export interface GridPos {
  col: number;
  row: number;
}

/** A single-cell A1 address in canonical form (upper-case, no `$`). */
export const ADDRESS_PATTERN = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;

export function colToLetters(col: number): string {
  let n = col + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function toAddress(col: number, row: number): string {
  return `${colToLetters(col)}${row + 1}`;
}

/** Parses `B5`, `$B$5` or `b5`. Returns `null` for anything that is not a single-cell address. */
export function parseAddress(input: string): GridPos | null {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(input.trim());
  if (!match) return null;
  return { col: lettersToCol(match[1] ?? ''), row: Number(match[2]) - 1 };
}

/** Returns the canonical form of an address (`$b$5` → `B5`) or `null` when invalid. */
export function normalizeAddress(input: string): string | null {
  const pos = parseAddress(input);
  return pos ? toAddress(pos.col, pos.row) : null;
}

export interface GridRange {
  from: GridPos;
  to: GridPos;
}

/** Parses `B4:B8` (corners may be given in any order). */
export function parseRange(input: string): GridRange | null {
  const parts = input.split(':');
  if (parts.length !== 2) return null;
  const a = parseAddress(parts[0] ?? '');
  const b = parseAddress(parts[1] ?? '');
  if (!a || !b) return null;
  return {
    from: { col: Math.min(a.col, b.col), row: Math.min(a.row, b.row) },
    to: { col: Math.max(a.col, b.col), row: Math.max(a.row, b.row) },
  };
}

/** Expands a range into addresses (row-major), stopping at `cap` cells. */
export function expandRange(range: GridRange, cap = 10_000): string[] {
  const out: string[] = [];
  for (let row = range.from.row; row <= range.to.row; row++) {
    for (let col = range.from.col; col <= range.to.col; col++) {
      if (out.length >= cap) return out;
      out.push(toAddress(col, row));
    }
  }
  return out;
}
