const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const c = require('../controllers/mobileStockistController');

const r = Router();
r.use(auth);
r.get('/', roleGuard.requirePermission(PERMISSIONS.MOBILE_STOCKISTS_VIEW), c.getMobileStockists);
r.post('/', roleGuard.requirePermission(PERMISSIONS.MOBILE_STOCKISTS_MANAGE), c.createMobileStockist);
r.put('/:id', roleGuard.requirePermission(PERMISSIONS.MOBILE_STOCKISTS_MANAGE), c.updateMobileStockist);
module.exports = r;
