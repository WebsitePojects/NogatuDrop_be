const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const { getKPIs, getRecentOrders } = require('../controllers/dashboardController');

const router = Router();

router.use(auth);

router.get('/kpis', getKPIs);
router.get('/recent-orders', getRecentOrders);

module.exports = router;
