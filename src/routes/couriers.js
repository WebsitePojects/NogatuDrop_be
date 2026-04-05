const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const c = require('../controllers/courierController');

const r = Router();
r.get('/', auth, c.getCouriers);
r.post('/', auth, role('super_admin'), c.createCourier);
r.put('/:id', auth, role('super_admin'), c.updateCourier);
module.exports = r;
