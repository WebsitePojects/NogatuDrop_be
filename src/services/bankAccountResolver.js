const ApiError = require('../utils/ApiError');

const isMissingSoftDeleteColumn = (err) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  (
    String(err.message || '').includes("'is_deleted'") ||
    String(err.message || '').includes(".is_deleted'") ||
    String(err.message || '').includes('is_deleted')
  )
);

async function executeSoftDeleteAware(db, primarySql, params = [], fallbackSql = null) {
  try {
    return await db.execute(primarySql, params);
  } catch (err) {
    if (isMissingSoftDeleteColumn(err) && fallbackSql) {
      return db.execute(fallbackSql, params);
    }
    throw err;
  }
}

async function getBankAccountForWarehouseOrDefault(db, warehouseId) {
  let bank = null;

  if (warehouseId) {
    const [banks] = await executeSoftDeleteAware(
      db,
      `SELECT id, warehouse_id, bank_name, account_name, account_number
       FROM bank_accounts
       WHERE warehouse_id = ? AND is_active = 1 AND is_deleted = 0
       ORDER BY is_default DESC, id ASC
       LIMIT 1`,
      [warehouseId],
      `SELECT id, warehouse_id, bank_name, account_name, account_number
       FROM bank_accounts
       WHERE warehouse_id = ? AND is_active = 1
       ORDER BY is_default DESC, id ASC
       LIMIT 1`
    );
    if (banks.length > 0) {
      bank = banks[0];
    }
  }

  if (!bank) {
    const [defaults] = await executeSoftDeleteAware(
      db,
      `SELECT id, warehouse_id, bank_name, account_name, account_number
       FROM bank_accounts
       WHERE is_default = 1 AND is_active = 1 AND is_deleted = 0
       ORDER BY id ASC
       LIMIT 1`,
      [],
      `SELECT id, warehouse_id, bank_name, account_name, account_number
       FROM bank_accounts
       WHERE is_default = 1 AND is_active = 1
       ORDER BY id ASC
       LIMIT 1`
    );
    if (defaults.length > 0) {
      bank = defaults[0];
    }
  }

  return bank
    ? {
        id: Number(bank.id),
        warehouse_id: bank.warehouse_id == null ? null : Number(bank.warehouse_id),
        bank_name: bank.bank_name,
        account_name: bank.account_name,
        account_number: bank.account_number,
      }
    : null;
}

function assertBankAccountAvailable(bankAccount) {
  if (!bankAccount) {
    throw ApiError.serviceUnavailable('No active bank account is configured for this payment route');
  }
}

module.exports = {
  getBankAccountForWarehouseOrDefault,
  assertBankAccountAvailable,
};
