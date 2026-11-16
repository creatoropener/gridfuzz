import { describe, expect, it } from 'vitest';
import { CalcEngine, isCalcError } from '../src/engine/calculation/CalcEngine';
import { analyzeWorkbook, extractFunctionNames, isFunctionSupported } from '../src/engine/calculation/formulaAnalysis';
import { buildPrecedentGraph, dependencyPath } from '../src/engine/calculation/graph';
import { MAX_UPLOAD_BYTES, ImportError, detectKind, importWorkbook, validateUpload } from '../src/engine/workbook/importer';
import { buildXlsx } from '../src/engine/workbook/sheetjsAdapter';
import { applyEdits, editsFingerprint, parseCellInput, upsertEdit } from '../src/engine/workbook/edits';
import { colToLetters, expandRange, lettersToCol, normalizeAddress, parseAddress, parseRange, toAddress } from '../src/engine/workbook/a1';
import { inferLabel } from '../src/engine/workbook/labels';
import { countFormulas } from '../src/engine/workbook/model';
import { buildFreightWorkbook } from '../src/engine/samples/freightQuote';
import { makeWorkbook } from './helpers';

const bytes = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
const csv = (text: string): ArrayBuffer => bytes(new TextEncoder().encode(text));

describe('A1 helpers', () => {
  it('converts columns both ways', () => {
    for (const col of [0, 1, 25, 26, 27, 51, 52, 701, 702, 703, 16383]) {
      expect(lettersToCol(colToLetters(col))).toBe(col);
    }
    expect(colToLetters(0)).toBe('A');
    expect(colToLetters(26)).toBe('AA');
    expect(toAddress(1, 13)).toBe('B14');
  });

  it('parses and normalises addresses and ranges, rejecting junk', () => {
    expect(parseAddress('$b$14')).toEqual({ col: 1, row: 13 });
    expect(normalizeAddress(' c3 ')).toBe('C3');
    for (const bad of ['', 'B', '14', 'B0', 'B-1', 'AAAA1', 'B1:B2', 'B 1', 'Sheet!B1']) expect(parseAddress(bad), bad).toBeNull();
    expect(parseRange('B3:A1')).toEqual({ from: { col: 0, row: 0 }, to: { col: 1, row: 2 } });
    expect(parseRange('B3')).toBeNull();
    expect(expandRange(parseRange('A1:B2')!)).toEqual(['A1', 'B1', 'A2', 'B2']);
    expect(expandRange(parseRange('A1:Z999')!, 5)).toHaveLength(5);
  });
});

