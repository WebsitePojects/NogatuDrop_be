const { Router } = require('express');
const { body, param } = require('express-validator');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../rbac/permissions');
const controller = require('../controllers/settlementController');

const router = Router();
const { requirePermission } = roleGuard;

router.use(auth);

router.get('/', requirePermission(PERMISSIONS.SETTLEMENTS_VIEW), controller.getSettlements);
router.post(
  '/',
  requirePermission(PERMISSIONS.SETTLEMENTS_MANAGE),
  [
    body('order_id').isInt().withMessage('order_id is required'),
    body('amount').isFloat({ min: 0 }).withMessage('amount is required'),
    body('method').optional().isIn(['bank_transfer', 'courier_remittance', 'manual']),
  ],
  validate,
  controller.createSettlement
);
router.patch(
  '/:id/reconcile',
  requirePermission(PERMISSIONS.SETTLEMENTS_MANAGE),
  [
    param('id').isInt(),
    body('status').isIn(['reconciled', 'disputed', 'cancelled']),
    body('variance_amount').optional().isFloat(),
  ],
  validate,
  controller.reconcileSettlement
);

module.exports = router;
