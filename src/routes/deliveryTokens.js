const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { podUpload, uploadErrorHandler } = require('../middleware/upload');
const c = require('../controllers/deliveryTokenController');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { VEHICLE_TYPES } = require('../utils/vehicleTypes');

const r = Router();
const { requirePermission } = role;

r.post(
  '/',
  auth,
  requirePermission(PERMISSIONS.DELIVERY_TOKENS_CREATE),
  [
    body('order_id').isInt({ min: 1 }).withMessage('order_id is required').toInt(),
    body('vehicle_type').optional({ values: 'falsy' }).isIn(VEHICLE_TYPES)
      .withMessage(`Vehicle must be one of: ${VEHICLE_TYPES.join(', ')}`),
    body('courier_id').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Choose a courier from the list').toInt(),
    // A waybill is letters, digits and dashes; it is shown to the buyer and put in the courier's link.
    body('courier_tracking_number').optional({ values: 'falsy' }).isString().trim()
      .matches(/^[A-Za-z0-9-]{4,40}$/).withMessage('Waybill number: 4 to 40 letters, digits or dashes'),
  ],
  validate,
  c.generateDeliveryLink
);
r.get('/by-order/:orderId', auth, requirePermission(PERMISSIONS.DELIVERY_TOKENS_CREATE), c.getLatestDeliveryLinkForOrder);
r.post(
  '/by-order/:orderId/courier-delivered',
  auth,
  requirePermission(PERMISSIONS.DELIVERY_TOKENS_CREATE),
  [param('orderId').isInt({ min: 1 }).withMessage('Order id must be a number').toInt()],
  validate,
  c.confirmCourierDelivery
);
r.get('/pods', auth, requirePermission(PERMISSIONS.ORDERS_VIEW), c.listDeliveryProofs);
r.get('/pods/by-order/:orderId', auth, requirePermission(PERMISSIONS.ORDERS_VIEW), c.getDeliveryProofForOrder);

r.get('/deliver/:token', c.getDeliveryInfo);
r.post('/deliver/:token/complete', podUpload.single('photo'), uploadErrorHandler, c.completeDelivery);

module.exports = r;
