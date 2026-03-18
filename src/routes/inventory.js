const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { getInventory, getInventoryItem, addInventory, updateInventory } = require('../controllers/inventoryController');

const router = Router();

router.use(auth);

router.get('/', getInventory);
router.get('/:id', param('id').isInt(), validate, getInventoryItem);

router.post(
  '/',
  roleGuard('super_admin'),
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
  roleGuard('super_admin'),
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
