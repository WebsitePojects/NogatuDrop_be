const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { getPartners, getPartner, createPartner, updatePartner } = require('../controllers/partnerController');

const router = Router();

router.use(auth);
router.use(roleGuard('super_admin'));

router.get('/', getPartners);
router.get('/:id', param('id').isInt(), validate, getPartner);

router.post(
  '/',
  [
    body('business_name').trim().notEmpty().withMessage('Business name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('phone').trim().notEmpty().withMessage('Phone is required'),
    body('address').trim().notEmpty().withMessage('Address is required'),
    body('partner_type').optional().isIn(['distributor', 'reseller', 'retailer']),
    body('credit_limit').optional().isFloat({ min: 0 }),
    body('region').optional().trim(),
    body('admin_name').optional().trim(),
    body('admin_email').optional().isEmail(),
    body('admin_password').optional().isLength({ min: 6 }),
  ],
  validate,
  createPartner
);

router.put(
  '/:id',
  param('id').isInt(),
  [
    body('business_name').optional().trim().notEmpty(),
    body('email').optional().isEmail(),
    body('phone').optional().trim().notEmpty(),
    body('status').optional().isIn(['active', 'inactive', 'suspended']),
    body('partner_type').optional().isIn(['distributor', 'reseller', 'retailer']),
    body('credit_limit').optional().isFloat({ min: 0 }),
  ],
  validate,
  updatePartner
);

module.exports = router;
