const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { getWarehouses, getWarehouse, createWarehouse, updateWarehouse, deleteWarehouse } = require('../controllers/warehouseController');
const { addressPartsValidators, coordinatePairValidator } = require('../services/addressInput');

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
    body('type').optional().isIn(['manufacturer', 'region', 'city']).withMessage('Unknown warehouse type'),
    body('manager_name').trim().notEmpty().withMessage('Manager name is required'),
    body('capacity_total').optional().isInt({ min: 1 }).withMessage('Capacity must be a whole number above 0'),
    body('manager_email').optional().isEmail().withMessage('Manager email must be a valid email address'),
    body('manager_phone').optional().trim(),
    ...addressPartsValidators({ required: true }),
    coordinatePairValidator('lat', 'lng'),
  ],
  validate,
  createWarehouse
);

router.put(
  '/:id',
  requirePermission(PERMISSIONS.WAREHOUSES_MANAGE),
  param('id').isInt(),
  [
    body('name').optional().trim().notEmpty().withMessage('Warehouse name cannot be blank'),
    body('type').optional().isIn(['manufacturer', 'region', 'city']).withMessage('Unknown warehouse type'),
    body('manager_name').optional().trim().notEmpty().withMessage('Manager name cannot be blank'),
    body('is_active').optional().isBoolean().withMessage('is_active must be true or false'),
    ...addressPartsValidators({ required: false }),
    coordinatePairValidator('lat', 'lng'),
  ],
  validate,
  updateWarehouse
);

router.delete('/:id', requirePermission(PERMISSIONS.WAREHOUSES_MANAGE), param('id').isInt(), validate, deleteWarehouse);

module.exports = router;
