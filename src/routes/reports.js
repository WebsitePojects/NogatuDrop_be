const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const {
  getRevenueReport,
  getPurchaseReport,
  getProductReport,
  getMovementsReport,
  getInfluencerReport,
  exportInfluencerReport,
} = require('../controllers/reportController');

const router = Router();
const { requirePermission } = roleGuard;

router.use(auth);

// Company-wide revenue and customer addresses: super_admin only. REPORTS_VIEW is also held by
// stockists, so it must NOT gate these. Declared before the REPORTS_VIEW router.use below.
router.get('/influencers', roleGuard('super_admin'), getInfluencerReport);
router.get('/influencers/export', roleGuard('super_admin'), exportInfluencerReport);

router.use(requirePermission(PERMISSIONS.REPORTS_VIEW));

router.get('/revenue', getRevenueReport);
// Backward-compatible alias used by older clients.
router.get('/sales-summary', getRevenueReport);
router.get('/purchases', getPurchaseReport);
router.get('/products', getProductReport);
router.get('/movements', getMovementsReport);

module.exports = router;
