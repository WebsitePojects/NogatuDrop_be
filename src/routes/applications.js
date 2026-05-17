const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const c = require('../controllers/applicationController');

const r = Router();
r.get('/', auth, role('super_admin'), c.getApplications);
r.get('/:id', auth, role('super_admin'), c.getApplication);
r.patch('/:id/approve', auth, role('super_admin'), c.approveApplication);
r.patch('/:id/reject', auth, role('super_admin'), c.rejectApplication);
module.exports = r;
