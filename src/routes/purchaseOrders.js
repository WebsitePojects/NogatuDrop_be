const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { getPurchaseOrders, getPurchaseOrder, createPurchaseOrder, approvePurchaseOrder } = require('../controllers/purchaseOrderController');

const router = Router();

router.use(auth);
router.use(roleGuard('super_admin'));

router.get('/', getPurchaseOrders);
router.get('/:id', param('id').isInt(), validate, getPurchaseOrder);

router.post(
  '/',
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

router.patch('/:id/approve', param('id').isInt(), validate, approvePurchaseOrder);

module.exports = router;
