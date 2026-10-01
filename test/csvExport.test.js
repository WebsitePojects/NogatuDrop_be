const test = require('node:test');
const assert = require('node:assert/strict');
const { toCsv, escapeCsvCell, CSV_BOM } = require('../src/utils/csvExport');

test('plain cells are written unquoted; null and undefined become empty cells', () => {
  assert.equal(escapeCsvCell('hello'), 'hello');
  assert.equal(escapeCsvCell(1250.5), '1250.5');
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
});

test('commas, quotes, CR and LF force RFC 4180 quoting with doubled quotes', () => {
  assert.equal(escapeCsvCell('Blk 1, Lot 2'), '"Blk 1, Lot 2"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvCell('line1\r\nline2'), '"line1\r\nline2"');
});

test('cells that start like a spreadsheet formula are neutralised with a leading apostrophe', () => {
  for (const trigger of ['=', '+', '-', '@', '\t', '\r']) {
    const cell = escapeCsvCell(`${trigger}SUM(A1:A9)`);
    assert.ok(cell.replace(/^"/, '').startsWith(`'${trigger}`), `trigger ${JSON.stringify(trigger)} -> ${JSON.stringify(cell)}`);
  }
  assert.equal(escapeCsvCell('=HYPERLINK("http://evil","x")'), '"\'=HYPERLINK(""http://evil"",""x"")"');
});

test('only a leading trigger is defended; an inner = + - @ is left alone', () => {
  assert.equal(escapeCsvCell('a=b'), 'a=b');
  assert.equal(escapeCsvCell('Quezon-City'), 'Quezon-City');
  assert.equal(escapeCsvCell('x@y.com'), 'x@y.com');
});

test('a real negative number is not mistaken for a formula', () => {
  assert.equal(escapeCsvCell(-5), '-5');
});

test('toCsv prefixes the UTF-8 BOM, joins with CRLF and ends with a CRLF', () => {
  const csv = toCsv(['a', 'b'], [['1', 'x,y'], ['2', 'Peñafrancia']]);
  assert.equal(csv, `${CSV_BOM}a,b\r\n1,"x,y"\r\n2,Peñafrancia\r\n`);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
});

test('toCsv with no rows still emits the header row', () => {
  assert.equal(toCsv(['a'], []), `${CSV_BOM}a\r\n`);
});
