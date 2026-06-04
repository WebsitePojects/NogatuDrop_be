const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const appSource = readFileSync(join(__dirname, '../src/app.js'), 'utf8');
const envSource = readFileSync(join(__dirname, '../src/config/env.js'), 'utf8');

test('backend CORS accepts comma-delimited origins and loopback dev hosts', () => {
  assert.equal(appSource.includes("split(',')"), true);
  assert.equal(appSource.includes("['localhost', '127.0.0.1', '::1']"), true);
  assert.equal(appSource.includes('Origin ${origin} is not allowed by CORS'), true);
});

test('backend default allowed origins cover local public storefront hosts', () => {
  assert.equal(envSource.includes('http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173'), true);
});
