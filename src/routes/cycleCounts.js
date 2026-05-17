const { Router } = require('express');
const { body, param } = require('express-validator');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../rbac/permissions');
const controller = require('../controllers/cycleCountController');

const router = Router();
const { requirePermission } = roleGuard;

router.use(auth);

router.get('/', requirePermission(PERMISSIONS.CYCLE_COUNTS_VIEW), controller.getCycleCounts);
router.get('/:id', requirePermission(PERMISSIONS.CYCLE_COUNTS_VIEW), param('id').isInt(), validate, controller.getCycleCount);
router.post(
  '/',
  requirePermission(PERMISSIONS.CYCLE_COUNTS_CREATE),
  [
    body('warehouse_id').isInt().withMessage('warehouse_id is required'),
    body('items').optional().isArray(),
  ],
  validate,
  controller.createCycleCount
);
router.patch(
  '/:id/items',
  requirePermission(PERMISSIONS.CYCLE_COUNTS_CREATE),
  [
    param('id').isInt(),
    body('items').isArray({ min: 1 }).withMessage('items are required'),
    body('items.*.id').optional().isInt(),
    body('items.*.item_id').optional().isInt(),
    body('items.*.counted_qty').isInt({ min: 0 }).withMessage('counted_qty must be zero or greater'),
  ],
  validate,
  controller.updateCycleCountItems
);
router.patch('/:id/submit', requirePermission(PERMISSIONS.CYCLE_COUNTS_CREATE), param('id').isInt(), validate, controller.submitCycleCount);
router.patch('/:id/approve', requirePermission(PERMISSIONS.CYCLE_COUNTS_APPROVE), param('id').isInt(), validate, controller.approveCycleCount);
router.patch('/:id/reject', requirePermission(PERMISSIONS.CYCLE_COUNTS_APPROVE), param('id').isInt(), validate, controller.rejectCycleCount);

module.exports = router;
