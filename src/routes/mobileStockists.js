const { Router } = require('express');
const { body } = require('express-validator');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const c = require('../controllers/mobileStockistController');
const validate = require('../middleware/validate');
const { addressPartsValidators, coordinatePairValidator } = require('../services/addressInput');

const r = Router();
r.use(auth);
r.get('/', roleGuard.requirePermission(PERMISSIONS.MOBILE_STOCKISTS_VIEW), c.getMobileStockists);
r.post(
  '/',
  roleGuard.requirePermission(PERMISSIONS.MOBILE_STOCKISTS_MANAGE),
  [...addressPartsValidators({ required: true }), coordinatePairValidator('lat', 'lng')],
  validate,
  c.createMobileStockist
);
r.put(
  '/:id',
  roleGuard.requirePermission(PERMISSIONS.MOBILE_STOCKISTS_MANAGE),
  [
    body('status').optional().isIn(['active', 'inactive', 'suspended']).withMessage('Status must be active, inactive or suspended'),
    ...addressPartsValidators({ required: false }),
    coordinatePairValidator('lat', 'lng'),
  ],
  validate,
  c.updateMobileStockist
);
module.exports = r;