describe('cell input and edits', () => {
  it('interprets what a user types', () => {
    expect(parseCellInput('=SUM(A1:A3)')).toEqual({ formula: '=SUM(A1:A3)', value: null });
    expect(parseCellInput('  1,250.5 ')).toEqual({ formula: null, value: 1250.5 });
    expect(parseCellInput('-3')).toEqual({ formula: null, value: -3 });
    expect(parseCellInput('15%')).toEqual({ formula: null, value: 0.15 });
    expect(parseCellInput('TRUE')).toEqual({ formula: null, value: true });
    expect(parseCellInput('hello')).toEqual({ formula: null, value: 'hello' });
    expect(parseCellInput('')).toEqual({ formula: null, value: null });
    expect(parseCellInput('=')).toEqual({ formula: null, value: '=' });
    expect(parseCellInput('1.2.3')).toEqual({ formula: null, value: '1.2.3' });
  });

  it('applies edits to a copy and never to the original', () => {
    const original = buildFreightWorkbook();
    const snapshot = JSON.stringify(original);
    const edited = applyEdits(original, [
      { sheet: 'Quote', address: 'B11', content: '=MAX(B10-B17,0)*B18' },
      { sheet: 'Quote', address: 'B6', content: '250' },
      { sheet: 'Quote', address: 'D30', content: 'note' },
    ]);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(edited).not.toBe(original);
    const cells = edited.sheets[0]!.cells;
    expect(cells.B11).toMatchObject({ formula: '=MAX(B10-B17,0)*B18', value: null });
    expect(cells.B6).toMatchObject({ formula: null, value: 250 });
    expect(edited.sheets[0]!.rowCount).toBe(30); // grows to hold the new cell
    expect(applyEdits(original, [])).toBe(original);
  });

  it('removes a cell when it is cleared, and ignores edits for unknown sheets or addresses', () => {
    const original = buildFreightWorkbook();
    const edited = applyEdits(original, [
      { sheet: 'Quote', address: 'B9', content: '' },
      { sheet: 'Nope', address: 'A1', content: '1' },
      { sheet: 'Quote', address: 'not-a-cell', content: '1' },
    ]);
    expect(edited.sheets[0]!.cells.B9).toBeUndefined();
    expect(edited.sheets.length).toBe(1);
  });

  it('drops an edit that restores the original, so "edited" always means "different from the file"', () => {
    const wb = buildFreightWorkbook();
    let edits = upsertEdit(wb, [], 'Quote', 'B11', '=MAX(B10-B17,0)*B18');
    expect(edits).toHaveLength(1);
    edits = upsertEdit(wb, edits, 'Quote', 'B11', '=IF(B10>B17,B10*B18,0)'); // the original formula again
    expect(edits).toEqual([]);
    edits = upsertEdit(wb, [], 'Quote', 'B6', '180'); // same value as the file
    expect(edits).toEqual([]);
  });

  it('fingerprints edit sets independent of order', () => {
    const a = { sheet: 'Quote', address: 'B6', content: '1' };
    const b = { sheet: 'Quote', address: 'B5', content: '2' };
    expect(editsFingerprint([a, b])).toBe(editsFingerprint([b, a]));
    expect(editsFingerprint([a])).not.toBe(editsFingerprint([b]));
    expect(editsFingerprint([])).toBe(editsFingerprint([]));
  });

  it('infers labels from neighbouring text', () => {
    const wb = buildFreightWorkbook();
    expect(inferLabel(wb, { sheet: 'Quote', address: 'B6' })).toBe('Fuel surcharge');
    expect(inferLabel(wb, { sheet: 'Quote', address: 'B14' })).toBe('Final freight cost');
    expect(inferLabel(wb, { sheet: 'Quote', address: 'Z99' })).toBeNull();
  });
});

describe('upload validation', () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  it('accepts supported files and rejects the rest before parsing', () => {
    expect(validateUpload('Quote.XLSX', 1000, zip)).toBe('xlsx');
    expect(validateUpload('data.csv', 10, new TextEncoder().encode('a,b'))).toBe('csv');
    expect(detectKind('x.xls')).toBeNull();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as ImportError).code;
      }
      return 'no error';
    };
    expect(code(() => validateUpload('notes.txt', 10, zip))).toBe('unsupported_type');
    expect(code(() => validateUpload('old.xls', 10, zip))).toBe('unsupported_type');
    expect(code(() => validateUpload('book.xlsx', 0, zip))).toBe('empty');
    expect(code(() => validateUpload('book.xlsx', MAX_UPLOAD_BYTES + 1, zip))).toBe('too_large');
    expect(code(() => validateUpload('fake.xlsx', 100, new TextEncoder().encode('this is not a zip')))).toBe('corrupt');
    expect(code(() => validateUpload('bin.csv', 100, new Uint8Array([97, 44, 0, 1, 2])))).toBe('corrupt');
  });
});

