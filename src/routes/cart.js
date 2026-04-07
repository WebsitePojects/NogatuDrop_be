const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { getCart, addToCart, updateCartItem, removeCartItem, clearCart } = require('../controllers/cartController');

const router = Router();

router.use(auth);
router.use(roleGuard('admin', 'provincial_stockist', 'city_stockist', 'mobile_stockist', 'staff'));

router.get('/', getCart);

router.post(
  '/',
  [
    body('product_id').isInt().withMessage('Product ID is required'),
    body('quantity').optional().isInt({ min: 1 }),
  ],
  validate,
  addToCart
);

router.put(
  '/:id',
  param('id').isInt(),
  [body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1')],
  validate,
  updateCartItem
);

router.delete('/', clearCart);
router.delete('/all', clearCart);
router.delete('/:id', param('id').isInt(), validate, removeCartItem);

module.exports = router;
