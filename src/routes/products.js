const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { productUpload: upload, uploadErrorHandler } = require('../middleware/upload');
const { getProducts, getPublicProducts, getProduct, createProduct, updateProduct, deleteProduct } = require('../controllers/productController');

const router = Router();

router.get('/public', getPublicProducts);

router.use(auth);

router.get('/', getProducts);
router.get('/:id', param('id').isInt(), validate, getProduct);

router.post(
  '/',
  roleGuard('super_admin'),
  upload.single('image'),
  uploadErrorHandler,
  [
    body('name').trim().notEmpty().withMessage('Product name is required'),
    body('sku').trim().notEmpty().withMessage('SKU is required'),
    body('retail_price').isFloat({ min: 0 }).withMessage('Valid retail price is required'),
    body('partner_price').isFloat({ min: 0 }).withMessage('Valid partner price is required'),
    body('category').optional().trim(),
    body('unit').optional().trim(),
    body('description').optional().trim(),
    // Grams of one unit as packed; checkout prices shipping from it (a product without it cannot be checked out).
    body('weight_grams').optional({ values: 'falsy' }).isInt({ min: 1, max: 50000 })
      .withMessage('Weight must be a whole number of grams from 1 to 50,000').toInt(),
    // Unticked for packages: they never get the Nogatu Alliance member price.
    body('member_price_eligible').optional().isBoolean().withMessage('Member price must be true or false').toBoolean(),
  ],
  validate,
  createProduct
);

router.put(
  '/:id',
  roleGuard('super_admin'),
  param('id').isInt(),
  upload.single('image'),
  uploadErrorHandler,
  [
    body('name').optional().trim().notEmpty(),
    body('sku').optional().trim().notEmpty(),
    body('retail_price').optional().isFloat({ min: 0 }),
    body('partner_price').optional().isFloat({ min: 0 }),
    // Grams of one unit as packed; checkout prices shipping from it (a product without it cannot be checked out).
    body('weight_grams').optional({ values: 'falsy' }).isInt({ min: 1, max: 50000 })
      .withMessage('Weight must be a whole number of grams from 1 to 50,000').toInt(),
    // Unticked for packages: they never get the Nogatu Alliance member price.
    body('member_price_eligible').optional().isBoolean().withMessage('Member price must be true or false').toBoolean(),
  ],
  validate,
  updateProduct
);

router.delete('/:id', roleGuard('super_admin'), param('id').isInt(), validate, deleteProduct);

module.exports = router;
