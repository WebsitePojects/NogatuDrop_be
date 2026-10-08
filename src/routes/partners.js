const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const { getPartners, getPartner, createPartner, updatePartner, updateDiscount } = require('../controllers/partnerController');
const { addressPartsValidators } = require('../services/addressInput');
const { getTerritories, setTerritories } = require('../controllers/territoryController');

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
    ...addressPartsValidators({ required: true }),
  ],
  validate,
  createPartner
);

router.put('/:id', param('id').isInt(), addressPartsValidators({ required: false }), validate, updatePartner);
router.patch('/:id/discount', [body('discount_pct').isFloat({ min: 0, max: 100 })], validate, updateDiscount);
// Store-order territory: the provinces and cities this Stockist fulfils (Super Admin only, as above).
router.get('/:id/territories', param('id').isInt({ min: 1 }), validate, getTerritories);
router.put(
  '/:id/territories',
  [
    param('id').isInt({ min: 1 }),
    body('areas').isArray({ max: 200 }).withMessage('areas must be a list of up to 200 provinces or cities'),
    body('areas.*.area_type').isIn(['province', 'city']).withMessage('Each area is a province or a city'),
    body('areas.*.area_code').matches(/^\d{9}$/).withMessage('Each area needs its 9-digit PSGC code'),
  ],
  validate,
  setTerritories
);

module.exports = router;
