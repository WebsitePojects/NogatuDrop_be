const env = require('./../config/env');

/**
 * Look up a NogatuMLM member by username via the external bridge endpoint
 * (GET /api/external/member/:username on the MLM backend, x-api-key auth).
 *
 * Returns the member payload ({ username, uid, package_code, package_label,
 * account_status, is_stockist }) or null when the bridge isn't configured, the
 * member isn't found, or the service is unreachable — so checkout NEVER breaks
 * on a member lookup (it just means "no member discount").
 */
async function lookupMlmMember(username) {
  if (!username || !env.MLM_API_URL || !env.MLM_API_KEY) return null;
  try {
    const base = String(env.MLM_API_URL).replace(/\/+$/, '');
    const url = `${base}/api/external/member/${encodeURIComponent(username)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      headers: { 'x-api-key': env.MLM_API_KEY },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.data ? body.data : null;
  } catch {
    return null;
  }
}

module.exports = { lookupMlmMember };
