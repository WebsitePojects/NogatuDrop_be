const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUsername, isValidUsername, usernameFromEmail } = require('../src/utils/username');
const { planUsernameBackfill } = require('../scripts/addUsername');
const { findUserForLogin } = require('../src/controllers/authController');

test('usernames are trimmed and lowercased; blanks mean "no username"', () => {
  assert.equal(normalizeUsername('  RBere '), 'rbere');
  assert.equal(normalizeUsername('   '), null);
  assert.equal(normalizeUsername(undefined), null);
});

test('valid usernames are 3-50 safe characters and never look like an email', () => {
  for (const ok of ['rbere', 'mg.balcos', 'j_lopez-2', '007']) assert.equal(isValidUsername(ok), true, ok);
  for (const bad of ['ab', '.dot', 'a b', 'x@y.com', 'UPPER', 'a'.repeat(51), null]) assert.equal(isValidUsername(bad), false, String(bad));
});

test('a username derived from an email keeps only safe characters of the local part', () => {
  assert.equal(usernameFromEmail('Golden.Stars1316@gmail.com'), 'golden.stars1316');
  assert.equal(usernameFromEmail('dyno+erfe@gmail.com'), 'dynoerfe');
  assert.equal(usernameFromEmail('ab@x.com'), null);
});

test('backfill skips local parts shared by two accounts, so no login becomes ambiguous', () => {
  const plan = planUsernameBackfill([
    { id: 1, email: 'admin@nogatu.store', username: null },
    { id: 2, email: 'admin@nogatu.com', username: null }, // same local part, different domain
    { id: 3, email: 'golden.stars1316@gmail.com', username: null },
    { id: 4, email: 'rb@x.com', username: null }, // too short
    { id: 5, email: 'kept@x.com', username: 'chosen' },
  ]);
  assert.deepEqual(plan.assignments, [{ id: 3, username: 'golden.stars1316' }]);
  assert.equal(plan.ambiguous, 2);
  assert.equal(plan.unusable, 1);
});

test('backfill never takes a username another account already holds', () => {
  const plan = planUsernameBackfill([
    { id: 1, email: 'rbere@gmail.com', username: null },
    { id: 2, email: 'ryan@x.com', username: 'rbere' },
  ]);
  assert.deepEqual(plan.assignments, []);
  assert.equal(plan.ambiguous, 1);
});

function fakeDb(handler) {
  const calls = [];
  return { calls, async execute(sql, params) { calls.push({ sql, params }); return handler(sql, params, calls.length); } };
}

test('login looks up by exact email or exact username, never by the email local part', async () => {
  const db = fakeDb(() => [[{ id: 7 }]]);
  const user = await findUserForLogin('rbere', db);
  assert.equal(user.id, 7);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /LOWER\(u\.email\) = \? OR u\.username = \?/);
  assert.doesNotMatch(db.calls[0].sql, /SUBSTRING_INDEX/);
  assert.deepEqual(db.calls[0].params, ['rbere', 'rbere']);
});

test('before the username migration runs, login falls back to email only', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('u.username')) throw Object.assign(new Error("Unknown column 'u.username'"), { code: 'ER_BAD_FIELD_ERROR' });
    return [[{ id: 9 }]];
  });
  const user = await findUserForLogin('a@b.com', db);
  assert.equal(user.id, 9);
  assert.equal(db.calls.length, 2);
  assert.deepEqual(db.calls[1].params, ['a@b.com']);
});

test('login lookup returns null for no match and rethrows unrelated database errors', async () => {
  assert.equal(await findUserForLogin('nobody', fakeDb(() => [[]])), null);
  const broken = fakeDb(() => { throw Object.assign(new Error('gone away'), { code: 'PROTOCOL_CONNECTION_LOST' }); });
  await assert.rejects(findUserForLogin('x', broken), /gone away/);
});
