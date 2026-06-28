const { Router } = require('express');
const { body, param } = require('express-validator');
const auth = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const {
  getMobileInventory,
  getMobileInventoryMovements,
  adjustMobileInventory,
} = require('../controllers/mobileInventoryController');

const router = Router();
const { requirePermission } = roleGuard;
router.use(auth);
router.get('/', requirePermission(PERMISSIONS.MOBILE_INVENTORY_VIEW), getMobileInventory);
router.get('/movements', requirePermission(PERMISSIONS.MOBILE_INVENTORY_VIEW), getMobileInventoryMovements);
router.post(
  '/:productId/adjust',
  requirePermission(PERMISSIONS.MOBILE_INVENTORY_ADJUST),
  param('productId').isInt({ min: 1 }),
  body('direction').isIn(['increase', 'decrease']),
  body('quantity').isInt({ min: 1 }),
  body('reason').optional().trim().isLength({ max: 255 }),
  validate,
  adjustMobileInventory
);

module.exports = router;
