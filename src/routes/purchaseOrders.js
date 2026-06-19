const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const {
  getPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
} = require('../controllers/purchaseOrderController');

const router = Router();

router.use(auth);

const ALL_STOCKIST_ROLES = ['super_admin', 'provincial_stockist', 'city_stockist', 'staff'];

router.get('/', roleGuard(...ALL_STOCKIST_ROLES), getPurchaseOrders);
router.get('/:id', roleGuard(...ALL_STOCKIST_ROLES), param('id').isInt(), validate, getPurchaseOrder);

router.post(
  '/',
  roleGuard('super_admin', 'provincial_stockist', 'city_stockist'),
  [
    body('supplier').optional().trim(),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.product_id').isInt().withMessage('Product ID is required'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price is required'),
    body('notes').optional().trim(),
  ],
  validate,
  createPurchaseOrder
);

router.patch('/:id/approve', roleGuard('super_admin'), param('id').isInt(), validate, approvePurchaseOrder);
router.patch(
  '/:id/reject',
  roleGuard('super_admin'),
  [param('id').isInt(), body('reason').optional().trim()],
  validate,
  rejectPurchaseOrder
);

module.exports = router;
