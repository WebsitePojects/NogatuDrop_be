const ApiError = require('../utils/ApiError');

// Providers the public storefront offers. Admin-managed accounts for any other
// bank still work for internal (stockist) orders; they are simply not selectable
// at public checkout.
const PUBLIC_PAYMENT_PROVIDERS = Object.freeze(['GCASH', 'BDO', 'PSBANK']);

const isMissingSoftDeleteColumn = (err) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes('is_deleted')
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

function toPublicBankAccount(bank) {
  return {
    id: Number(bank.id),
    warehouse_id: bank.warehouse_id == null ? null : Number(bank.warehouse_id),
    bank_name: bank.bank_name,
    account_name: bank.account_name,
    account_number: bank.account_number,
  };
}

/**
 * Account a buyer must pay into for an order sourced from `warehouseId`:
 * the warehouse's own active account, else the company default account.
 *
 * The fallback is restricted to `warehouse_id IS NULL`. Without that, another
 * warehouse's account flagged `is_default` would be returned and the buyer would
 * pay the wrong center.
 */
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
    bank = banks[0] || null;
  }

  if (!bank) {
    const [defaults] = await executeSoftDeleteAware(
      db,
      `SELECT id, warehouse_id, bank_name, account_name, account_number
       FROM bank_accounts
       WHERE warehouse_id IS NULL AND is_default = 1 AND is_active = 1 AND is_deleted = 0
       ORDER BY id ASC
       LIMIT 1`,
      [],
      `SELECT id, warehouse_id, bank_name, account_name, account_number
       FROM bank_accounts
       WHERE warehouse_id IS NULL AND is_default = 1 AND is_active = 1
       ORDER BY id ASC
       LIMIT 1`
    );
    bank = defaults[0] || null;
  }

  return bank ? toPublicBankAccount(bank) : null;
}

function assertBankAccountAvailable(bankAccount) {
  if (!bankAccount) {
    throw ApiError.serviceUnavailable('No active bank account is configured for this payment route');
  }
}

function normalizeProvider(bankName) {
  const value = String(bankName || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return PUBLIC_PAYMENT_PROVIDERS.find((provider) => value.includes(provider)) || null;
}

/**
 * Active accounts a public order for `warehouseId` may pay into, tagged with provider: that warehouse's own
 * accounts when it has any, otherwise the company-level (NULL warehouse) ones. Never a mix: a buyer of a
 * Stockist pays that Stockist, so the company's BDO must not appear beside the Stockist's GCash (Sir Dino,
 * 2026-11-26). Other warehouses' accounts are never loaded.
 */
async function getPublicPaymentAccounts(db, warehouseId) {
  const scopeWarehouseId = warehouseId == null ? null : warehouseId;
  const [rows] = await executeSoftDeleteAware(
    db,
    `SELECT id, warehouse_id, bank_name, account_name, account_number
     FROM bank_accounts
     WHERE is_active = 1 AND is_deleted = 0 AND (warehouse_id = ? OR warehouse_id IS NULL)
     ORDER BY (warehouse_id = ?) DESC, is_default DESC, id ASC`,
    [scopeWarehouseId, scopeWarehouseId],
    `SELECT id, warehouse_id, bank_name, account_name, account_number
     FROM bank_accounts
     WHERE is_active = 1 AND (warehouse_id = ? OR warehouse_id IS NULL)
     ORDER BY (warehouse_id = ?) DESC, is_default DESC, id ASC`
  );
  const payable = rows
    .map((row) => ({ ...row, provider: normalizeProvider(row.bank_name) }))
    .filter((row) => row.provider);
  const own = scopeWarehouseId == null ? [] : payable.filter((row) => Number(row.warehouse_id) === Number(scopeWarehouseId));
  return own.length > 0 ? own : payable.filter((row) => row.warehouse_id == null);
}

/** Providers a buyer may choose for this warehouse, in display order, each once. */
async function getPublicPaymentProviders(db, warehouseId) {
  const accounts = await getPublicPaymentAccounts(db, warehouseId);
  return [...new Set(accounts.map((account) => account.provider))];
}

/**
 * The account for the provider the buyer chose, from `accounts` (getPublicPaymentAccounts for the order's
 * payment warehouse). A provider that warehouse does not take is refused, never sent to another account.
 */
function selectPublicPaymentAccount(accounts, provider) {
  const normalized = String(provider || '').toUpperCase();
  if (!PUBLIC_PAYMENT_PROVIDERS.includes(normalized)) throw ApiError.badRequest('Unsupported payment provider');
  if (accounts.length === 0) throw ApiError.serviceUnavailable('No active payment account is configured for this delivery area');
  const selected = accounts.find((account) => account.provider === normalized);
  if (!selected) {
    throw ApiError.badRequest(`${normalized} is not available for this delivery address. Please choose another payment option.`);
  }
  return selected;
}

// E-wallet accounts are personal (a named person's GCash), so buyers see a masked name; bank accounts
// for the store are company names and stay readable.
const PERSONAL_NAME_PROVIDERS = Object.freeze(['GCASH']);

/**
 * "HAROLD TUGANO" -> "HA***D T.": enough for a buyer to confirm they are sending to the right person in
 * the app, without publishing the account holder's full name (management request, 2026-10-05).
 */
function maskPersonName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = words[0];
  const maskedFirst = first.length <= 3 ? `${first[0]}***` : `${first.slice(0, 2)}***${first.slice(-1)}`;
  return words.length > 1 ? `${maskedFirst} ${words[words.length - 1][0]}.` : maskedFirst;
}

/** The account as shown to a public buyer: number in full (they must type it), name masked for e-wallets. */
function toBuyerFacingAccount(bank) {
  if (!bank) return null;
  const masked = PERSONAL_NAME_PROVIDERS.includes(normalizeProvider(bank.bank_name));
  return {
    bank_name: bank.bank_name,
    account_name: masked ? maskPersonName(bank.account_name) : bank.account_name,
    account_number: bank.account_number,
  };
}

/**
 * The account an order must be paid into: the one the buyer chose at checkout (orders.payment_account_id),
 * else the source warehouse's account, else the company default. Staff screens and the tracking page use
 * this so they never show a different account from the one the buyer was told to pay.
 */
async function resolveOrderPaymentAccount(db, { paymentAccountId, sourceWarehouseId }) {
  if (paymentAccountId) {
    const [rows] = await db.execute(
      `SELECT id, warehouse_id, bank_name, account_name, account_number
       FROM bank_accounts WHERE id = ? AND is_deleted = 0 LIMIT 1`,
      [paymentAccountId]
    );
    if (rows.length > 0) return toPublicBankAccount(rows[0]);
  }
  return getBankAccountForWarehouseOrDefault(db, sourceWarehouseId || null);
}

module.exports = {
  executeSoftDeleteAware,
  getBankAccountForWarehouseOrDefault,
  resolveOrderPaymentAccount,
  toBuyerFacingAccount,
  maskPersonName,
  assertBankAccountAvailable,
  PUBLIC_PAYMENT_PROVIDERS,
  normalizeProvider,
  getPublicPaymentAccounts,
  getPublicPaymentProviders,
  selectPublicPaymentAccount,
};
