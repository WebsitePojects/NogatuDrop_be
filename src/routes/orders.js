const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { paymentProofUpload } = require('../middleware/upload');
const {
  getOrders, getOrder, createOrder, createPublicOrder,
  uploadPublicPaymentProof,
  approveOrder, rejectOrder, cancelOrder,
  uploadPaymentProof, verifyPayment,
  archiveOrder, unarchiveOrder,
} = require('../controllers/orderController');

const router = Router();
const { requirePermission } = role;

// Public — no auth
router.post('/public', createPublicOrder);
router.post('/public/payment-proof', paymentProofUpload.single('proof'), uploadPublicPaymentProof);

// Authenticated
router.use(auth);

router.get('/', requirePermission(PERMISSIONS.ORDERS_VIEW), getOrders);
router.get('/:id', requirePermission(PERMISSIONS.ORDERS_VIEW), param('id').isInt(), validate, getOrder);

router.post(
  '/',
  requirePermission(PERMISSIONS.ORDERS_CREATE),
  [
    body('notes').optional().trim(),
    body('payment_method').optional().isIn(['bank_transfer']),
  ],
  validate,
  createOrder
);

router.patch('/:id/approve', requirePermission(PERMISSIONS.ORDERS_APPROVE), approveOrder);
router.patch('/:id/reject', requirePermission(PERMISSIONS.ORDERS_REJECT), [body('reason').optional().trim()], validate, rejectOrder);
router.patch('/:id/cancel', requirePermission(PERMISSIONS.ORDERS_CANCEL), cancelOrder);

// Stockist uploads payment proof (Cloudinary)
router.post('/:id/payment-proof', requirePermission(PERMISSIONS.ORDERS_UPLOAD_PAYMENT_PROOF), paymentProofUpload.single('proof'), uploadPaymentProof);

// Super admin verifies payment proof
router.patch('/:id/verify-payment', requirePermission(PERMISSIONS.ORDERS_VERIFY_PAYMENT), verifyPayment);

// Order Archive — 'delete' archives the order (record + revenue kept forever); unarchive restores it.
router.patch('/:id/archive', requirePermission(PERMISSIONS.ORDERS_CANCEL), param('id').isInt(), validate, archiveOrder);
router.patch('/:id/unarchive', requirePermission(PERMISSIONS.ORDERS_CANCEL), param('id').isInt(), validate, unarchiveOrder);

module.exports = router;
