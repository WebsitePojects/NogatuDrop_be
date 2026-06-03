const test = require('node:test');
const assert = require('node:assert/strict');

const { attachRequestContext, __testables } = require('../src/middleware/requestContext');

test('normalizeRequestId accepts stable request ids from upstream callers', () => {
  assert.equal(__testables.normalizeRequestId('trace-abc12345'), 'trace-abc12345');
});

test('normalizeRequestId rejects unsafe or malformed ids', () => {
  assert.equal(__testables.normalizeRequestId('bad id with spaces'), null);
  assert.equal(__testables.normalizeRequestId('short'), null);
  assert.equal(__testables.normalizeRequestId(''), null);
});

test('attachRequestContext preserves a valid inbound request id and sets the response header', () => {
  const headers = {};
  const req = {
    get(name) {
      return name.toLowerCase() === 'x-request-id' ? 'trace-abc12345' : null;
    },
  };
  const res = {
    locals: {},
    setHeader(name, value) {
      headers[name] = value;
    },
  };

  let called = false;
  attachRequestContext(req, res, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.equal(req.requestId, 'trace-abc12345');
  assert.equal(res.locals.requestId, 'trace-abc12345');
  assert.equal(headers['X-Request-Id'], 'trace-abc12345');
});
