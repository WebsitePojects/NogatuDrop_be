const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outboxPath = require.resolve('../src/services/orderNotificationOutbox');

// Swap the outbox processor for a stub before the cron module captures it.
function loadCronWith(processStub) {
  const cronPath = require.resolve('../src/services/orderNotificationOutboxCron');
  delete require.cache[cronPath];
  require.cache[outboxPath] = {
    id: outboxPath, filename: outboxPath, loaded: true,
    exports: { processOrderNotificationOutbox: processStub, enqueueOrderNotifications: async () => {} },
  };
  try {
    return require(cronPath);
  } finally {
    delete require.cache[outboxPath];
  }
}

test('server starts the order notification outbox cron with the other jobs', () => {
  const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  assert.match(server, /startOrderNotificationOutboxCron\(\);/);
});

test('outbox cron drains every minute by default and uses the shared leader lock', () => {
  const env = fs.readFileSync(path.join(root, 'src/config/env.js'), 'utf8');
  assert.match(env, /ORDER_NOTIFICATION_OUTBOX_CRON: process\.env\.ORDER_NOTIFICATION_OUTBOX_CRON \|\| '\* \* \* \* \*'/);
  const cronSource = fs.readFileSync(path.join(root, 'src/services/orderNotificationOutboxCron.js'), 'utf8');
  assert.match(cronSource, /runWithCronLeaderLock\(\{\s*lockKey: 'order-notification-outbox'/);
});

test('runOrderNotificationOutbox passes bounded batch and retry limits', async () => {
  const calls = [];
  const { runOrderNotificationOutbox } = loadCronWith(async (opts) => { calls.push(opts); return 0; });
  await runOrderNotificationOutbox();
  assert.deepEqual(calls, [{ batchSize: 25, maxAttempts: 5 }]);
});

test('runOrderNotificationOutbox logs a processor failure instead of crashing the scheduler', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const { runOrderNotificationOutbox } = loadCronWith(async () => { throw new Error("Table 'order_notification_outbox' doesn't exist"); });
  await assert.doesNotReject(runOrderNotificationOutbox());
  assert.equal(errors.length, 1);
  assert.match(errors[0], /OrderNotificationOutboxCron.*order_notification_outbox/);
});

test('outbox npm scripts load an env file so a manual run never hits default credentials', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['notifications:outbox'], /--env-file=\.env\.dev /);
  assert.match(pkg.scripts['notifications:outbox:prod'], /--env-file=\.env\.prod /);
});
