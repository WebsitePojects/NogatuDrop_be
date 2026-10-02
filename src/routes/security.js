const { Router } = require('express');
const { param } = require('express-validator');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const validate = require('../middleware/validate');
const { getLoginEvents, getActiveSessions, revokeUserSession } = require('../controllers/securityController');

const router = Router();

// Sign-in history and live sessions of every account: Super Admin only.
router.use(auth, roleGuard('super_admin'));

router.get('/login-events', getLoginEvents);
router.get('/sessions', getActiveSessions);
router.patch('/sessions/:id/revoke', param('id').isUUID(), validate, revokeUserSession);

module.exports = router;
