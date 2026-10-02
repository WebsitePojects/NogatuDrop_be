const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { paymentProofUpload, uploadErrorHandler } = require('../middleware/upload');
const { body: bodyValidator } = require('express-validator');
const { prepareInfluencerOrder, getPublicPaymentOptions, getInfluencerMetadata } = require('../controllers/influencerController');
const {
  getOrders, getOrder, createOrder, createPublicOrder,
  uploadPublicPaymentProof,
  approveOrder, rejectOrder, cancelOrder,
  uploadPaymentProof, verifyPayment,
  archiveOrder, unarchiveOrder,
} = require('../controllers/orderController');

const { PUBLIC_ORDER_MAX_QUANTITY_PER_LINE } = require('../services/publicOrderLimits');

const router = Router();
const { requirePermission } = role;

const publicOrderValidation = [
  bodyValidator('customer_name').isString().trim().isLength({ min: 1, max: 150 }),
  bodyValidator('customer_address').isString().trim().isLength({ min: 1, max: 1000 }),
  bodyValidator('customer_phone').optional().isString().isLength({ max: 30 }),
  bodyValidator('customer_email').optional({ values: 'null' }).isEmail().normalizeEmail(),
  bodyValidator('items').isArray({ min: 1, max: 50 }),
  bodyValidator('items.*.product_id').isInt({ min: 1 }),
  bodyValidator('items.*.quantity').isInt({ min: 1, max: PUBLIC_ORDER_MAX_QUANTITY_PER_LINE })
    .withMessage(`Quantity must be a whole number from 1 to ${PUBLIC_ORDER_MAX_QUANTITY_PER_LINE}`),
  bodyValidator('payment_method').optional().isIn(['bank_transfer']),
  bodyValidator('payment_provider').optional().toUpperCase().isIn(['GCASH', 'BDO', 'PSBANK']),
  bodyValidator('member_username').optional().isString().isLength({ max: 100 }),
  validate,
];

// Public — no auth
router.get('/public/payment-options', getPublicPaymentOptions);
router.get('/public/influencer/:slug', getInfluencerMetadata);
router.post('/public/influencer/:slug', publicOrderValidation, prepareInfluencerOrder, createPublicOrder);
router.post('/public', publicOrderValidation, createPublicOrder);
router.post('/public/payment-proof', paymentProofUpload.single('proof'), uploadErrorHandler, uploadPublicPaymentProof);

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
router.post('/:id/payment-proof', requirePermission(PERMISSIONS.ORDERS_UPLOAD_PAYMENT_PROOF), paymentProofUpload.single('proof'), uploadErrorHandler, uploadPaymentProof);

// Super admin verifies payment proof
router.patch('/:id/verify-payment', requirePermission(PERMISSIONS.ORDERS_VERIFY_PAYMENT), verifyPayment);

// Order Archive — 'delete' archives the order (record + revenue kept forever); unarchive restores it.
router.patch('/:id/archive', requirePermission(PERMISSIONS.ORDERS_CANCEL), param('id').isInt(), validate, archiveOrder);
router.patch('/:id/unarchive', requirePermission(PERMISSIONS.ORDERS_CANCEL), param('id').isInt(), validate, unarchiveOrder);

module.exports = router;
