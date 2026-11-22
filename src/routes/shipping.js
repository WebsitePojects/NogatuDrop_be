const { Router } = require('express');
const { body } = require('express-validator');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const validate = require('../middleware/validate');
const { BARANGAY_CODE_PATTERN } = require('../services/publicCustomerInput');
const { PUBLIC_ORDER_MAX_ITEMS } = require('../services/publicOrderLimits');
const { getShippingQuote, getShippingSettings, updateShippingSettings } = require('../controllers/shippingController');

const router = Router();
const PSGC_CODE = /^\d{9}$/;
const ZONE_CODE = /^[A-Z_]{2,20}$/;

// Public: checkout asks for the fee and delivery window once the buyer picks a barangay.
router.post(
  '/quote',
  [
    body('barangay_code').isString().matches(BARANGAY_CODE_PATTERN).withMessage('Please choose your barangay from the list.'),
    body('items').isArray({ min: 1, max: PUBLIC_ORDER_MAX_ITEMS }).withMessage(`Add 1 to ${PUBLIC_ORDER_MAX_ITEMS} items`),
    body('items.*.product_id').isInt({ min: 1 }).withMessage('Each item needs a product').toInt(),
    body('items.*.quantity').isInt({ min: 1, max: PUBLIC_ORDER_MAX_ITEMS })
      .withMessage(`Quantity must be a whole number from 1 to ${PUBLIC_ORDER_MAX_ITEMS}`).toInt(),
    body('centers_only').optional().isBoolean().withMessage('centers_only must be true or false').toBoolean(),
  ],
  validate,
  getShippingQuote
);

router.use(auth, roleGuard('super_admin'));

router.get('/settings', getShippingSettings);
router.put(
  '/settings',
  [
    body('zones').optional().isArray({ max: 20 }),
    body('zones.*.code').matches(ZONE_CODE).withMessage('Unknown shipping zone'),
    body('zones.*.eta_min_days').isInt({ min: 0, max: 60 }).withMessage('Delivery days must be 0 to 60').toInt(),
    body('zones.*.eta_max_days').isInt({ min: 0, max: 60 }).withMessage('Delivery days must be 0 to 60').toInt(),
    body('zones.*.rates').isArray({ min: 1, max: 10 }).withMessage('Each zone needs 1 to 10 weight brackets'),
    body('zones.*.rates.*.max_weight_grams').isInt({ min: 1, max: 100000 })
      .withMessage('A weight bracket must be 1 to 100,000 grams').toInt(),
    body('zones.*.rates.*.fee').isFloat({ min: 0, max: 100000 }).withMessage('A fee must be 0 to 100,000').toFloat(),
    body('regions').optional().isArray({ max: 30 }),
    body('regions.*.code').matches(PSGC_CODE).withMessage('Each region needs its 9-digit PSGC code'),
    body('regions.*.zone_code').isIn(['LUZON', 'VISAYAS', 'MINDANAO']).withMessage('A region belongs to Luzon, Visayas or Mindanao'),
    body('provinces').optional().isArray({ max: 120 }),
    body('provinces.*.code').matches(PSGC_CODE).withMessage('Each province needs its 9-digit PSGC code'),
    body('provinces.*.zone_code').optional({ values: 'null' }).matches(ZONE_CODE).withMessage('Unknown shipping zone'),
    body('products').optional().isArray({ max: 500 }),
    body('products.*.id').isInt({ min: 1 }).toInt(),
    body('products.*.weight_grams').isInt({ min: 1, max: 50000 })
      .withMessage('A product weight must be 1 to 50,000 grams').toInt(),
  ],
  validate,
  updateShippingSettings
);

module.exports = router;
