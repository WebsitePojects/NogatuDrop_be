const { Router } = require('express');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const { login, logout, refresh, me, forgotPassword, resetPassword } = require('../controllers/authController');

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

router.post('/logout', auth, logout);
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
