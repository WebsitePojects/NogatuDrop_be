const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

const MAX_KEY_LENGTH = 128;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

function requestHash(body, scope) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ scope, body: canonicalize(body) }), 'utf8')
    .digest('hex');
}

function getIdempotencyKey(req) {
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw ApiError.badRequest('A valid Idempotency-Key header is required');
  }
  return key;
}

async function claimPublicOrderIntent(conn, { scope, key, body }) {
  const hash = requestHash(body, scope);
  await conn.execute(
    `INSERT INTO public_order_idempotency (scope, idempotency_key, request_hash, status)
     VALUES (?, ?, ?, 'processing')
     ON DUPLICATE KEY UPDATE idempotency_key = idempotency_key`,
    [scope, key, hash]
  );
  const [rows] = await conn.execute(
    `SELECT id, request_hash, status, response_json
     FROM public_order_idempotency
     WHERE scope = ? AND idempotency_key = ?
     FOR UPDATE`,
    [scope, key]
  );
  const row = rows[0];
  if (!row) throw ApiError.internal('Unable to claim public order intent');
  if (row.request_hash !== hash) throw ApiError.conflict('Idempotency-Key was already used with a different request');
  if (row.status === 'completed') {
    let response = row.response_json;
    if (typeof response === 'string') { try { response = JSON.parse(response); } catch { throw ApiError.internal('Stored idempotency response is invalid'); } }
    return { id: row.id, replay: response };
  }
  if (row.status !== 'processing') throw ApiError.conflict('Idempotency-Key is not available for replay');
  return { id: row.id, replay: null };
}

async function completePublicOrderIntent(conn, intentId, orderId, response) {
  const [result] = await conn.execute(
    `UPDATE public_order_idempotency
     SET status = 'completed', order_id = ?, response_json = ?, completed_at = NOW()
     WHERE id = ? AND status = 'processing'`,
    [orderId, JSON.stringify(response), intentId]
  );
  if (result.affectedRows !== 1) throw ApiError.conflict('Unable to complete idempotent order intent');
}

module.exports = { getIdempotencyKey, claimPublicOrderIntent, completePublicOrderIntent, requestHash };
