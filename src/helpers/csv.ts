// a csv file for the accountant (rfc 4180): a header line and a line for each row, fields
// separated by commas, quoted where they need it, every line ended with crlf. The byte order mark
// lets a spreadsheet read the text as utf-8. Money goes to the cent with a point

export type CsvColumn<T> = {
  header: string;
  // text is quoted when it needs it and kept as text; number as it is; money to the cent
  kind: 'text' | 'number' | 'money';
  value: (row: T) => string | number | null | undefined;
};

// a text that starts like a formula would run in the spreadsheet: it gets an apostrophe in front
const FORMULA_START = /^[=+\-@\t\r]/;

function textField(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function field<T>(column: CsvColumn<T>, row: T): string {
  const value = column.value(row);
  if (value === null || value === undefined) return '';

  if (column.kind === 'text') return textField(String(value));
  if (column.kind === 'money') return Number(value).toFixed(2);
  return String(value);
}

export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const lines = [
    columns.map((column) => textField(column.header)).join(','),
    ...rows.map((row) => columns.map((column) => field(column, row)).join(',')),
  ];

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
