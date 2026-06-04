const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

test('production error handler logs 5xx diagnostics without request body data', () => {
  assert.match(source, /console\.error\('\[HTTP 5xx\]'/);
  assert.match(source, /request_id: req\.requestId \|\| null/);
  assert.match(source, /method: req\.method/);
  assert.match(source, /url: req\.originalUrl/);
  assert.match(source, /stack: err\.stack/);
  assert.doesNotMatch(source, /body: req\.body/);
});
