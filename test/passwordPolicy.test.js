// New passwords need 8+ characters with a letter, a number and a symbol (Sir Dino, 2026-11-10).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { passwordProblem, generateTemporaryPassword } = require('../src/utils/passwordPolicy');

test('passwordProblem names the missing part', () => {
  assert.equal(passwordProblem('Abc!1234'), null);
  assert.match(passwordProblem('Ab!1'), /at least 8/);
  assert.match(passwordProblem('12345678!'), /letter/);
  assert.match(passwordProblem('abcdefgh!'), /number/);
  assert.match(passwordProblem('abcd1234'), /symbol/);
  assert.match(passwordProblem(''), /required/);
  assert.match(passwordProblem(undefined), /required/);
  assert.match(passwordProblem(`A1!${'x'.repeat(80)}`), /at most 72/);
});

test('generated temporary passwords always satisfy the rule and differ', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const pw = generateTemporaryPassword();
    assert.equal(passwordProblem(pw), null, pw);
    seen.add(pw);
  }
  assert.equal(seen.size, 200);
});

test('every place that sets a new password uses the shared rule (no private length checks)', () => {
  const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');
  for (const file of ['src/controllers/userController.js', 'src/controllers/partnerController.js',
    'src/controllers/mobileStockistController.js', 'src/controllers/authController.js']) {
    assert.match(read(file), /assertNewPasswordAllowed\(/, file);
    assert.doesNotMatch(read(file), /\.length < 8/, file);
  }
  for (const file of ['src/routes/users.js', 'src/routes/partners.js', 'src/routes/auth.js']) {
    assert.match(read(file), /newPasswordValidator/, file);
  }
  assert.doesNotMatch(read('src/controllers/applicationController.js'), /Math\.random\(\)/);
});
