import { describe, expect, it } from '@jest/globals';

import { toCsv, type CsvColumn } from '@helpers/csv.js';

// a file for the accountant: one header line and a line for each row, comma-separated with
// double quotes where a field needs them (rfc 4180), money to the cent. A text that a spreadsheet
// would take for a formula is kept as text

type Row = { name: string | null; units: number; value: number | null };

const columns: CsvColumn<Row>[] = [
  { header: 'name', kind: 'text', value: (row) => row.name },
  { header: 'units', kind: 'number', value: (row) => row.units },
  { header: 'value', kind: 'money', value: (row) => row.value },
];

const lines = (csv: string) => csv.replace(/^\uFEFF/, '').split('\r\n');

describe('toCsv', () => {
  // the mark lets a spreadsheet read the names in utf-8
  it('starts with the byte order mark and ends every line with crlf', () => {
    const csv = toCsv(columns, [{ name: 'Mug', units: 2, value: 3.5 }]);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines(csv)).toEqual(['name,units,value', 'Mug,2,3.50', '']);
  });

  it('writes money to the cent, a negative amount too, and an empty value as nothing', () => {
    const csv = toCsv(columns, [
      { name: 'Mug', units: -1, value: -5 },
      { name: null, units: 0, value: null },
      { name: 'Cup', units: 3, value: 0.1 + 0.2 },
    ]);

    expect(lines(csv).slice(1, 4)).toEqual(['Mug,-1,-5.00', ',0,', 'Cup,3,0.30']);
  });

  it('quotes a text with a comma, a quote or a line break, the quotes doubled', () => {
    const csv = toCsv(columns, [
      { name: 'Mug, white', units: 1, value: 1 },
      { name: 'The "big" mug', units: 1, value: 1 },
      { name: 'Two\nlines', units: 1, value: 1 },
    ]);

    expect(lines(csv).slice(1, 3)).toEqual(['"Mug, white",1,1.00', '"The ""big"" mug",1,1.00']);
    expect(csv).toContain('"Two\nlines",1,1.00');
  });

  // a name that starts like a formula would run in the spreadsheet of the accountant
  it.each(['=SUM(A1:A9)', '+1', '-1', '@cmd', '\tTab'])('keeps %p as text', (name) => {
    const csv = toCsv(columns, [{ name, units: 1, value: 1 }]);

    expect(lines(csv)[1]).toBe(`'${name},1,1.00`);
  });

  it('writes only the header for no rows', () => {
    expect(lines(toCsv(columns, []))).toEqual(['name,units,value', '']);
  });
});
