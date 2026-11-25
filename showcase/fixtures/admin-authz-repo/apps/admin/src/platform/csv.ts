// CSV export helpers (FE §8.4 cap:import-export, export.csv-injection). Reference implementation for the
// @acme/csv-safe-export rule: every CSV body goes through toCsv, every cell through toCsvCell.
//   - text cells starting with =, +, -, @, tab or CR are neutralized with a leading apostrophe (formula injection);
//   - numbers and booleans are written raw, so numeric cells stay numbers;
//   - quoting follows RFC 4180 (a cell with a comma, quote, CR or LF is quoted, quotes are doubled).

export type CsvValue = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function toCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 body: a header row with the column names, then one row per record, CRLF line breaks. */
export function toCsv<T extends Record<string, CsvValue>>(rows: readonly T[], columns: readonly (keyof T & string)[]): string {
  const lines = [columns.map(toCsvCell).join(','), ...rows.map((row) => columns.map((c) => toCsvCell(row[c])).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}
