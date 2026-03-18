const { Router } = require('express');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const { login, logout, refresh, me } = require('../controllers/authController');

const router = Router();

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  login
);

router.post('/logout', auth, logout);
router.post('/refresh', refresh);
router.get('/me', auth, me);

module.exports = router;
