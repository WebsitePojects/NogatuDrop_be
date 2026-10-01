const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getBankAccountForWarehouseOrDefault,
  getPublicPaymentAccounts,
  selectPublicPaymentAccount,
  normalizeProvider,
} = require('../src/services/bankAccountResolver');

const ACCOUNTS = [
  { id: 1, warehouse_id: 10, bank_name: 'GCASH', account_name: 'Caloocan', account_number: '111', is_default: 0, is_active: 1, is_deleted: 0 },
  { id: 2, warehouse_id: 10, bank_name: 'BDO', account_name: 'Caloocan inactive', account_number: '222', is_default: 1, is_active: 0, is_deleted: 0 },
  { id: 3, warehouse_id: 10, bank_name: 'BDO', account_name: 'Caloocan deleted', account_number: '333', is_default: 1, is_active: 1, is_deleted: 1 },
  { id: 4, warehouse_id: 11, bank_name: 'PSBANK', account_name: 'Tycoon default', account_number: '444', is_default: 1, is_active: 1, is_deleted: 0 },
  { id: 5, warehouse_id: null, bank_name: 'BDO', account_name: 'Company', account_number: '555', is_default: 1, is_active: 1, is_deleted: 0 },
];

/**
 * Evaluates the predicates present in the SQL text against fixture rows, so the
 * test fails if the resolver ever drops an active / not-deleted / warehouse scope clause.
 */
function fakeBankDb(rows = ACCOUNTS) {
  return {
    execute: async (sql, params) => {
      let bound = 0;
      let result = rows.slice();
      if (/is_active = 1/.test(sql)) result = result.filter((r) => r.is_active === 1);
      if (/is_deleted = 0/.test(sql)) result = result.filter((r) => r.is_deleted === 0);
      if (/is_default = 1/.test(sql)) result = result.filter((r) => r.is_default === 1);
      if (/\(warehouse_id = \? OR warehouse_id IS NULL\)/.test(sql)) {
        const wid = params[bound++];
        result = result.filter((r) => r.warehouse_id === wid || r.warehouse_id === null);
      } else if (/warehouse_id = \? AND/.test(sql)) {
        const wid = params[bound++];
        result = result.filter((r) => r.warehouse_id === wid);
      } else if (/warehouse_id IS NULL/.test(sql)) {
        result = result.filter((r) => r.warehouse_id === null);
      }
      return [result.sort((a, b) => a.id - b.id)];
    },
  };
}

test('resolver returns the order warehouse own active account', async () => {
  const bank = await getBankAccountForWarehouseOrDefault(fakeBankDb(), 10);
  assert.equal(bank.id, 1);
  assert.equal(bank.warehouse_id, 10);
});

test('resolver never returns an inactive or soft-deleted account', async () => {
  const onlyBad = ACCOUNTS.filter((r) => r.id === 2 || r.id === 3);
  assert.equal(await getBankAccountForWarehouseOrDefault(fakeBankDb(onlyBad), 10), null);
});

test('resolver falls back to the company default when the warehouse has no usable account', async () => {
  const withoutWarehouseTen = ACCOUNTS.filter((r) => r.warehouse_id !== 10);
  const bank = await getBankAccountForWarehouseOrDefault(fakeBankDb(withoutWarehouseTen), 10);
  assert.equal(bank.id, 5);
  assert.equal(bank.warehouse_id, null);
});

test('resolver falls back to the company default when there is no warehouse id', async () => {
  assert.equal((await getBankAccountForWarehouseOrDefault(fakeBankDb(), null)).id, 5);
});

test('fallback never hands out another warehouse account that is merely flagged is_default', async () => {
  // Warehouse 12 has no account of its own; warehouse 11 holds an is_default account.
  const noCompanyDefault = ACCOUNTS.filter((r) => r.id !== 5);
  assert.equal(await getBankAccountForWarehouseOrDefault(fakeBankDb(noCompanyDefault), 12), null);
});

test('public accounts load only this warehouse plus company accounts, active and not deleted', async () => {
  const accounts = await getPublicPaymentAccounts(fakeBankDb(), 10);
  assert.deepEqual(accounts.map((a) => a.id), [1, 5]);
  assert.deepEqual(accounts.map((a) => a.provider), ['GCASH', 'BDO']);
});

test('getPublicPaymentAccounts works when destructured and called as a bare function', async () => {
  // orderController imports it by destructuring; it must not rely on `this`.
  const { getPublicPaymentAccounts: bare } = require('../src/services/bankAccountResolver');
  const accounts = await bare(fakeBankDb(), 11);
  assert.deepEqual(accounts.map((a) => a.id), [4, 5]);
});

test('public selection prefers the warehouse account, then the company account, else fails closed', async () => {
  const forTen = await getPublicPaymentAccounts(fakeBankDb(), 10);
  assert.equal(selectPublicPaymentAccount(forTen, 'GCASH', 10).id, 1);
  assert.equal(selectPublicPaymentAccount(forTen, 'bdo', 10).id, 5);
  assert.throws(() => selectPublicPaymentAccount(forTen, 'PSBANK', 10), (err) => err.statusCode === 503);
  assert.throws(() => selectPublicPaymentAccount(forTen, 'MAYA', 10), (err) => err.statusCode === 400);
});

test('normalizeProvider tolerates spacing and punctuation and rejects unknown banks', () => {
  assert.equal(normalizeProvider('G-Cash'), 'GCASH');
  assert.equal(normalizeProvider('PS Bank'), 'PSBANK');
  assert.equal(normalizeProvider('Metrobank'), null);
  assert.equal(normalizeProvider(null), null);
});
