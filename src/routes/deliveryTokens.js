const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { podUpload } = require('../middleware/upload');
const c = require('../controllers/deliveryTokenController');

const r = Router();
const { requirePermission } = role;

r.post('/', auth, requirePermission(PERMISSIONS.DELIVERY_TOKENS_CREATE), c.generateDeliveryLink);
r.get('/by-order/:orderId', auth, requirePermission(PERMISSIONS.DELIVERY_TOKENS_CREATE), c.getLatestDeliveryLinkForOrder);
r.get('/pods', auth, requirePermission(PERMISSIONS.ORDERS_VIEW), c.listDeliveryProofs);
r.get('/pods/by-order/:orderId', auth, requirePermission(PERMISSIONS.ORDERS_VIEW), c.getDeliveryProofForOrder);

r.get('/deliver/:token', c.getDeliveryInfo);
r.post('/deliver/:token/complete', podUpload.single('photo'), c.completeDelivery);

module.exports = r;
