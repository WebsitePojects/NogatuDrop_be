const { Router } = require('express');
const { body, param } = require('express-validator');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const validate = require('../middleware/validate');
const { PERMISSIONS } = require('../rbac/permissions');
const c = require('../controllers/bankAccountController');

const r = Router();

const idParam = param('id').isInt({ min: 1 });
const optionalText = (field, max) => body(field).optional().isString().trim().isLength({ min: 1, max });
const requiredText = (field, max) => body(field).isString().trim().isLength({ min: 1, max });

const createValidation = [
  body('warehouse_id').optional({ values: 'null' }).isInt({ min: 1 }).toInt(),
  requiredText('bank_name', 100),
  requiredText('account_name', 150),
  requiredText('account_number', 50),
  body('is_default').optional().isBoolean().toBoolean(),
  validate,
];

const updateValidation = [
  idParam,
  optionalText('bank_name', 100),
  optionalText('account_name', 150),
  optionalText('account_number', 50),
  body('is_active').optional().isBoolean().toBoolean(),
  body('is_default').optional().isBoolean().toBoolean(),
  validate,
];

r.use(auth);
// Super Admin manages every account; a Provincial or City Stockist manages only its own warehouses' accounts
// (the controller scopes each query). Staff do not manage money details.
const ACCOUNT_MANAGERS = ['super_admin', 'provincial_stockist', 'city_stockist'];
r.get('/', roleGuard(...ACCOUNT_MANAGERS), c.getBankAccounts);
r.post('/', roleGuard(...ACCOUNT_MANAGERS), createValidation, c.createBankAccount);
r.put('/:id', roleGuard(...ACCOUNT_MANAGERS), updateValidation, c.updateBankAccount);
r.delete('/:id', roleGuard(...ACCOUNT_MANAGERS), [idParam, validate], c.deleteBankAccount);
r.get('/for-order/:orderId', roleGuard.requirePermission(PERMISSIONS.ORDERS_VIEW), c.getBankAccountForOrder);
module.exports = r;
