const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const c = require('../controllers/stockAdjustmentController');

const r = Router();
r.get('/', auth, c.getAdjustments);
r.post('/', auth, c.createAdjustment);
r.patch('/:id/approve', auth, role('super_admin'), c.approveAdjustment);
r.patch('/:id/reject', auth, role('super_admin'), c.rejectAdjustment);
module.exports = r;
