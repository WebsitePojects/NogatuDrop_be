const { Router } = require('express');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { MEMBER_DISCOUNT_PCT, isMemberDiscountEnabled, verifyMemberForDiscount } = require('../services/memberDiscount');

// Public, no store login: a Nogatu Alliance member signs in with their nogatualliance.com credentials to get
// the member price at checkout. Rate limited per IP and per username in app.js (memberVerifyLimiter).
const router = Router();

router.get('/discount', (req, res) => {
  res.json({ success: true, data: { enabled: isMemberDiscountEnabled(), discount_pct: MEMBER_DISCOUNT_PCT } });
});

router.post(
  '/verify',
  [
    body('username').isString().bail().trim().isLength({ min: 1, max: 100 })
      .withMessage('Enter your Nogatu Alliance username'),
    // Not trimmed: a password is checked exactly as typed.
    body('password').isString().bail().isLength({ min: 1, max: 200 })
      .withMessage('Enter your Nogatu Alliance password'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const pass = await verifyMemberForDiscount(req.body.username, req.body.password);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, message: `Member verified: ${pass.discount_pct}% off products`, data: pass });
  })
);

module.exports = router;
