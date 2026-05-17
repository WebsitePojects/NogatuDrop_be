const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithCronLeaderLock, buildCronLockName } = require('../src/services/cronLeaderLock');

test('buildCronLockName prefixes the cron key for advisory locks', () => {
  assert.equal(buildCronLockName('payment-deadline'), 'nogatu:cron:payment-deadline');
});

test('runWithCronLeaderLock runs the task when the advisory lock is acquired', async () => {
  const calls = [];
  const connection = {
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('GET_LOCK')) {
        return [[{ acquired_lock: 1 }]];
      }

      if (sql.includes('RELEASE_LOCK')) {
        return [[{ released_lock: 1 }]];
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      calls.push({ release: true });
    },
  };

  let taskRuns = 0;
  await runWithCronLeaderLock({
    lockKey: 'expiry-alert',
    connectionFactory: async () => connection,
    task: async () => {
      taskRuns += 1;
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(taskRuns, 1);
  assert.equal(calls.filter((entry) => entry.sql && entry.sql.includes('GET_LOCK')).length, 1);
  assert.equal(calls.filter((entry) => entry.sql && entry.sql.includes('RELEASE_LOCK')).length, 1);
  assert.equal(calls.filter((entry) => entry.release).length, 1);
});

test('runWithCronLeaderLock skips the task when another instance holds the lock', async () => {
  const calls = [];
  const connection = {
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('GET_LOCK')) {
        return [[{ acquired_lock: 0 }]];
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      calls.push({ release: true });
    },
  };

  let taskRuns = 0;
  await runWithCronLeaderLock({
    lockKey: 'token-cleanup',
    connectionFactory: async () => connection,
    task: async () => {
      taskRuns += 1;
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.equal(taskRuns, 0);
  assert.equal(calls.filter((entry) => entry.sql && entry.sql.includes('GET_LOCK')).length, 1);
  assert.equal(calls.filter((entry) => entry.sql && entry.sql.includes('RELEASE_LOCK')).length, 0);
  assert.equal(calls.filter((entry) => entry.release).length, 1);
});

test('runWithCronLeaderLock releases the advisory lock when the task throws', async () => {
  const calls = [];
  const connection = {
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('GET_LOCK')) {
        return [[{ acquired_lock: 1 }]];
      }

      if (sql.includes('RELEASE_LOCK')) {
        return [[{ released_lock: 1 }]];
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      calls.push({ release: true });
    },
  };

  await assert.rejects(
    runWithCronLeaderLock({
      lockKey: 'replenishment',
      connectionFactory: async () => connection,
      task: async () => {
        throw new Error('boom');
      },
      logger: { info() {}, warn() {}, error() {} },
    }),
    /boom/
  );

  assert.equal(calls.filter((entry) => entry.sql && entry.sql.includes('RELEASE_LOCK')).length, 1);
  assert.equal(calls.filter((entry) => entry.release).length, 1);
});
