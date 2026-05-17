const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const { ROLES, canonicalRole } = require('../rbac/roles');

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

function scopedOrderClause(user, alias = 'o') {
  if (canonicalRole(user?.role_slug) === ROLES.SUPER_ADMIN) {
    return { clause: '', params: [] };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return { clause: ` AND ${alias}.partner_id = ?`, params: [user.partner_id] };
}

let bankAccountsHasIsDeletedCache = null;
async function bankAccountsHasIsDeletedColumn() {
  if (bankAccountsHasIsDeletedCache !== null) {
    return bankAccountsHasIsDeletedCache;
  }

  const [rows] = await pool.execute("SHOW COLUMNS FROM bank_accounts LIKE 'is_deleted'");
  bankAccountsHasIsDeletedCache = rows.length > 0;
  return bankAccountsHasIsDeletedCache;
}

// GET /api/v1/bank-accounts
const getBankAccounts = asyncHandler(async (req, res) => {
  const { page, limit, warehouse_id } = req.query;
  const includeSoftDelete = await bankAccountsHasIsDeletedColumn();
  const buildQueries = () => {
    const params = [];
    let where = 'WHERE 1=1';

    if (includeSoftDelete) {
      where += ' AND ba.is_deleted = 0';
    }
    if (warehouse_id) {
      where += ' AND ba.warehouse_id = ?';
      params.push(warehouse_id);
    }

    return {
      baseQuery: `
        SELECT ba.*, w.name AS warehouse_name
        FROM bank_accounts ba
        LEFT JOIN warehouses w ON w.id = ba.warehouse_id
        ${where} ORDER BY ba.created_at DESC`,
      countQuery: `SELECT COUNT(*) AS total FROM bank_accounts ba LEFT JOIN warehouses w ON w.id = ba.warehouse_id ${where}`,
      params,
    };
  };

  const q = buildQueries();
  const result = await paginate(q.baseQuery, q.countQuery, q.params, page, limit);

  res.json({ success: true, ...result });
});

// POST /api/v1/bank-accounts
const createBankAccount = asyncHandler(async (req, res) => {
  const { warehouse_id, bank_name, account_name, account_number, is_default } = req.body;
  if (!bank_name || !account_name || !account_number) {
    throw ApiError.badRequest('bank_name, account_name, and account_number are required');
  }

  const [result] = await pool.execute(
    `INSERT INTO bank_accounts (warehouse_id, bank_name, account_name, account_number, is_default)
     VALUES (?, ?, ?, ?, ?)`,
    [warehouse_id || null, bank_name, account_name, account_number, is_default ? 1 : 0]
  );
  res.status(201).json({ success: true, message: 'Bank account created', data: { id: result.insertId } });
});

// PUT /api/v1/bank-accounts/:id
const updateBankAccount = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { bank_name, account_name, account_number, is_active, is_default } = req.body;

  const hasSoftDelete = await bankAccountsHasIsDeletedColumn();
  let existing;
  if (hasSoftDelete) {
    [existing] = await pool.execute('SELECT id FROM bank_accounts WHERE id = ? AND is_deleted = 0', [id]);
  } else {
    [existing] = await pool.execute('SELECT id FROM bank_accounts WHERE id = ?', [id]);
  }
  if (existing.length === 0) {
    throw ApiError.notFound('Bank account not found');
  }

  await pool.execute(
    `UPDATE bank_accounts SET bank_name = COALESCE(?, bank_name), account_name = COALESCE(?, account_name),
     account_number = COALESCE(?, account_number), is_active = COALESCE(?, is_active),
     is_default = COALESCE(?, is_default) WHERE id = ?`,
    [bank_name, account_name, account_number, is_active !== undefined ? is_active : null, is_default !== undefined ? is_default : null, id]
  );
  res.json({ success: true, message: 'Bank account updated' });
});

// DELETE /api/v1/bank-accounts/:id
const deleteBankAccount = asyncHandler(async (req, res) => {
  const hasSoftDelete = await bankAccountsHasIsDeletedColumn();
  let existing;
  if (hasSoftDelete) {
    [existing] = await pool.execute('SELECT id FROM bank_accounts WHERE id = ? AND is_deleted = 0', [req.params.id]);
  } else {
    [existing] = await pool.execute('SELECT id FROM bank_accounts WHERE id = ?', [req.params.id]);
  }

  if (existing.length === 0) throw ApiError.notFound('Bank account not found');

  if (hasSoftDelete) {
    await pool.execute('UPDATE bank_accounts SET is_deleted = 1 WHERE id = ?', [req.params.id]);
  } else {
    await pool.execute('UPDATE bank_accounts SET is_active = 0 WHERE id = ?', [req.params.id]);
  }

  res.json({ success: true, message: 'Bank account deleted' });
});

// GET /api/v1/bank-accounts/for-order/:orderId — get bank account for an order's source warehouse
const getBankAccountForOrder = asyncHandler(async (req, res) => {
  let warehouseId = null;
  const scope = scopedOrderClause(req.user);

  try {
    const [orders] = await pool.execute(
      `SELECT o.source_warehouse_id
       FROM orders o
       WHERE o.id = ? AND o.is_deleted = 0${scope.clause}
       LIMIT 1`,
      [req.params.orderId, ...scope.params]
    );
    if (orders.length === 0) throw ApiError.notFound('Order not found');
    warehouseId = orders[0].source_warehouse_id || null;
  } catch (err) {
    // Backward compatibility for DBs not yet migrated with source_warehouse_id.
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      const [orders] = await pool.execute(
        `SELECT o.id
         FROM orders o
         WHERE o.id = ? AND o.is_deleted = 0${scope.clause}
         LIMIT 1`,
        [req.params.orderId, ...scope.params]
      );
      if (orders.length === 0) throw ApiError.notFound('Order not found');
      warehouseId = null;
    } else {
      throw err;
    }
  }

  let bank = null;

  if (warehouseId) {
    const [banks] = await executeSoftDeleteAware(
      pool,
      `SELECT bank_name, account_name, account_number FROM bank_accounts
       WHERE warehouse_id = ? AND is_active = 1 AND is_deleted = 0 ORDER BY is_default DESC LIMIT 1`,
      [warehouseId],
      `SELECT bank_name, account_name, account_number FROM bank_accounts
       WHERE warehouse_id = ? AND is_active = 1 ORDER BY is_default DESC LIMIT 1`
    );
    if (banks.length > 0) bank = banks[0];
  }

  // Fallback: company default account
  if (!bank) {
    const [defaults] = await executeSoftDeleteAware(
      pool,
      `SELECT bank_name, account_name, account_number FROM bank_accounts
       WHERE is_default = 1 AND is_active = 1 AND is_deleted = 0 LIMIT 1`,
      [],
      `SELECT bank_name, account_name, account_number FROM bank_accounts
       WHERE is_default = 1 AND is_active = 1 LIMIT 1`
    );
    if (defaults.length > 0) bank = defaults[0];
  }

  res.json({ success: true, data: bank });
});

module.exports = { getBankAccounts, createBankAccount, updateBankAccount, deleteBankAccount, getBankAccountForOrder };
