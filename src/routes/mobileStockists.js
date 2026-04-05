const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const c = require('../controllers/mobileStockistController');

const r = Router();
r.get('/', auth, role('super_admin', 'provincial_stockist', 'city_stockist'), c.getMobileStockists);
r.post('/', auth, role('super_admin', 'provincial_stockist', 'city_stockist'), c.createMobileStockist);
r.put('/:id', auth, role('super_admin', 'provincial_stockist', 'city_stockist'), c.updateMobileStockist);
module.exports = r;
