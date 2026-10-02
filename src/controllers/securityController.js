const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const { revokeSession, SESSION_REVOKE_REASONS } = require('../services/sessionService');

// Sign-in Activity for Super Admin: recent sign-in attempts (flagged ones first to notice) and the
// devices currently signed in, with the ability to end a session.

const LOGIN_EVENT_OUTCOMES = new Set(['success', 'bad_password', 'code_required', 'code_passed', 'code_failed', 'code_unsent']);

// GET /api/v1/security/login-events?flagged=1&outcome=&user_id=&page=&limit=
const getLoginEvents = asyncHandler(async (req, res) => {
  const { flagged, outcome, user_id: userId, page, limit } = req.query;
  const params = [];
  let where = 'WHERE 1 = 1';

  if (flagged === '1' || flagged === 'true') where += ' AND e.flags IS NOT NULL';
  if (outcome) {
    if (!LOGIN_EVENT_OUTCOMES.has(outcome)) throw ApiError.badRequest(`Unknown outcome "${outcome}"`);
    where += ' AND e.outcome = ?';
    params.push(outcome);
  }
  if (userId) {
    if (!/^\d+$/.test(String(userId))) throw ApiError.badRequest('user_id must be a number');
    where += ' AND e.user_id = ?';
    params.push(userId);
  }

  const result = await paginate(
    `SELECT e.id, e.user_id, u.name AS user_name, u.email AS user_email, r.slug AS role_slug,
            e.outcome, e.flags, e.ip, e.country, e.manila_hour, e.user_agent, e.session_id,
            e.alert_status, e.created_at
     FROM login_events e
     JOIN users u ON u.id = e.user_id
     JOIN roles r ON r.id = u.role_id
     ${where}
     ORDER BY e.id DESC`,
    `SELECT COUNT(*) AS total FROM login_events e ${where}`,
    params,
    page,
    limit
  );
  res.json({ success: true, ...result });
});

// GET /api/v1/security/sessions?page=&limit=   (live sessions only)
const getActiveSessions = asyncHandler(async (req, res) => {
  const live = 's.revoked_at IS NULL AND s.expires_at > NOW() AND s.idle_expires_at > NOW()';
  const result = await paginate(
    `SELECT s.id, s.user_id, u.name AS user_name, u.email AS user_email, r.slug AS role_slug,
            s.ip, s.country, s.user_agent, s.created_at, s.last_seen_at, s.idle_expires_at, s.expires_at
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     JOIN roles r ON r.id = u.role_id
     WHERE ${live}
     ORDER BY s.last_seen_at DESC`,
    `SELECT COUNT(*) AS total FROM user_sessions s WHERE ${live}`,
    [],
    req.query.page,
    req.query.limit
  );
  res.json({ success: true, ...result });
});

// PATCH /api/v1/security/sessions/:id/revoke
// Duplicate-safe: the conditional UPDATE ends the session once; repeats get 409.
const revokeUserSession = asyncHandler(async (req, res) => {
  const ended = await revokeSession(pool, { sessionId: req.params.id, reason: SESSION_REVOKE_REASONS.ADMIN });
  if (!ended) throw ApiError.conflict('This session has already ended');
  res.json({ success: true, message: 'Session ended. That device must sign in again.' });
});

module.exports = { getLoginEvents, getActiveSessions, revokeUserSession };
