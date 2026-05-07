const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const rateLimit = require('express-rate-limit');
const { dtaUpload } = require('../middleware/upload');
const c = require('../controllers/applicationController');

const dtaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { success: false, message: 'Too many applications. Please try again later.' },
});

const r = Router();
r.get('/', auth, role('super_admin'), c.getApplications);
r.get('/:id', auth, role('super_admin'), c.getApplication);
r.post(
  '/dta',
  dtaLimiter,
  dtaUpload.fields([
    { name: 'id_front', maxCount: 1 },
    { name: 'id_back', maxCount: 1 },
    { name: 'id_document', maxCount: 1 },
    { name: 'business_permit', maxCount: 1 },
  ]),
  c.submitDTA
);
r.patch('/:id/approve', auth, role('super_admin'), c.approveApplication);
r.patch('/:id/reject', auth, role('super_admin'), c.rejectApplication);
module.exports = r;
