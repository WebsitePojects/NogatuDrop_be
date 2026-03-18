const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { getOrders, getOrder, createOrder, approveOrder, rejectOrder, payOrder, deliverOrder } = require('../controllers/orderController');

const router = Router();

router.use(auth);

router.get('/', getOrders);
router.get('/:id', param('id').isInt(), validate, getOrder);

router.post(
  '/',
  roleGuard('admin'),
  [body('notes').optional().trim()],
  validate,
  createOrder
);

router.patch('/:id/approve', roleGuard('super_admin'), param('id').isInt(), validate, approveOrder);

router.patch(
  '/:id/reject',
  roleGuard('super_admin'),
  param('id').isInt(),
  [body('reason').optional().trim()],
  validate,
  rejectOrder
);

router.patch(
  '/:id/pay',
  roleGuard('super_admin'),
  param('id').isInt(),
  [
    body('method').optional().isIn(['bank_transfer', 'gcash', 'cash', 'credit']),
    body('amount').optional().isFloat({ min: 0 }),
    body('reference').optional().trim(),
    body('notes').optional().trim(),
  ],
  validate,
  payOrder
);

router.patch('/:id/deliver', roleGuard('super_admin'), param('id').isInt(), validate, deliverOrder);

module.exports = router;
