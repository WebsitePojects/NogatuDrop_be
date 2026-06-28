const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { getWarehouses, getWarehouse, createWarehouse, updateWarehouse, deleteWarehouse } = require('../controllers/warehouseController');

const router = Router();
const { requirePermission } = roleGuard;

router.use(auth);

router.get('/', requirePermission(PERMISSIONS.INVENTORY_VIEW), getWarehouses);
router.get('/:id', requirePermission(PERMISSIONS.INVENTORY_VIEW), param('id').isInt(), validate, getWarehouse);

router.post(
  '/',
  requirePermission(PERMISSIONS.WAREHOUSES_MANAGE),
  [
    body('name').trim().notEmpty().withMessage('Warehouse name is required'),
    body('type').optional().isIn(['manufacturer', 'region', 'city']),
    body('location').trim().notEmpty().withMessage('Location is required'),
    body('manager_name').trim().notEmpty().withMessage('Manager name is required'),
    body('capacity_total').optional().isInt({ min: 1 }),
    body('manager_email').optional().isEmail(),
    body('manager_phone').optional().trim(),
  ],
  validate,
  createWarehouse
);

router.put(
  '/:id',
  requirePermission(PERMISSIONS.WAREHOUSES_MANAGE),
  param('id').isInt(),
  [
    body('name').optional().trim().notEmpty(),
    body('type').optional().isIn(['manufacturer', 'region', 'city']),
    body('location').optional().trim().notEmpty(),
    body('manager_name').optional().trim().notEmpty(),
    body('is_active').optional().isBoolean(),
  ],
  validate,
  updateWarehouse
);

router.delete('/:id', requirePermission(PERMISSIONS.WAREHOUSES_MANAGE), param('id').isInt(), validate, deleteWarehouse);

module.exports = router;
