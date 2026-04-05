const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const { getPartners, getPartner, createPartner, updatePartner, updateDiscount } = require('../controllers/partnerController');

const router = Router();
router.use(auth);
router.use(role('super_admin'));

router.get('/', getPartners);
router.get('/:id', param('id').isInt(), validate, getPartner);

router.post(
  '/',
  [
    body('business_name').trim().notEmpty(),
    body('email').isEmail(),
    body('stockist_level').isIn(['provincial_stockist', 'city_stockist']),
    body('discount_pct').optional().isFloat({ min: 0, max: 100 }),
    body('admin_name').optional().trim(),
    body('admin_email').optional().isEmail(),
    body('admin_password').optional().isLength({ min: 8 }),
  ],
  validate,
  createPartner
);

router.put('/:id', param('id').isInt(), validate, updatePartner);
router.patch('/:id/discount', [body('discount_pct').isFloat({ min: 0, max: 100 })], validate, updateDiscount);

module.exports = router;
