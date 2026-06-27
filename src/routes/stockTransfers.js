const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { getTransfers, getTransfer, createTransfer, transitTransfer, cancelTransfer, completeTransfer } = require('../controllers/stockTransferController');

const router = Router();

router.use(auth);

router.get('/', roleGuard.requirePermission(PERMISSIONS.STOCK_TRANSFERS_VIEW), getTransfers);
router.get(
  '/:id',
  roleGuard.requirePermission(PERMISSIONS.STOCK_TRANSFERS_VIEW),
  param('id').isInt(),
  validate,
  getTransfer
);

router.post(
  '/',
  roleGuard.requirePermission(PERMISSIONS.STOCK_TRANSFERS_CREATE),
  [
    body('from_warehouse_id').isInt().withMessage('Source warehouse ID is required'),
    body('to_warehouse_id').isInt().withMessage('Destination warehouse ID is required'),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.product_id').isInt().withMessage('Product ID is required for each item'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('notes').optional().trim(),
  ],
  validate,
  createTransfer
);

router.patch(
  '/:id/transit',
  roleGuard.requirePermission(PERMISSIONS.STOCK_TRANSFERS_COMPLETE),
  param('id').isInt(),
  validate,
  transitTransfer
);

router.patch(
  '/:id/cancel',
  roleGuard.requirePermission(PERMISSIONS.STOCK_TRANSFERS_CREATE),
  param('id').isInt(),
  validate,
  cancelTransfer
);

router.patch(
  '/:id/complete',
  roleGuard.requirePermission(PERMISSIONS.STOCK_TRANSFERS_COMPLETE),
  param('id').isInt(),
  validate,
  completeTransfer
);

module.exports = router;
