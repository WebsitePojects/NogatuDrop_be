const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const c = require('../controllers/stockAdjustmentController');

const r = Router();
const { requirePermission } = role;

r.get('/', auth, requirePermission(PERMISSIONS.STOCK_ADJUSTMENTS_VIEW), c.getAdjustments);
r.post('/', auth, requirePermission(PERMISSIONS.STOCK_ADJUSTMENTS_CREATE), c.createAdjustment);
r.patch('/:id/approve', auth, requirePermission(PERMISSIONS.STOCK_ADJUSTMENTS_APPROVE), c.approveAdjustment);
r.patch('/:id/reject', auth, requirePermission(PERMISSIONS.STOCK_ADJUSTMENTS_APPROVE), c.rejectAdjustment);
module.exports = r;
