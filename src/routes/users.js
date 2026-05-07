const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { getUsers, getUser, createUser, updateUser, deleteUser } = require('../controllers/userController');

const router = Router();

router.use(auth);

router.get('/', roleGuard('super_admin', 'admin', 'provincial_stockist', 'city_stockist'), getUsers);
router.get('/:id', roleGuard('super_admin', 'admin', 'provincial_stockist', 'city_stockist'), param('id').isInt(), validate, getUser);

router.post(
  '/',
  roleGuard('super_admin', 'admin', 'provincial_stockist', 'city_stockist'),
  [
    body('name')
      .optional({ nullable: true })
      .trim(),
    body('first_name')
      .optional({ nullable: true })
      .trim(),
    body('last_name')
      .optional({ nullable: true })
      .trim(),
    body().custom((value) => {
      const hasName = typeof value.name === 'string' && value.name.trim().length > 0;
      const hasSplitName =
        typeof value.first_name === 'string' && value.first_name.trim().length > 0 &&
        typeof value.last_name === 'string' && value.last_name.trim().length > 0;

      if (!hasName && !hasSplitName) {
        throw new Error('Name is required');
      }
      return true;
    }),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password')
      .isString()
      .withMessage('Password is required')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('role_id').optional().isInt(),
    body('role_slug').optional().isIn(['super_admin', 'admin', 'provincial_stockist', 'city_stockist', 'mobile_stockist', 'staff']),
    body('partner_id').optional().isInt(),
    body('level').optional().isIn(['main', 'regional', 'city']),
    body('location').optional().trim(),
  ],
  validate,
  createUser
);

router.put(
  '/:id',
  roleGuard('super_admin', 'admin', 'provincial_stockist', 'city_stockist'),
  param('id').isInt(),
  [
    body('name').optional().trim().notEmpty(),
    body('email').optional().isEmail(),
    body('status').optional().isIn(['active', 'inactive', 'suspended']),
    body('level').optional().isIn(['main', 'regional', 'city']),
  ],
  validate,
  updateUser
);

router.delete('/:id', roleGuard('super_admin', 'admin', 'provincial_stockist', 'city_stockist'), param('id').isInt(), validate, deleteUser);

module.exports = router;
