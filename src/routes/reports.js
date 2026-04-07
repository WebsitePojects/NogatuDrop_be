const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const { getRevenueReport, getPurchaseReport, getProductReport, getMovementsReport } = require('../controllers/reportController');

const router = Router();

router.use(auth);

router.get('/revenue', getRevenueReport);
router.get('/purchases', getPurchaseReport);
router.get('/products', getProductReport);
router.get('/movements', getMovementsReport);

module.exports = router;
