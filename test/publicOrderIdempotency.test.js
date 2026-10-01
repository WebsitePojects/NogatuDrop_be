const test = require('node:test');
const assert = require('node:assert/strict');
const { requestHash, getIdempotencyKey, claimPublicOrderIntent, completePublicOrderIntent } = require('../src/services/publicOrderIdempotency');

test('public order request hash is stable across object key order', () => {
  assert.equal(
    requestHash({ b: 2, a: { d: 4, c: 3 } }, 'public-order'),
    requestHash({ a: { c: 3, d: 4 }, b: 2 }, 'public-order')
  );
});

test('idempotency key requires a bounded header value', () => {
  assert.equal(getIdempotencyKey({ get: () => 'checkout-1' }), 'checkout-1');
  assert.throws(() => getIdempotencyKey({ get: () => '' }), /Idempotency-Key/);
  assert.throws(() => getIdempotencyKey({ get: () => 'x'.repeat(201) }), /Idempotency-Key/);
});

function fakeConnection() {
  const rows = new Map();
  return {
    async execute(sql, params) {
      if (sql.startsWith('INSERT INTO')) {
        const key = `${params[0]}:${params[1]}`;
        if (!rows.has(key)) rows.set(key, { id: rows.size + 1, request_hash: params[2], status: 'processing', response_json: null });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT')) {
        const row = rows.get(`${params[0]}:${params[1]}`);
        return [[row]];
      }
      if (sql.startsWith('UPDATE')) {
        const row = [...rows.values()].find((candidate) => candidate.id === params[2]);
        if (row && row.status === 'processing') { row.status = 'completed'; row.response_json = params[1]; return [{ affectedRows: 1 }]; }
        return [{ affectedRows: 0 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('same key replays and altered payload is rejected', async () => {
  const conn = fakeConnection();
  const first = await claimPublicOrderIntent(conn, { scope: 'public-order', key: 'checkout-1', body: { total: 10 } });
  await completePublicOrderIntent(conn, first.id, 7, { success: true, data: { order_number: 'PUB-7' } });
  const replay = await claimPublicOrderIntent(conn, { scope: 'public-order', key: 'checkout-1', body: { total: 10 } });
  assert.deepEqual(replay.replay.data.order_number, 'PUB-7');
  await assert.rejects(() => claimPublicOrderIntent(conn, { scope: 'public-order', key: 'checkout-1', body: { total: 11 } }), /different request/);
});
