const test = require('node:test');
const assert = require('node:assert/strict');
const { processOrderNotificationOutbox } = require('../src/services/orderNotificationOutbox');

test('notification outbox reclaims expired processing leases and finalizes conditionally', async () => {
  const statements = [];
  const conn = {
    async execute(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT n.id')) return [[{ id: 4, order_number: 'PUB-4', user_id: 9, attempts: 1, customer_name: 'Customer' }]];
      if (sql.startsWith("UPDATE order_notification_outbox\n       SET status = 'failed'")) return [{ affectedRows: 0 }];
      if (sql.startsWith('UPDATE order_notification_outbox SET status = \'processing\'')) return [{ affectedRows: 1 }];
      if (sql.startsWith('SELECT email')) return [[{ email: 'recipient@example.test', name: 'Recipient' }]];
      if (sql.startsWith("UPDATE order_notification_outbox SET status = 'sent'")) return [{ affectedRows: 1 }];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  assert.equal(await processOrderNotificationOutbox({ connectionFactory: async () => conn, sendEmailFn: async () => {} }), 1);
  const claim = statements.find((entry) => entry.sql.startsWith("UPDATE order_notification_outbox SET status = 'processing'"));
  const finish = statements.find((entry) => entry.sql.includes("status = 'sent'"));
  assert.match(claim.sql, /locked_at < DATE_SUB/);
  assert.match(claim.sql, /lease_token/);
  assert.match(finish.sql, /lease_token = \?/);
});
