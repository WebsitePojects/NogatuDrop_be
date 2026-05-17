const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const c = require('../controllers/stockMovementController');

const r = Router();
r.get('/', auth, roleGuard.requirePermission(PERMISSIONS.INVENTORY_VIEW), c.getStockMovements);
module.exports = r;
