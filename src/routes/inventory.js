const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { getInventory, getInventoryItem, addInventory, updateInventory } = require('../controllers/inventoryController');

const router = Router();
const { requirePermission } = roleGuard;

router.use(auth);

router.get('/', requirePermission(PERMISSIONS.INVENTORY_VIEW), getInventory);
router.get('/:id', requirePermission(PERMISSIONS.INVENTORY_VIEW), param('id').isInt(), validate, getInventoryItem);

router.post(
  '/',
  requirePermission(PERMISSIONS.INVENTORY_MANAGE),
  [
    body('product_id').isInt().withMessage('Product ID is required'),
    body('warehouse_id').isInt().withMessage('Warehouse ID is required'),
    body('batch_number').trim().notEmpty().withMessage('Batch number is required'),
    body('expiry_date').isISO8601().withMessage('Valid expiry date is required'),
    body('current_stock').optional().isInt({ min: 0 }),
    body('reorder_threshold').optional().isInt({ min: 0 }),
    body('partner_id').optional().isInt(),
  ],
  validate,
  addInventory
);

router.put(
  '/:id',
  requirePermission(PERMISSIONS.INVENTORY_MANAGE),
  param('id').isInt(),
  [
    body('current_stock').optional().isInt({ min: 0 }),
    body('reorder_threshold').optional().isInt({ min: 0 }),
    body('batch_number').optional().trim().notEmpty(),
    body('expiry_date').optional().isISO8601(),
  ],
  validate,
  updateInventory
);

module.exports = router;
