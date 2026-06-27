const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const {
  getPurchaseOrders, getPurchaseOrder, createPurchaseOrder,
  submitPurchaseOrder, approvePurchaseOrder, rejectPurchaseOrder,
} = require('../controllers/purchaseOrderController');
const { PERMISSIONS } = require('../rbac/permissions');

const router = Router();

router.use(auth);

const { requirePermission } = roleGuard;

router.get('/', requirePermission(PERMISSIONS.PURCHASE_ORDERS_VIEW), getPurchaseOrders);
router.get('/:id', requirePermission(PERMISSIONS.PURCHASE_ORDERS_VIEW), param('id').isInt(), validate, getPurchaseOrder);

router.post(
  '/',
  requirePermission(PERMISSIONS.PURCHASE_ORDERS_CREATE),
  [
    body('supplier').optional().trim(),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.product_id').isInt().withMessage('Product ID is required'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('items.*.unit_price').optional().isFloat({ min: 0 }),
    body('notes').optional().trim(),
  ],
  validate,
  createPurchaseOrder
);

router.patch('/:id/submit', roleGuard('provincial_stockist', 'city_stockist'), param('id').isInt(), validate, submitPurchaseOrder);
router.patch('/:id/approve', requirePermission(PERMISSIONS.PURCHASE_ORDERS_APPROVE), param('id').isInt(), validate, approvePurchaseOrder);
router.patch('/:id/reject', roleGuard('super_admin', 'provincial_stockist', 'city_stockist'), param('id').isInt(), validate, rejectPurchaseOrder);

module.exports = router;
