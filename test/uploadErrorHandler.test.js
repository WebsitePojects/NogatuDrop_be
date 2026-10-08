const test = require('node:test');
const assert = require('node:assert/strict');
const multer = require('multer');
const { uploadErrorHandler } = require('../src/middleware/upload');

// The upload endpoints are public (buyer receipt, rider photo): a malformed or hostile upload is the
// sender's mistake and must get a 400, never a 500 (multer 2 upgrade, 2026-10-08).
const statusOf = (err) => new Promise((resolve) => uploadErrorHandler(err, {}, {}, (out) => resolve(out?.statusCode ?? 'passed-through')));

test('malformed or refused uploads answer 400', async () => {
  assert.equal(await statusOf(new multer.MulterError('LIMIT_FILE_SIZE')), 400);
  assert.equal(await statusOf(new multer.MulterError('LIMIT_PART_COUNT')), 400);
  assert.equal(await statusOf(new Error('Unexpected end of form')), 400);
  assert.equal(await statusOf(new Error('Malformed part header')), 400);
  assert.equal(await statusOf(Object.assign(new Error('An unknown file format not allowed'), { http_code: 400 })), 400);
  assert.equal(await statusOf(Object.assign(new Error('nope'), { code: 'INVALID_FILE_TYPE' })), 400);
});

test('unrelated errors pass through untouched (fail closed, not swallowed)', async () => {
  const err = new Error('database is down');
  const passed = await new Promise((resolve) => uploadErrorHandler(err, {}, {}, resolve));
  assert.equal(passed, err);
});
