const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/services/readinessService');

test('readiness is not ready when a critical dependency fails', () => {
  const summary = __testables.summarizeReadiness({
    database: { status: 'fail' },
    redis: { status: 'ok' },
    file_storage: { status: 'ok' },
  });

  assert.equal(summary.status, 'not_ready');
  assert.equal(summary.httpStatus, 503);
  assert.deepEqual(summary.critical_failures, ['database']);
});

test('readiness is degraded when only warning dependencies remain', () => {
  const summary = __testables.summarizeReadiness({
    database: { status: 'ok' },
    redis: { status: 'warn' },
    file_storage: { status: 'ok' },
  });

  assert.equal(summary.status, 'degraded');
  assert.equal(summary.httpStatus, 200);
  assert.equal(summary.warnings, 1);
});

test('readiness is fully ready when all dependencies pass', () => {
  const summary = __testables.summarizeReadiness({
    database: { status: 'ok' },
    redis: { status: 'ok' },
    file_storage: { status: 'ok' },
  });

  assert.equal(summary.status, 'ready');
  assert.equal(summary.httpStatus, 200);
  assert.deepEqual(summary.critical_failures, []);
});
