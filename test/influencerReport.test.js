const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseReportMonth,
  buildSummary,
  getInfluencerReportData,
  reportRowsToCsv,
} = require('../src/services/influencerReportService');

test('parseReportMonth accepts YYYY-MM and returns a half-open window', () => {
  assert.deepEqual(parseReportMonth('2026-09'), {
    month: '2026-09', start: '2026-09-01 00:00:00', end: '2026-10-01 00:00:00',
  });
});

test('parseReportMonth rolls December into January of the next year', () => {
  assert.equal(parseReportMonth('2026-12').end, '2027-01-01 00:00:00');
});

test('parseReportMonth rejects malformed, out-of-range and non-string input', () => {
  const bad = ['2026-13', '2026-00', '2026-9', '26-09', '2026/09', '2026-09-01', 'abc', ' 2026-09', '1999-12', '2101-01', ['2026-09'], { a: 1 }, 5];
  for (const value of bad) {
    assert.throws(() => parseReportMonth(value), (err) => err.statusCode === 400, `should reject ${JSON.stringify(value)}`);
  }
});

test('parseReportMonth defaults to the current month when absent or empty', () => {
  const now = new Date('2026-10-15T04:00:00Z');
  assert.equal(parseReportMonth(undefined, now).month, '2026-10');
  assert.equal(parseReportMonth('', now).month, '2026-10');
});

test('default month follows Asia/Manila, not UTC, at the month boundary', () => {
  // 2026-09-30 16:30Z is 2026-10-01 00:30 in Manila: already October there.
  assert.equal(parseReportMonth(undefined, new Date('2026-09-30T16:30:00Z')).month, '2026-10');
  // One minute-ish earlier it is still 23:59 on Sep 30 in Manila.
  assert.equal(parseReportMonth(undefined, new Date('2026-09-30T15:59:00Z')).month, '2026-09');
  // New Year: Dec 31 16:30Z is Jan 1 00:30 Manila.
  assert.equal(parseReportMonth(undefined, new Date('2026-12-31T16:30:00Z')).month, '2027-01');
});

test('buildSummary counts non-excluded orders and sums money in exact cents', () => {
  const summary = buildSummary([
    { provider_label: 'GCASH', center_label: 'CALOOCAN', counted_orders: '2', excluded_orders: '0', gross: '0.10' },
    { provider_label: 'GCASH', center_label: 'TYCOON', counted_orders: '1', excluded_orders: '1', gross: '0.20' },
    { provider_label: 'BDO', center_label: 'CALOOCAN', counted_orders: '1', excluded_orders: '0', gross: '1000.00' },
    { provider_label: 'PSBANK', center_label: 'TYCOON', counted_orders: '0', excluded_orders: '2', gross: '0' },
  ]);
  assert.equal(summary.order_count, 4);
  assert.equal(summary.excluded_order_count, 3);
  assert.equal(summary.gross_sales, 1000.3); // float 0.1 + 0.2 would give 0.30000000000000004
  assert.deepEqual(summary.by_provider, [
    { provider: 'BDO', orders: 1, gross: 1000 },
    { provider: 'GCASH', orders: 3, gross: 0.3 },
  ]);
  assert.deepEqual(summary.by_center, [
    { center: 'CALOOCAN', orders: 3, gross: 1000.1 },
    { center: 'TYCOON', orders: 1, gross: 0.2 },
  ]);
});

test('buildSummary of nothing is all zeros', () => {
  assert.deepEqual(buildSummary([]), {
    order_count: 0, excluded_order_count: 0, gross_sales: 0, by_provider: [], by_center: [],
  });
});

function fakeDb({ groups = [], rows = [] } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return [/GROUP BY/.test(sql) ? groups : rows];
    },
  };
}

const WINDOW = parseReportMonth('2026-09');

test('report runs exactly two set-based queries, binds window and slug, never interpolates input', async () => {
  const db = fakeDb();
  await getInfluencerReportData(db, { window: WINDOW, slug: 'kawoodee', rowLimit: 1000 });
  assert.equal(db.calls.length, 2);
  for (const call of db.calls) {
    assert.deepEqual(call.params.slice(0, 3), ['2026-09-01 00:00:00', '2026-10-01 00:00:00', 'kawoodee']);
    assert.doesNotMatch(call.sql, /kawoodee|2026-09/);
    assert.match(call.sql, /LEFT JOIN warehouses/);
    assert.match(call.sql, /o\.is_deleted = 0/);
    assert.match(call.sql, /a\.slug = \?/);
  }
  assert.equal(db.calls[1].params[3], '1000');
});

test('report without a slug omits the slug predicate', async () => {
  const db = fakeDb();
  const data = await getInfluencerReportData(db, { window: WINDOW, slug: null, rowLimit: 5 });
  assert.equal(data.slug, null);
  for (const call of db.calls) assert.doesNotMatch(call.sql, /a\.slug = \?/);
});

test('report response has the documented shape and flags truncation', async () => {
  const db = fakeDb({
    groups: [{ provider_label: 'GCASH', center_label: 'CALOOCAN', counted_orders: '2', excluded_orders: '1', gross: '1500.00' }],
    rows: [{
      order_number: 'PUB-1', created_at: '2026-09-02 10:00:00', influencer_slug: 'kawoodee', payment_provider: 'GCASH',
      fulfillment_center: 'CALOOCAN', customer_location: 'Quezon City', total_amount: '750.00',
      status: 'delivered', payment_status: 'paid',
    }],
  });
  const data = await getInfluencerReportData(db, { window: WINDOW, slug: null, rowLimit: 1 });
  assert.equal(data.month, '2026-09');
  assert.equal(data.summary.order_count, 2);
  assert.equal(data.summary.gross_sales, 1500);
  assert.equal(data.rows[0].total_amount, 750);
  assert.equal(data.rows[0].customer_location, 'Quezon City');
  assert.equal(data.truncated, true); // 3 attributed orders exist, 1 row returned
  assert.equal(data.row_limit, 1);
});

test('csv rows carry every column, 2-decimal amounts, and neutralise formula-looking addresses', () => {
  const csv = reportRowsToCsv([{
    order_number: 'PUB-1', created_at: '2026-09-02 10:00:00', influencer_slug: 'kawoodee', payment_provider: null,
    fulfillment_center: null, customer_location: '=cmd|"/C calc"!A0, Manila', total_amount: 750,
    status: 'cancelled', payment_status: 'unpaid',
  }]);
  const [header, line] = csv.replace('﻿', '').split('\r\n');
  assert.equal(header.split(',').length, 9);
  assert.match(line, /^PUB-1,2026-09-02 10:00:00,kawoodee,,,"'=cmd/);
  assert.match(line, /,750\.00,cancelled,unpaid$/);
});
