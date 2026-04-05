const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { productUpload: upload } = require('../middleware/upload');
const { getProducts, getProduct, createProduct, updateProduct, deleteProduct } = require('../controllers/productController');

const router = Router();

router.use(auth);

router.get('/', getProducts);
router.get('/:id', param('id').isInt(), validate, getProduct);

router.post(
  '/',
  roleGuard('super_admin'),
  upload.single('image'),
  [
    body('name').trim().notEmpty().withMessage('Product name is required'),
    body('sku').trim().notEmpty().withMessage('SKU is required'),
    body('retail_price').isFloat({ min: 0 }).withMessage('Valid retail price is required'),
    body('partner_price').isFloat({ min: 0 }).withMessage('Valid partner price is required'),
    body('category').optional().trim(),
    body('unit').optional().trim(),
    body('description').optional().trim(),
  ],
  validate,
  createProduct
);

router.put(
  '/:id',
  roleGuard('super_admin'),
  param('id').isInt(),
  upload.single('image'),
  [
    body('name').optional().trim().notEmpty(),
    body('sku').optional().trim().notEmpty(),
    body('retail_price').optional().isFloat({ min: 0 }),
    body('partner_price').optional().isFloat({ min: 0 }),
  ],
  validate,
  updateProduct
);

router.delete('/:id', roleGuard('super_admin'), param('id').isInt(), validate, deleteProduct);

module.exports = router;
