const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const controller = require('../controllers/exportController');

const router = Router();
const { requirePermission } = roleGuard;

router.use(auth);

router.get('/', requirePermission(PERMISSIONS.EXPORTS_GENERATE), controller.getExportJobs);
router.get('/stock-movements', requirePermission(PERMISSIONS.EXPORTS_GENERATE), controller.exportStockMovements);
router.get('/settlements', requirePermission(PERMISSIONS.EXPORTS_GENERATE), controller.exportSettlements);

module.exports = router;
