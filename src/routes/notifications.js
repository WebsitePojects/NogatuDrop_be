const { Router } = require('express');
const { param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const { getNotifications, getUnreadCount, markRead, markAllRead } = require('../controllers/notificationController');

const router = Router();

router.use(auth);

router.get('/', getNotifications);
router.get('/count', getUnreadCount);
router.get('/unread-count', getUnreadCount);
router.patch('/read-all', markAllRead);
router.patch('/:id/read', param('id').isInt(), validate, markRead);

module.exports = router;
