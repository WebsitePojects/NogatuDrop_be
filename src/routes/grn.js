const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const c = require('../controllers/grnController');

const r = Router();
r.use(auth);
r.get('/', roleGuard.requirePermission(PERMISSIONS.GRN_VIEW), c.getGRNs);
r.post('/', roleGuard.requirePermission(PERMISSIONS.GRN_CREATE), c.createGRN);
r.get('/:id', roleGuard.requirePermission(PERMISSIONS.GRN_VIEW), c.getGRN);
r.patch('/:id/complete', roleGuard.requirePermission(PERMISSIONS.GRN_COMPLETE), c.completeGRN);
module.exports = r;
