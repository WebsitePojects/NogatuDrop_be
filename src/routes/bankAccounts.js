const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const roleGuard = require('../middleware/roleGuard');
const { PERMISSIONS } = require('../rbac/permissions');
const c = require('../controllers/bankAccountController');

const r = Router();
r.use(auth);
r.get('/', roleGuard('super_admin'), c.getBankAccounts);
r.post('/', roleGuard('super_admin'), c.createBankAccount);
r.put('/:id', roleGuard('super_admin'), c.updateBankAccount);
r.delete('/:id', roleGuard('super_admin'), c.deleteBankAccount);
r.get('/for-order/:orderId', roleGuard.requirePermission(PERMISSIONS.ORDERS_VIEW), c.getBankAccountForOrder);
module.exports = r;
