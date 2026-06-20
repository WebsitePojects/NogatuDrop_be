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
} = require('../controllers/orderController');

const router = Router();
const { requirePermission } = role;

// Public — no auth
router.post(
  '/public',
  [
    body('customer_name').trim().notEmpty(),
    body('customer_address').trim().notEmpty(),
    body('payment_method').optional().isIn(['bank_transfer']),
    body('shipping_zone').optional().isIn(['metro_manila', 'luzon', 'visayas_mindanao']),
    body('items').isArray({ min: 1 }),
  ],
  validate,
  createPublicOrder
);
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

module.exports = router;
