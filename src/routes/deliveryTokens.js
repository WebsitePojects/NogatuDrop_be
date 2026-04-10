const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const { podUpload } = require('../middleware/upload');
const c = require('../controllers/deliveryTokenController');

const r = Router();

// Staff / super_admin generates delivery link
r.post('/', auth, role('super_admin', 'staff', 'provincial_stockist', 'city_stockist'), c.generateDeliveryLink);
r.get('/by-order/:orderId', auth, role('super_admin', 'staff', 'provincial_stockist', 'city_stockist'), c.getLatestDeliveryLinkForOrder);

// Public — no auth — delivery page + completion
r.get('/deliver/:token', c.getDeliveryInfo);
r.post('/deliver/:token/complete', podUpload.single('photo'), c.completeDelivery);

module.exports = r;