describe('importing real files', () => {
  it('round-trips an .xlsx: formulas are kept, literals stay literal', async () => {
    const original = buildFreightWorkbook();
    const file = await buildXlsx(original.sheets);
    const imported = await importWorkbook('freight.xlsx', bytes(file));
    const cells = imported.sheets[0]!.cells;
    expect(imported.sheets[0]!.name).toBe('Quote');
    expect(cells.B10).toMatchObject({ formula: '=SUM(B5:B9)', value: null });
    expect(cells.B11?.formula).toBe('=IF(B10>B17,B10*B18,0)');
    expect(cells.B5).toMatchObject({ formula: null, value: 2400 });
    expect(cells.A6?.value).toBe('Fuel surcharge');
    expect(countFormulas(imported)).toBe(countFormulas(original));
    expect(imported.source).toBe('upload');
    expect(imported.sizeBytes).toBe(file.byteLength);
  });

  it('never trusts values cached in the file: a stale cached number is recorded but never used', async () => {
    const wb = makeWorkbook([['A1', 5], ['A2', '=A1*2']]);
    const stale = await buildXlsx(wb.sheets, (_sheet, address) => (address === 'A2' ? 999 : undefined));
    const imported = await importWorkbook('stale.xlsx', bytes(stale));
    expect(imported.sheets[0]!.cells.A2?.cachedValue).toBe(999);
    expect(imported.sheets[0]!.cells.A2?.value).toBeNull();
    const engine = CalcEngine.fromWorkbook(imported);
    expect(engine.getValue('S', 'A2')).toBe(10); // 5 × 2, calculated, not 999
    engine.destroy();
  });

  it('imports CSV (with BOM, quotes and formulas) and tells the user formulas were detected', async () => {
    const text = '﻿Item,Amount\n"Widget, large",10\nGadget,20\nTotal,=SUM(B2:B3)\n';
    const imported = await importWorkbook('items.csv', csv(text));
    const cells = imported.sheets[0]!.cells;
    expect(cells.A1?.value).toBe('Item');
    expect(cells.A2?.value).toBe('Widget, large');
    expect(cells.B2?.value).toBe(10);
    expect(cells.B4).toMatchObject({ formula: '=SUM(B2:B3)' });
    expect(imported.warnings.some((w) => w.code === 'csv_formulas')).toBe(true);
    const engine = CalcEngine.fromWorkbook(imported);
    expect(engine.getValue(imported.sheets[0]!.name, 'B4')).toBe(30);
    engine.destroy();
  });

  it('rejects empty, corrupt and oversized workbooks with a clear error', async () => {
    await expect(importWorkbook('blank.csv', csv(''))).rejects.toMatchObject({ code: 'empty' });
    await expect(importWorkbook('x.txt', csv('a'))).rejects.toMatchObject({ code: 'unsupported_type' });
    const garbage = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(importWorkbook('broken.xlsx', bytes(garbage))).rejects.toBeInstanceOf(ImportError);

    const rows = Array.from({ length: 500 }, () => Array.from({ length: 401 }, () => '1').join(','));
    await expect(importWorkbook('huge.csv', csv(rows.join('\n')))).rejects.toMatchObject({ code: 'too_many_cells' });
  });
});

