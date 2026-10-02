const { Router } = require('express');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const { login, verifyLogin, logout, refresh, me, forgotPassword, resetPassword } = require('../controllers/authController');

const router = Router();

router.post(
  '/login',
  [
    body('email').notEmpty().withMessage('Email or username is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  login
);

// Finishes a flagged sign-in. Shares the login rate limit (app.js mounts it on the /auth/login prefix).
router.post(
  '/login/verify',
  [
    body('challenge_id').isUUID().withMessage('challenge_id is required'),
    body('code').matches(/^\d{6}$/).withMessage('Enter the 6-digit code'),
  ],
  validate,
  verifyLogin
);

// No access token needed: the refresh cookie identifies the session to end, so signing out still
// works after the 15-minute access token has expired.
router.post('/logout', logout);
router.post('/refresh', refresh);
router.get('/me', auth, me);

router.post(
  '/forgot-password',
  [body('email').isEmail().withMessage('Valid email is required')],
  validate,
  forgotPassword
);

router.post(
  '/reset-password',
  [
    body('email').isEmail(),
    body('otp').notEmpty().withMessage('OTP is required'),
    body('new_password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ],
  validate,
  resetPassword
);

module.exports = router;
