const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// proof_of_delivery has `submitted_at`, not `created_at`. The review queries asked for pod.created_at,
// failed with "Unknown column", and their fallback returned NULL signature, recipient, GPS and route,
// so every delivery looked unsigned (reported by management 2026-10-08) although the data was saved.
test('proof-of-delivery review queries read real columns, so the signature is not dropped', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/deliveryTokenController.js'), 'utf8');
  for (const name of ['const getDeliveryProofForOrder', 'const listDeliveryProofs']) {
    const start = source.indexOf(name);
    assert.ok(start >= 0, `${name} exists`);
    const block = source.slice(start, source.indexOf('\n});\n', start));
    assert.ok(!block.includes('pod.created_at'), `${name} must not read pod.created_at (the column is submitted_at)`);
    assert.match(block, /pod\.recipient_signature,/, `${name} returns the signature`);
  }
});
