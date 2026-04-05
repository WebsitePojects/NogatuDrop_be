const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const c = require('../controllers/grnController');

const r = Router();
r.get('/', auth, role('super_admin', 'provincial_stockist', 'city_stockist', 'staff'), c.getGRNs);
r.post('/', auth, role('super_admin', 'provincial_stockist', 'city_stockist', 'staff'), c.createGRN);
r.get('/:id', auth, role('super_admin', 'provincial_stockist', 'city_stockist', 'staff'), c.getGRN);
r.patch('/:id/complete', auth, role('super_admin', 'provincial_stockist', 'city_stockist', 'staff'), c.completeGRN);
module.exports = r;
