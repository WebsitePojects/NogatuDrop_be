const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { getTransfers, getTransfer, createTransfer, completeTransfer } = require('../controllers/stockTransferController');

const router = Router();

router.use(auth);

const ALL_STOCKIST_ROLES = ['super_admin', 'provincial_stockist', 'city_stockist', 'staff'];

router.get('/', roleGuard(...ALL_STOCKIST_ROLES), getTransfers);
router.get('/:id', roleGuard(...ALL_STOCKIST_ROLES), param('id').isInt(), validate, getTransfer);

router.post(
  '/',
  roleGuard('super_admin', 'provincial_stockist', 'city_stockist'),
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

router.patch('/:id/complete', roleGuard('super_admin'), param('id').isInt(), validate, completeTransfer);

module.exports = router;
