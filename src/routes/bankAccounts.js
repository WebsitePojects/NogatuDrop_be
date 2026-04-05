const { Router } = require('express');
const auth = require('../middleware/authMiddleware');
const role = require('../middleware/roleGuard');
const c = require('../controllers/bankAccountController');

const r = Router();
r.get('/', auth, role('super_admin'), c.getBankAccounts);
r.post('/', auth, role('super_admin'), c.createBankAccount);
r.put('/:id', auth, role('super_admin'), c.updateBankAccount);
r.delete('/:id', auth, role('super_admin'), c.deleteBankAccount);
r.get('/for-order/:orderId', auth, c.getBankAccountForOrder);
module.exports = r;
