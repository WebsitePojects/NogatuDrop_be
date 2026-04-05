const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const { paymentProofUpload } = require('../middleware/upload');
const {
  getOrders, getOrder, createOrder, createPublicOrder,
  approveOrder, rejectOrder, cancelOrder,
  uploadPaymentProof, verifyPayment,
} = require('../controllers/orderController');

const router = Router();

// Public — no auth
router.post('/public', createPublicOrder);

// Authenticated
router.use(auth);

router.get('/', getOrders);
router.get('/:id', param('id').isInt(), validate, getOrder);

router.post(
  '/',
  role('provincial_stockist', 'city_stockist', 'mobile_stockist'),
  [body('notes').optional().trim()],
  validate,
  createOrder
);

router.patch('/:id/approve', role('super_admin'), approveOrder);
router.patch('/:id/reject', role('super_admin'), [body('reason').optional().trim()], validate, rejectOrder);
router.patch('/:id/cancel', cancelOrder);

// Stockist uploads payment proof (Cloudinary)
router.post('/:id/payment-proof', paymentProofUpload.single('proof'), uploadPaymentProof);

// Super admin verifies payment proof
router.patch('/:id/verify-payment', role('super_admin'), verifyPayment);

module.exports = router;
