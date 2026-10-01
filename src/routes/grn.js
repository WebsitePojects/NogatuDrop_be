const { Router } = require('express');
const { body, header } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { MAX_RECEIVE_QUANTITY, isFutureIsoDate } = require('../services/stockReceiving');
const c = require('../controllers/grnController');

// Unknown body fields are never read by the controller, so they are dropped rather than rejected.
const quickReceiveValidation = [
  header('Idempotency-Key').isString().withMessage('A valid Idempotency-Key header is required').bail().trim().isLength({ min: 8, max: 200 })
    .withMessage('A valid Idempotency-Key header is required'),
  body('product_id').isInt({ min: 1 }).withMessage('product_id must be a positive integer').toInt(),
  body('warehouse_id').optional({ values: 'null' }).isInt({ min: 1 }).withMessage('warehouse_id must be a positive integer').toInt(),
  body('quantity').isInt({ min: 1, max: MAX_RECEIVE_QUANTITY })
    .withMessage(`quantity must be a whole number between 1 and ${MAX_RECEIVE_QUANTITY}`).toInt(),
  body('batch_number').isString().withMessage('batch_number is required (max 50 characters)').bail().trim().isLength({ min: 1, max: 50 })
    .withMessage('batch_number is required (max 50 characters)'),
  body('expiry_date').custom((value) => isFutureIsoDate(value))
    .withMessage('expiry_date must be a future date in YYYY-MM-DD format'),
  body('supplier').optional({ values: 'null' }).isString().withMessage('supplier must be text').bail().trim().isLength({ max: 150 }).withMessage('supplier must be at most 150 characters'),
  body('notes').optional({ values: 'null' }).isString().withMessage('notes must be text').bail().trim().isLength({ max: 1000 }).withMessage('notes must be at most 1000 characters'),
];

const r = Router();
r.use(auth);
r.get('/', roleGuard.requirePermission(PERMISSIONS.GRN_VIEW), c.getGRNs);
r.post('/', roleGuard.requirePermission(PERMISSIONS.GRN_CREATE), c.createGRN);
r.post('/quick-receive', roleGuard.requirePermission(PERMISSIONS.GRN_CREATE), quickReceiveValidation, validate, c.quickReceive);
r.get('/:id', roleGuard.requirePermission(PERMISSIONS.GRN_VIEW), c.getGRN);
r.patch('/:id/complete', roleGuard.requirePermission(PERMISSIONS.GRN_COMPLETE), c.completeGRN);
module.exports = r;
