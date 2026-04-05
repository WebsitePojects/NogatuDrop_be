const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const c = require('../controllers/stockMovementController');

const r = Router();
r.get('/', auth, c.getStockMovements);
module.exports = r;
