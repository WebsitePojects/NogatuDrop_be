const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const cache = require('../services/cacheService');
const paginate = require('../utils/paginate');

// GET /api/v1/notifications
const getNotifications = asyncHandler(async (req, res) => {
  const { page, limit, type } = req.query;
  const params = [req.user.id];
  let where = 'WHERE user_id = ?';

  if (type) { where += ' AND type = ?'; params.push(type); }

  const baseQuery = `
    SELECT id, type, title, message, entity_type, entity_id, location, is_read, sms_sent, created_at
    FROM notifications
    ${where}
    ORDER BY created_at DESC`;

  const countQuery = `SELECT COUNT(*) AS total FROM notifications ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// GET /api/v1/notifications/unread-count
const getUnreadCount = asyncHandler(async (req, res) => {
  const cacheKey = `notif:unread:${req.user.id}`;

  const count = await cache.getOrSet(cacheKey, 30, async () => {
    const [rows] = await pool.execute(
      'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    return rows[0].total;
  });

  res.json({ success: true, data: { unread_count: count } });
});

// PATCH /api/v1/notifications/:id/read
const markRead = asyncHandler(async (req, res) => {
  const [existing] = await pool.execute(
    'SELECT id FROM notifications WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  if (existing.length === 0) throw ApiError.notFound('Notification not found');

  await pool.execute('UPDATE notifications SET is_read = 1 WHERE id = ?', [req.params.id]);

  await cache.del(`notif:unread:${req.user.id}`);
  res.json({ success: true, message: 'Notification marked as read' });
});

// PATCH /api/v1/notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  await pool.execute(
    'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
    [req.user.id]
  );

  await cache.del(`notif:unread:${req.user.id}`);
  res.json({ success: true, message: 'All notifications marked as read' });
});

module.exports = { getNotifications, getUnreadCount, markRead, markAllRead };
