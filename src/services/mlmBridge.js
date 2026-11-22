const env = require('./../config/env');

const MLM_TIMEOUT_MS = 5000;

/** True when this server is set up to ask nogatualliance.com about members (MLM_API_URL + MLM_API_KEY). */
function isMlmBridgeConfigured() {
  return Boolean(env.MLM_API_URL && env.MLM_API_KEY);
}

/**
 * Asks nogatualliance.com whether this username + password belong to a member (server to server:
 * POST /api/external/member/verify with the shared x-api-key). The password is forwarded once and never
 * stored or logged here.
 *
 * Returns { status: 'verified', member: { uid, username, account_status } }, { status: 'invalid' } for a wrong
 * username or password, or { status: 'unavailable' } when the MLM cannot answer (not configured, down,
 * timed out, or an answer we do not recognise; never treated as a pass).
 */
async function verifyMlmMemberCredentials(username, password) {
  if (!isMlmBridgeConfigured()) return { status: 'unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MLM_TIMEOUT_MS);
  try {
    const base = String(env.MLM_API_URL).replace(/\/+$/, '');
    const res = await fetch(`${base}/api/external/member/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.MLM_API_KEY },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    });
    if (res.status === 401) return { status: 'invalid' };
    if (!res.ok) {
      console.warn(`[mlm-bridge] member verify answered HTTP ${res.status}`);
      return { status: 'unavailable' };
    }
    const body = await res.json();
    const member = body && body.data;
    if (!member || member.verified !== true || !member.uid || !member.username) {
      console.warn('[mlm-bridge] member verify answered 200 without a verified member');
      return { status: 'unavailable' };
    }
    return {
      status: 'verified',
      member: { uid: String(member.uid), username: String(member.username), account_status: String(member.account_status || '') },
    };
  } catch (err) {
    console.warn(`[mlm-bridge] member verify failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isMlmBridgeConfigured, verifyMlmMemberCredentials };
