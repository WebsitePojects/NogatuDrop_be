const test = require('node:test');
const assert = require('node:assert/strict');

const { runWithCronLeaderLock, buildCronLockName } = require('../src/services/cronLeaderLock');

test('buildCronLockName scopes the advisory lock to the database', () => {
  assert.equal(buildCronLockName('payment-deadline', 'nogatu_ncdms'), 'nogatu:cron:nogatu_ncdms:payment-deadline');
});

test('production and staging databases never share a cron lock name', () => {
  assert.notEqual(
    buildCronLockName('payment-deadline', 'nogatu_ncdms'),
    buildCronLockName('payment-deadline', 'nogatu_ncdms_staging')
  );
});

test('every lock key in use fits the 64-character GET_LOCK limit with the staging database name', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const sources = [
    ...fs.readdirSync(path.join(root, 'src/services')).map((f) => path.join(root, 'src/services', f)),
    ...fs.readdirSync(path.join(root, 'scripts')).map((f) => path.join(root, 'scripts', f)),
  ].filter((f) => f.endsWith('.js'));
  const lockKeys = sources.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/lockKey: '([^']+)'/g)].map((m) => m[1]));

  assert.ok(lockKeys.length >= 5, `expected the 5 cron lock keys, found ${lockKeys.length}`);
  for (const key of lockKeys) {
    assert.doesNotThrow(() => buildCronLockName(key, 'nogatu_ncdms_staging'), key);
  }
});

test('buildCronLockName rejects names MySQL would refuse', () => {
  assert.throws(() => buildCronLockName('x'.repeat(60), 'nogatu_ncdms'), /exceeds 64 characters/);
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
