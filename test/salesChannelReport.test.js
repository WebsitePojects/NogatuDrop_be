const test = require('node:test');
const assert = require('node:assert/strict');
const { getSalesChannelReport } = require('../src/services/salesChannelReportService');

const window = { month: '2026-10', start: '2026-10-01 00:00:00', end: '2026-11-01 00:00:00' };

function fakeDb({ groups = [], daily = [], links = [] }) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM influencer_links')) return [links];
      if (sql.includes('DATE_FORMAT')) return [daily];
      return [groups.map((g) => ({ ...g }))];
    },
  };
}

test('store and influencer link are compared side by side with exact shares', async () => {
  const db = fakeDb({
    groups: [
      { slug: null, orders: '3', excluded_orders: '1', paid_orders: '2', gross: '15000.10', paid_gross: '10000.00', units: '4' },
      { slug: 'kawoodee', orders: '2', excluded_orders: '0', paid_orders: '1', gross: '18233.52', paid_gross: '9116.76', units: '2' },
    ],
    links: [{ slug: 'kawoodee' }],
  });
  const report = await getSalesChannelReport(db, { window });
  assert.deepEqual(report.channels.map((c) => c.channel), ['store', 'influencer:kawoodee'], 'store is listed first');
  const [store, kawoodee] = report.channels;
  assert.equal(store.gross_sales, 15000.1);
  assert.equal(kawoodee.average_order_value, 9116.76);
  assert.equal(store.share_pct + kawoodee.share_pct, 100);
  assert.equal(kawoodee.share_pct, 54.9);
  assert.deepEqual(report.totals, { orders: 5, paid_orders: 3, excluded_orders: 1, units: 6, gross_sales: 33233.62, paid_sales: 19116.76 });
});

test('channels without sales this month still appear at zero', async () => {
  const report = await getSalesChannelReport(fakeDb({ links: [{ slug: 'kawoodee' }] }), { window });
  assert.deepEqual(report.channels.map((c) => [c.channel, c.orders, c.share_pct]), [['store', 0, 0], ['influencer:kawoodee', 0, 0]]);
});

test('only public orders in the month window are counted, through bound parameters', async () => {
  const db = fakeDb({});
  await getSalesChannelReport(db, { window });
  const main = db.calls[0];
  assert.match(main.sql, /o\.placed_by_type = 'public'/);
  assert.match(main.sql, /status NOT IN \('cancelled', 'rejected'\)/);
  assert.deepEqual(main.params, [window.start, window.end, window.start, window.end]);
  assert.doesNotMatch(main.sql, /2026-10/, 'dates are never interpolated into SQL');
});
