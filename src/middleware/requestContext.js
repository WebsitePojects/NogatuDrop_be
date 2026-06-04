const crypto = require('crypto');

function normalizeRequestId(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;

  return trimmed;
}

function attachRequestContext(req, res, next) {
  const requestId = normalizeRequestId(req.get('x-request-id')) || crypto.randomUUID();

  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  next();
}

module.exports = {
  attachRequestContext,
  __testables: {
    normalizeRequestId,
  },
};
