const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const {
  getTracking,
  getPublicTracking,
  getPublicPaymentDetails,
  getOrderPings,
  getOrderRoute,
  getActiveTracking,
  postPingByToken,
  postPing,
  updateTrackingStatus,
  createTracking,
} = require('../controllers/trackingController');

const router = Router();

// Public tracking endpoints (no auth)
router.get('/public/:orderNumber', param('orderNumber').isString().trim().notEmpty(), validate, getPublicTracking);
// POST so the phone number travels in the body, never in a URL that ends up in access logs.
router.post(
  '/public/:orderNumber/payment-details',
  [
    param('orderNumber').isString().trim().notEmpty(),
    body('customer_phone').isString().withMessage('Enter the phone number used at checkout').bail()
      .trim().isLength({ min: 10, max: 30 }).withMessage('Enter the phone number used at checkout'),
  ],
  validate,
  getPublicPaymentDetails
);

router.post(
  '/ping/:token',
  [
    param('token').isString().trim().notEmpty(),
    body('lat').isFloat().withMessage('Latitude is required'),
    body('lng').isFloat().withMessage('Longitude is required'),
    // Phones send null speed/accuracy when they have no reading (standing still, weak fix). null must
    // pass, or every such ping is refused and the rider never shows on the map.
    body('speed_kmh').optional({ values: 'null' }).isFloat().withMessage('speed_kmh must be a number'),
    body('accuracy_meters').optional({ values: 'null' }).isFloat().withMessage('accuracy_meters must be a number'),
  ],
  validate,
  postPingByToken
);

router.use(auth);

router.get(
  '/active',
  roleGuard.requirePermission(PERMISSIONS.TRACKING_VIEW),
  getActiveTracking
);

router.get(
  '/:orderId/route',
  roleGuard.requirePermission(PERMISSIONS.TRACKING_VIEW),
  param('orderId').isInt({ min: 1 }),
  validate,
  getOrderRoute
);
router.get(
  '/:orderId/pings',
  roleGuard.requirePermission(PERMISSIONS.TRACKING_VIEW),
  param('orderId').isInt(),
  validate,
  getOrderPings
);

router.get(
  '/:orderId',
  roleGuard.requirePermission(PERMISSIONS.TRACKING_VIEW),
  param('orderId').isInt(),
  validate,
  getTracking
);

router.post(
  '/',
  roleGuard.requirePermission(PERMISSIONS.DELIVERY_STATUS_UPDATE),
  [
    body('order_id').isInt().withMessage('Order ID is required'),
    body('transfer_id').optional().isInt(),
    body('rider_user_id').optional().isInt(),
    body('rider_name').optional().trim(),
    body('est_delivery_at').optional().isISO8601(),
  ],
  validate,
  createTracking
);

router.post(
  '/ping',
  roleGuard.requirePermission(PERMISSIONS.DELIVERY_STATUS_UPDATE),
  [
    body('tracking_id').isInt().withMessage('Tracking ID is required'),
    body('lat').isFloat().withMessage('Latitude is required'),
    body('lng').isFloat().withMessage('Longitude is required'),
    body('speed_kmh').optional().isFloat(),
    body('accuracy_meters').optional().isFloat(),
  ],
  validate,
  postPing
);

// Backward-compatible route shape
router.post(
  '/:trackingId/ping',
  roleGuard.requirePermission(PERMISSIONS.DELIVERY_STATUS_UPDATE),
  param('trackingId').isInt(),
  [
    body('lat').isFloat().withMessage('Latitude is required'),
    body('lng').isFloat().withMessage('Longitude is required'),
    body('speed_kmh').optional().isFloat(),
    body('accuracy_meters').optional().isFloat(),
  ],
  validate,
  postPing
);

router.patch(
  '/:trackingId/status',
  roleGuard.requirePermission(PERMISSIONS.DELIVERY_STATUS_UPDATE),
  param('trackingId').isInt(),
  [
    body('status').optional().isIn(['in_progress', 'out_for_delivery']),
    body('rider_name').optional().trim(),
    body('rider_user_id').optional().isInt(),
    body('est_delivery_at').optional().isISO8601(),
  ],
  validate,
  updateTrackingStatus
);

module.exports = router;
