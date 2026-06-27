const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const { getUsers, getUser, createUser, updateUser, deleteUser, resetUserPassword } = require('../controllers/userController');

const router = Router();
const { requirePermission } = roleGuard;

router.use(auth);

router.get('/', requirePermission(PERMISSIONS.USERS_VIEW), getUsers);
router.get('/:id', requirePermission(PERMISSIONS.USERS_VIEW), param('id').isInt(), validate, getUser);

router.post(
  '/',
  requirePermission(PERMISSIONS.USERS_MANAGE),
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
    body('role_id').not().exists().withMessage('Use role_slug instead of role_id'),
    body('role_slug').optional().isIn(['super_admin', 'provincial_stockist', 'city_stockist', 'mobile_stockist', 'staff']),
    body('partner_id').optional().isInt(),
    body('level').optional().isIn(['main', 'regional', 'city']),
    body('location').optional().trim(),
  ],
  validate,
  createUser
);

router.put(
  '/:id',
  requirePermission(PERMISSIONS.USERS_MANAGE),
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

router.delete('/:id', requirePermission(PERMISSIONS.USERS_MANAGE), param('id').isInt(), validate, deleteUser);

router.post('/:id/reset-password', requirePermission(PERMISSIONS.USERS_MANAGE), param('id').isInt(), validate, resetUserPassword);

module.exports = router;
