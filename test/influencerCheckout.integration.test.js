const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.CODEX_DS_DB_TESTS === '1';
const host = process.env.CODEX_DS_DB_HOST || '127.0.0.1';
const port = Number(process.env.CODEX_DS_DB_PORT || 33317);
const database = process.env.CODEX_DS_DB_NAME || 'codex_store_test';

test('codex influencer checkout schema supports concurrent idempotency claims and rollback attribution', { skip: !enabled }, async () => {
  assert.equal(host, '127.0.0.1');
  assert.equal(port, 33317);
  assert.match(database, /^codex_store_test(?:$|_)/);
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({ host, port, user: 'root', password: '', database, connectionLimit: 4 });
  try {
    const [tables] = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('influencer_links','order_attribution','public_order_idempotency','order_notification_outbox')`, [database]);
    assert.equal(tables.length, 4);
    const key = `integration-${Date.now()}`;
    await Promise.all([
      pool.execute(`INSERT INTO public_order_idempotency (scope, idempotency_key, request_hash, status) VALUES ('integration', ?, 'hash', 'processing') ON DUPLICATE KEY UPDATE idempotency_key = idempotency_key`, [key]),
      pool.execute(`INSERT INTO public_order_idempotency (scope, idempotency_key, request_hash, status) VALUES ('integration', ?, 'hash', 'processing') ON DUPLICATE KEY UPDATE idempotency_key = idempotency_key`, [key]),
    ]);
    const [rows] = await pool.query('SELECT COUNT(*) AS count FROM public_order_idempotency WHERE scope = \'integration\' AND idempotency_key = ?', [key]);
    assert.equal(Number(rows[0].count), 1);
  } finally {
    await pool.end();
  }
});