describe('calculation engine (HyperFormula)', () => {
  const wb = makeWorkbook([
    ['A1', 10], ['A2', 4], ['A3', 0], ['A4', 'text'],
    ['B1', '=A1+A2*2'],
    ['B2', '=SUM(A1:A3)'],
    ['B3', '=IF(A1>5,"big","small")'],
    ['B4', '=ROUND(A1/3,2)'],
    ['B5', '=MAX(A1:A3)-MIN(A1:A3)'],
    ['B6', '=AVERAGE(A1:A3)'],
    ['B7', '=A1/A3'],
    ['B8', '=NOPE(A1)'],
    ['B9', '=B10'],
    ['B10', '=B9'],
    ['B11', '=A1&"-"&A2'],
    ['B12', '=VLOOKUP(4,A1:B3,2,FALSE)'],
    ['B13', '=IFERROR(A1/A3,-1)'],
    ['B14', '=A1*10%'],
  ]);

  it('calculates supported formulas correctly', () => {
    const e = CalcEngine.fromWorkbook(wb);
    expect(e.getValue('S', 'B1')).toBe(18);
    expect(e.getValue('S', 'B2')).toBe(14);
    expect(e.getValue('S', 'B3')).toBe('big');
    expect(e.getValue('S', 'B4')).toBe(3.33);
    expect(e.getValue('S', 'B5')).toBe(10);
    expect(e.getValue('S', 'B6')).toBeCloseTo(14 / 3, 10);
    expect(e.getValue('S', 'B11')).toBe('10-4');
    expect(e.getValue('S', 'B13')).toBe(-1);
    expect(e.getValue('S', 'B14')).toBe(1);
    e.destroy();
  });

  it('surfaces errors as data instead of numbers', () => {
    const e = CalcEngine.fromWorkbook(wb);
    const div = e.getValue('S', 'B7');
    const name = e.getValue('S', 'B8');
    const cycle = e.getValue('S', 'B9');
    expect(isCalcError(div) && div.type).toBe('DIV_BY_ZERO');
    expect(isCalcError(name) && name.type).toBe('NAME');
    expect(isCalcError(cycle) && cycle.type).toBe('CYCLE');
    expect(isCalcError(div) && div.display).toBe('#DIV/0!');
    e.destroy();
  });

  it('keeps every instance isolated from the others and from the workbook model', () => {
    const snapshot = JSON.stringify(wb);
    const a = CalcEngine.fromWorkbook(wb);
    const b = CalcEngine.fromWorkbook(wb);
    a.setContent('S', 'A1', 1000);
    expect(a.getValue('S', 'B1')).toBe(1008);
    expect(b.getValue('S', 'B1')).toBe(18);
    b.setMany([{ sheet: 'S', address: 'A1', content: 7 }, { sheet: 'S', address: 'A2', content: 1 }]);
    expect(b.getValue('S', 'B1')).toBe(9);
    expect(a.getValue('S', 'B1')).toBe(1008);
    expect(JSON.stringify(wb)).toBe(snapshot);
    a.destroy();
    b.destroy();
  });

  it('rejects unknown sheets and invalid addresses with clear errors', () => {
    const e = CalcEngine.fromWorkbook(wb);
    expect(() => e.getValue('Nope', 'A1')).toThrow(/Unknown sheet/);
    expect(() => e.getValue('S', 'ZZZZ1')).toThrow(/Invalid cell address/);
    e.destroy();
  });

  it('reports dependency information: precedents, dependents, closure and path', () => {
    const f = buildFreightWorkbook();
    const e = CalcEngine.fromWorkbook(f);
    const prec = e.getPrecedents('Quote', 'B10').map((r) => r.address);
    expect(prec).toEqual(['B5', 'B6', 'B7', 'B8', 'B9']); // SUM range expanded
    expect(e.getDependents('Quote', 'B6').map((r) => r.address)).toContain('B10');

    const closure = buildPrecedentGraph(e, { sheet: 'Quote', address: 'B14' });
    expect([...closure.nodes.keys()]).toEqual(expect.arrayContaining(['Quote!B6', 'Quote!B10', 'Quote!B11', 'Quote!B17', 'Quote!B19']));

    const path = dependencyPath(e, { sheet: 'Quote', address: 'B6' }, { sheet: 'Quote', address: 'B14' });
    expect(path.cells.map((c) => c.address)).toEqual(['B10', 'B11', 'B12', 'B13', 'B14']);
    expect(path.inPathPrecedents.get('Quote!B12')?.map((c) => c.address)).toEqual(['B10', 'B11']);
    e.destroy();
  });
});

describe('formula analysis: honest warnings', () => {
  it('lists functions and recognises what the engine supports', () => {
    expect(extractFunctionNames('=IF(A1>"SUM(",ROUND(B1,2),sum(C1:C3))').sort()).toEqual(['IF', 'ROUND', 'SUM']);
    expect(extractFunctionNames("='Fn Sheet'!A1+1")).toEqual([]);
    expect(isFunctionSupported('sum')).toBe(true);
    expect(isFunctionSupported('FOOBAR')).toBe(false);
  });

  it('reports unsupported functions, volatile functions and baseline errors, each once and clearly', () => {
    const wb = makeWorkbook([
      ['A1', 1],
      ['B1', '=FOOBAR(A1)'],
      ['B2', '=RAND()+A1'],
      ['B3', '=A1/0'],
      ['B4', '=A1+1'],
    ]);
    const engine = CalcEngine.fromWorkbook(wb);
    const diagnostics = analyzeWorkbook(wb, engine);
    engine.destroy();
    const by = (code: string) => diagnostics.filter((d) => d.code === code);
    expect(by('unsupported_function')).toHaveLength(1);
    expect(by('unsupported_function')[0]!.message).toMatch(/FOOBAR\(\) is not supported.*S!B1.*never as passed/);
    expect(by('volatile_function')[0]!.message).toMatch(/RAND\(\) is volatile/);
    // B3 is a genuine calculation error and is reported; B1 is already explained as unsupported.
    expect(by('calc_error').map((d) => d.address)).toEqual(['B3']);
    expect(diagnostics.every((d) => d.level === 'warning' || d.level === 'error')).toBe(true);
  });

  it('is quiet for a healthy workbook', () => {
    const wb = buildFreightWorkbook();
    const engine = CalcEngine.fromWorkbook(wb);
    expect(analyzeWorkbook(wb, engine)).toEqual([]);
    engine.destroy();
  });
});
