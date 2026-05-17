const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { getRevenueReport, getPurchaseReport, getProductReport, getMovementsReport } = require('../controllers/reportController');

const router = Router();
const { requirePermission } = roleGuard;

router.use(auth);
router.use(requirePermission(PERMISSIONS.REPORTS_VIEW));

router.get('/revenue', getRevenueReport);
// Backward-compatible alias used by older clients.
router.get('/sales-summary', getRevenueReport);
router.get('/purchases', getPurchaseReport);
router.get('/products', getProductReport);
router.get('/movements', getMovementsReport);

module.exports = router;
