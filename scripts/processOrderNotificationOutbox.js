const { runWithCronLeaderLock } = require('../src/services/cronLeaderLock');
const { processOrderNotificationOutbox } = require('../src/services/orderNotificationOutbox');

runWithCronLeaderLock({
  lockKey: 'order-notification-outbox',
  task: async () => {
    const count = await processOrderNotificationOutbox({ batchSize: 25, maxAttempts: 5 });
    console.log(`order notification outbox processed: ${count}`);
  },
}).catch((error) => {
  console.error('order notification outbox failed:', error.message);
  process.exitCode = 1;
});
