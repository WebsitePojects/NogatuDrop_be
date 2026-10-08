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
  changeShippingFee,
} = require('../controllers/orderController');

const { PUBLIC_ORDER_MAX_QUANTITY_PER_LINE } = require('../services/publicOrderLimits');
const {
  NAME_SUFFIXES, PERSON_NAME_PATTERN, NAME_MAX_LENGTH, ADDRESS_LINE_MAX_LENGTH,
  BARANGAY_CODE_PATTERN, POSTAL_CODE_PATTERN,
} = require('../services/publicCustomerInput');
const { coordinatePairValidator } = require('../services/addressInput');

const router = Router();
const { requirePermission } = role;

// bail() after each failed rule so a field reports one message, not every rule it broke.
const personName = (field, label, { optional = false } = {}) => {
  const chain = bodyValidator(field);
  if (optional) chain.optional({ values: 'falsy' });
  return chain
    .isString().withMessage(`${label} must be text`).bail()
    .trim()
    .isLength({ min: 1, max: NAME_MAX_LENGTH }).withMessage(`${label} is required (up to ${NAME_MAX_LENGTH} characters)`).bail()
    .matches(PERSON_NAME_PATTERN).withMessage(`${label} can only contain letters, spaces, periods, apostrophes and hyphens`);
};

const publicOrderValidation = [
  personName('customer_first_name', 'First name'),
  personName('customer_middle_name', 'Middle name', { optional: true }),
  personName('customer_last_name', 'Last name'),
  bodyValidator('customer_name_suffix').optional({ values: 'falsy' }).isIn(NAME_SUFFIXES)
    .withMessage(`Suffix must be one of ${NAME_SUFFIXES.join(', ')}`),
  bodyValidator('customer_address_line')
    .isString().withMessage('House no., street and subdivision are required').bail()
    .trim()
    .isLength({ min: 3, max: ADDRESS_LINE_MAX_LENGTH })
    .withMessage(`House no., street and subdivision are required (up to ${ADDRESS_LINE_MAX_LENGTH} characters)`),
  bodyValidator('customer_barangay_code')
    .isString().withMessage('Please choose your barangay from the list.').bail().matches(BARANGAY_CODE_PATTERN)
    .withMessage('Please choose your barangay from the list.'),
  bodyValidator('customer_postal_code').optional({ values: 'falsy' })
    .isString().bail().trim().matches(POSTAL_CODE_PATTERN)
    .withMessage('Postal code must be 4 digits'),
  // The optional delivery pin must be a lat/lng pair inside the Philippines (400 with the shared message).
  coordinatePairValidator('customer_lat', 'customer_lng'),
  bodyValidator('customer_phone').optional().isString().isLength({ max: 30 }),
  // Blank means "not given": the checkout labels email as optional and may send an empty string.
  bodyValidator('customer_email').optional({ values: 'falsy' }).isEmail().withMessage('Please enter a valid email address, or leave it blank').normalizeEmail(),
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

// Staff change a store order's delivery fee before payment is verified (who may: affiliationScopes).
router.patch(
  '/:id/shipping-fee',
  requirePermission(PERMISSIONS.ORDERS_APPROVE),
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid order'),
    body('shipping_fee').isFloat({ min: 0, max: 100000 }).withMessage('Enter a delivery fee from 0 to 100,000'),
    body('reason').isString().trim().isLength({ min: 3, max: 255 }).withMessage('Give a short reason (3 to 255 characters)'),
  ],
  validate,
  changeShippingFee
);

// Super admin verifies payment proof
router.patch('/:id/verify-payment', requirePermission(PERMISSIONS.ORDERS_VERIFY_PAYMENT), verifyPayment);

// Order Archive — 'delete' archives the order (record + revenue kept forever); unarchive restores it.
router.patch('/:id/archive', requirePermission(PERMISSIONS.ORDERS_CANCEL), param('id').isInt(), validate, archiveOrder);
router.patch('/:id/unarchive', requirePermission(PERMISSIONS.ORDERS_CANCEL), param('id').isInt(), validate, unarchiveOrder);

module.exports = router;
