const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { getKPIs, getRecentOrders } = require('../controllers/dashboardController');

const router = Router();
const { requirePermission } = roleGuard;

router.use(auth);
router.use(requirePermission(PERMISSIONS.DASHBOARD_VIEW));

router.get('/kpis', getKPIs);
router.get('/recent-orders', getRecentOrders);

module.exports = router;
