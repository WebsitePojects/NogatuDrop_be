// RFC 4180 CSV with spreadsheet-formula-injection defence. Pure functions only:
// callers decide columns and headers, this module decides how a cell is written.

// Excel reads a BOM-less UTF-8 file as the local ANSI codepage and garbles non-ASCII text.
const CSV_BOM = '﻿';
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

// Leading characters a spreadsheet treats as the start of a formula.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Serialize one value as a CSV cell.
 * null/undefined become an empty cell. Only strings are formula-defended, so a real
 * negative number stays numeric; callers that pass user text must pass it as a string.
 */
function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {string[]} headers column titles
 * @param {Array<Array<*>>} rows each row an array aligned with `headers`
 * @returns {string} BOM-prefixed, CRLF-terminated CSV document
 */
function toCsv(headers, rows) {
  const lines = [headers, ...rows].map((cells) => cells.map(escapeCsvCell).join(','));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv, escapeCsvCell, CSV_BOM, CSV_CONTENT_TYPE };
