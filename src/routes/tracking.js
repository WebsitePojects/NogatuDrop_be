const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const {
  getTracking,
  getPublicTracking,
  getOrderPings,
  getActiveTracking,
  postPingByToken,
  postPing,
  updateTrackingStatus,
  createTracking,
} = require('../controllers/trackingController');

const router = Router();

// Public tracking endpoints (no auth)
router.get('/public/:orderNumber', param('orderNumber').isString().trim().notEmpty(), validate, getPublicTracking);

router.post(
  '/ping/:token',
  [
    param('token').isString().trim().notEmpty(),
    body('lat').isFloat().withMessage('Latitude is required'),
    body('lng').isFloat().withMessage('Longitude is required'),
    body('speed_kmh').optional().isFloat(),
    body('accuracy_meters').optional().isFloat(),
  ],
  validate,
  postPingByToken
);

router.use(auth);

router.get('/active', roleGuard('super_admin'), getActiveTracking);

router.get('/:orderId/pings', param('orderId').isInt(), validate, getOrderPings);

router.get('/:orderId', param('orderId').isInt(), validate, getTracking);

router.post(
  '/',
  roleGuard('super_admin'),
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
  roleGuard('staff'),
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
  roleGuard('staff'),
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
  roleGuard('super_admin', 'staff'),
  param('trackingId').isInt(),
  [
    body('status').optional().isIn(['in_progress', 'out_for_delivery', 'delivered']),
    body('rider_name').optional().trim(),
    body('rider_user_id').optional().isInt(),
    body('est_delivery_at').optional().isISO8601(),
  ],
  validate,
  updateTrackingStatus
);

module.exports = router;
